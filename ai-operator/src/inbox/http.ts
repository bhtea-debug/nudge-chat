import { z } from "zod";
import type { ContentMode } from "./contract.js";
import {
  channelFreshness,
  reconcileOverdueMsFor,
  recordFailure,
  recordInboundReceipt,
} from "./health.js";
import { queryCase, queryMessages, queryQueue } from "./query.js";
import type { InboxRuntime } from "./runtime.js";
import {
  cancelPrepared,
  expirePreparedAttempts,
  prepareAttempt,
  resolveUncertain,
} from "./outbound/ledger.js";
import {
  outgoingHistoryComplete,
  restoreOutgoingMessage,
} from "./outbound/record.js";
import { metaTransport, resendTransport, sendReply, type SendOutcome } from "./outbound/send.js";
import { ingestMetaEvents } from "./providers/meta/ingest.js";
import {
  MetaWebhookPayload,
  metaVerificationChallenge,
  normalizeMetaPayload,
  verifyMetaSignature,
} from "./providers/meta/webhook.js";
import { applyDeliveryEvent } from "./outbound/ledger.js";
import { accountMatchesCase, resolveRecipient } from "./outbound/recipient.js";
import { resendDeliveryState, verifyResendWebhook } from "./outbound/webhooks.js";

/**
 * Kontrakt HTTP kanału obsługi klienta.
 *
 * Świadomie NIE są to narzędzia MCP. Rejestr narzędzi jest tym, co widzi model,
 * a wysyłka do klienta nie ma prawa się tam znaleźć — nawet omyłkowo, nawet
 * jako narzędzie „tylko do przygotowania". Odczyt też jest osobno, bo czat
 * potrzebuje pełnych danych sprawy, a model wariantu zredagowanego.
 */

export const INBOX_READ_PREFIX = "/internal/inbox";
export const INBOX_REPLY_PATH = "/internal/inbox/reply";
/**
 * Jak długo czekamy na wysyłkę pasującą do zdarzenia doręczenia.
 *
 * Tyle, ile wynosi tolerancja podpisu Resenda: po tym czasie ponowienia i tak
 * dostają 401, więc dłuższe odpychanie zdarzenia niczego już nie ratuje.
 */
const RESEND_RETRY_WINDOW_MS = 5 * 60_000;

/** Czas zdarzenia z ładunku; brak albo śmieć znaczy „teraz”. */
function resendEventTime(payload: { created_at?: unknown }, fallback: number): number {
  const raw = payload.created_at;
  if (typeof raw !== "string") return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const META_WEBHOOK_PATH = "/webhook/meta";
export const RESEND_WEBHOOK_PATH = "/webhook/resend";

export const INBOX_REPLY_CONFIRMATION = "SEND_CUSTOMER_REPLY";
export const INBOX_REPLY_CANCEL_CONFIRMATION = "CANCEL_CUSTOMER_REPLY";
export const INBOX_REPLY_CHECK_CONFIRMATION = "CHECK_CUSTOMER_REPLY";
export const INBOX_REPLY_RESOLVE_SENT = "CONFIRM_CUSTOMER_REPLY_WAS_SENT";
export const INBOX_REPLY_RESOLVE_NOT_SENT = "CONFIRM_CUSTOMER_REPLY_WAS_NOT_SENT";
export const HUMAN_CONFIRMATION_HEADER = "x-bht-human-confirmation";
export const HUMAN_CONFIRMATION_VALUE = "confirmed";

const RequestId = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const ReplyBase = {
  requestId: RequestId,
  caseId: z.string().min(1).max(128),
  expectedLastIncomingMessageId: z.string().max(512).nullable(),
};

/**
 * Ładunek wysyłki. `.strict()` odrzuca każde nieznane pole, w tym `attachments`:
 * brak załączników jest częścią kontraktu, a nie zwyczajem interfejsu.
 */
export const InboxReplyRequest = z.discriminatedUnion("operation", [
  z
    .object({
      ...ReplyBase,
      operation: z.literal("send"),
      confirmation: z.literal(INBOX_REPLY_CONFIRMATION),
      text: z
        .string()
        .min(1)
        .max(4_000)
        .refine((value) => value === value.trim() && !value.includes("\u0000")),
      /*
       * `recipient` NIE jest polem żądania i `.strict()` odrzuca próbę jego
       * podania. Odbiorca jest funkcją `caseId` i wynika z trwałej wiadomości,
       * bo inaczej jedno spreparowane żądanie wysyłałoby treść przygotowaną
       * dla klienta pod dowolny adres, z naszej zweryfikowanej domeny.
       */
    })
    .strict(),
  z
    .object({
      ...ReplyBase,
      operation: z.literal("cancel"),
      confirmation: z.literal(INBOX_REPLY_CANCEL_CONFIRMATION),
    })
    .strict(),
  /**
   * Sprawdzenie wyniku bez wysyłki, z naprawą WŁASNEJ historii.
   *
   * ZERO żądań do dostawcy i zero zmian statusu próby: wynik u klienta jest
   * taki, jaki jest, i kontrola nie ma prawa go dotknąć. Jedyny zapis, na jaki
   * sobie pozwala, dotyczy naszej strony: jeżeli ledger mówi „wysłano", a w
   * wątku brakuje odpowiedzi z TEJ próby (awaria między potwierdzeniem a
   * zapisem historii), wpis zostaje odtworzony. Bez tego jedyna droga do
   * naprawy prowadziła przez ponowienie wysyłki, czyli przez ryzyko drugiej
   * wiadomości u klienta.
   *
   * Naprawa jest idempotentna: druga kontrola niczego nie dubluje.
   */
  z
    .object({
      ...ReplyBase,
      operation: z.literal("check"),
      confirmation: z.literal(INBOX_REPLY_CHECK_CONFIRMATION),
    })
    .strict(),
  z
    .object({
      ...ReplyBase,
      operation: z.literal("resolve_sent"),
      confirmation: z.literal(INBOX_REPLY_RESOLVE_SENT),
    })
    .strict(),
  z
    .object({
      ...ReplyBase,
      operation: z.literal("resolve_not_sent"),
      confirmation: z.literal(INBOX_REPLY_RESOLVE_NOT_SENT),
    })
    .strict(),
]);
export type InboxReplyRequest = z.infer<typeof InboxReplyRequest>;

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  /** Odpowiedź tekstowa (challenge Meta), zamiast JSON. */
  readonly text?: string;
}

function envelope(data: unknown, now: number): HttpResult {
  return { status: 200, body: { ok: true, ts: now, contractVersion: "v1", data } };
}

function failure(status: number, error: string): HttpResult {
  return { status, body: { ok: false, error } };
}

// ── odczyt ───────────────────────────────────────────────────────────────────

export interface ReadRequest {
  readonly runtime: InboxRuntime;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly now: number;
  /** Zaufany principal firmowego czatu widzi `display`; inni najwyżej `model`. */
  readonly trustedChat: boolean;
}

/**
 * Zdrowie i kompletność kanału policzone z RZECZYWISTEJ kadencji.
 *
 * Próg „uzgodnienie zaległo" wynika z `tickIntervalMs`, a nie ze stałej
 * domyślnej: warstwa HTTP jest najniższym miejscem, które widzi konfigurację,
 * więc to ona podaje próg. Instancja odpytująca co minutę zalega po
 * osiemnastu minutach ciszy, a nie po dziewięćdziesięciu.
 */
function channelHealthOf(runtime: InboxRuntime, now: number) {
  return channelFreshness(runtime.store, now, {
    reconcileOverdueMs: reconcileOverdueMsFor(runtime.config.tickIntervalMs),
  });
}

export function handleInboxRead(request: ReadRequest): HttpResult {
  const { runtime, params, now } = request;
  const mode = contentModeOf(params.get("contentMode"), request.trustedChat);

  switch (request.path) {
    case `${INBOX_READ_PREFIX}/health`:
      return envelope(channelHealthOf(runtime, now), now);

    case `${INBOX_READ_PREFIX}/cases`: {
      const providers = splitList(params.get("providers"));
      const accountKeys = splitList(params.get("accounts"));
      const limit = Number(params.get("limit") ?? "200");
      const result = queryQueue(runtime.store, {
        now,
        state: params.get("state") === "all" ? "all" : "actionable",
        providers: providers.length ? providers : undefined,
        accountKeys: accountKeys.length ? accountKeys : undefined,
        limit: Number.isFinite(limit) ? limit : 200,
        contentMode: mode,
        cursor: params.get("cursor"),
        // Podgląd konta nadawczego pochodzi z konfiguracji adaptera,
        // nie z żądania: interfejs ma pokazać to, co faktycznie wyśle.
        mailboxes: new Map(runtime.config.email.map((entry) => [entry.accountKey, entry.address])),
      });
      /*
       * Kompletność widoku ma DWA niezależne warunki i oba muszą być spełnione:
       * kompletne źródła (zdrowie kanału) i spójne przewijanie (`snapshotChanged`).
       * Warstwa zapytań nie zna kadencji, więc liczy zdrowie z progu domyślnego;
       * tutaj podmieniamy je na policzone z konfiguracji, zamiast zostawiać
       * w jednej odpowiedzi dwie różne odpowiedzi na to samo pytanie.
       */
      const health = channelHealthOf(runtime, now);
      return envelope(
        {
          ...result,
          freshness: health,
          completeView: health.completeView && !result.snapshotChanged,
        },
        now,
      );
    }

    case `${INBOX_READ_PREFIX}/case`: {
      const caseId = params.get("id");
      if (!caseId) return failure(400, "missing_id");
      // Odczyt PO KLUCZU. Wcześniej ta gałąź budowała stronę pięciuset spraw
      // i szukała w niej jednej — czyli sprawa poza tą stroną nie dawała się
      // otworzyć, choć była w magazynie.
      const found = queryCase(
        runtime.store,
        caseId,
        now,
        mode,
        new Map(runtime.config.email.map((entry) => [entry.accountKey, entry.address])),
      );
      if (!found) return failure(404, "case_not_found");
      // Ten sam obiekt zdrowia, co w kolejce i w `/health`. Sprawa otwarta
      // obok kolejki nie może mówić o kanale czegoś innego niż lista.
      return envelope({ ...found, freshness: channelHealthOf(runtime, now) }, now);
    }

    case `${INBOX_READ_PREFIX}/messages`: {
      const caseId = params.get("id");
      if (!caseId) return failure(400, "missing_id");
      if (mode === "none") return failure(400, "content_mode_required");
      if (!runtime.store.getCase(caseId)) return failure(404, "case_not_found");
      return envelope(queryMessages(runtime.store, caseId, mode), now);
    }

    default:
      return failure(404, "unknown_inbox_route");
  }
}

function contentModeOf(raw: string | null, trustedChat: boolean): ContentMode {
  if (raw === "display") {
    // Niezredagowany widok jest zastrzeżony dla firmowego czatu. Model nigdy
    // nie może go wybrać sam, bo wtedy redakcja byłaby tylko sugestią.
    return trustedChat ? "display" : "model";
  }
  if (raw === "model") return "model";
  return "none";
}

function splitList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ── wysyłka ──────────────────────────────────────────────────────────────────

export interface ReplyRequestContext {
  readonly runtime: InboxRuntime;
  readonly body: unknown;
  readonly humanConfirmation: string | null | undefined;
  readonly now: number;
  readonly fetchImpl?: typeof fetch;
}

export async function handleInboxReply(context: ReplyRequestContext): Promise<HttpResult> {
  if (context.humanConfirmation !== HUMAN_CONFIRMATION_VALUE) {
    return failure(428, "human_confirmation_required");
  }

  const parsed = InboxReplyRequest.safeParse(context.body);
  if (!parsed.success) {
    // Bez szczegółów walidacji: mogą zawierać fragment treści klienta.
    return failure(422, "invalid_reply_request");
  }
  const request = parsed.data;
  const { runtime, now } = context;
  const record = runtime.store.getCase(request.caseId);
  if (!record) return failure(404, "case_not_found");

  if (request.operation === "check") {
    const attempt = runtime.store.getAttempt(request.requestId);
    if (!attempt) {
      /*
       * Brak ledgera znaczy, że POST nigdy się nie zaczął: wpis `prepared`
       * powstaje PRZED pierwszym żądaniem do dostawcy, więc bez niego nic nie
       * poleciało. To jest informacja, nie błąd, i wolno po niej odblokować
       * formularz.
       */
      return envelope(
        {
          status: "not_found",
          requestId: request.requestId,
          ...settlementOf("not_found"),
          historyComplete: true,
          repairedHistory: false,
          restoredMessage: false,
          reprojectedCase: false,
          historyMessageId: null,
          historyBlockedBy: null,
          message: "Nie ma śladu tej próby",
        },
        now,
      );
    }
    if (attempt.caseId !== request.caseId) return failure(409, "request_belongs_to_other_case");

    /*
     * Kontrola NAPRAWIA historię, zamiast tylko o niej opowiadać.
     *
     * Ledger i wątek zapisują się osobno, więc awaria między `finishSent`
     * a zapisem wiadomości zostawia stan, w którym odpowiedź poszła do
     * klienta, a sprawa dalej wygląda na bez odpowiedzi i kolejna osoba pisze
     * drugi raz. Odtworzenie wpisu nie wykonuje ANI JEDNEGO żądania do
     * dostawcy: wiadomość u klienta już jest, brakuje wyłącznie naszej
     * historii. Przy próbie innej niż `sent` naprawa jest zablokowana, bo
     * dopisanie odpowiedzi do wątku udawałoby wiedzę, której nie mamy.
     */
    const repair = restoreOutgoingMessage(runtime.store, attempt, now);

    return envelope(
      {
        status: attempt.status,
        requestId: attempt.requestId,
        externalMessageId: attempt.externalMessageId,
        deliveryState: attempt.deliveryState,
        postStartedAt: attempt.postStartedAt,
        completedAt: attempt.completedAt,
        code: attempt.failureCode,
        contentSha256: attempt.contentSha256,
        contentLength: attempt.contentLength,
        ...settlementOf(attempt.status),
        /*
         * Kompletność liczona PO naprawie i wyłącznie dla TEJ próby.
         * Poprzednia wersja pytała, czy w sprawie jest jakakolwiek wiadomość
         * wychodząca, więc starsza odpowiedź w wątku dawała fałszywe
         * „historia kompletna" i brakujący wpis nie powstawał już nigdy.
         */
        historyComplete: outgoingHistoryComplete(runtime.store, attempt),
        /** true = kontrola coś uzupełniła TERAZ. Druga kontrola daje false. */
        repairedHistory: repair.restoredMessage || repair.reprojectedCase,
        restoredMessage: repair.restoredMessage,
        reprojectedCase: repair.reprojectedCase,
        historyMessageId: repair.messageId,
        /** Niepuste = naprawa była potrzebna i się NIE udała. */
        historyBlockedBy: repair.blockedBy,
        message: describeAttempt(attempt.status),
      },
      now,
    );
  }

  if (request.operation === "cancel") {
    const result = cancelPrepared(runtime.store, request.requestId, now);
    return result.ok
      ? envelope({ status: "cancelled", requestId: request.requestId }, now)
      : failure(409, result.code ?? "cannot_cancel");
  }

  if (request.operation === "resolve_sent" || request.operation === "resolve_not_sent") {
    const outcome = request.operation === "resolve_sent" ? "sent" : "not_sent";
    /*
     * Ledger rozstrzyga IDEMPOTENTNIE: powtorzenie z tym samym wynikiem jest
     * sukcesem bez zapisu (`changed: false`), a wynik SPRZECZNY odbija sie
     * kodem `conflicting_resolution:<status>`. Dlatego 409 zostaje tu tylko
     * dla realnego konfliktu i dla stanow nierozstrzygalnych — powtorzone
     * klikniecie czlowieka, ktory nie zobaczyl pierwszej odpowiedzi, dostaje
     * 200, zamiast uczyc go, ze przycisk „nie dziala".
     */
    const result = resolveUncertain(runtime.store, request.requestId, outcome, now);
    if (!result.ok) return failure(409, result.code ?? "cannot_resolve");

    /*
     * Rozstrzygniecie „dostarczona" musi TAKZE naprawic historie.
     *
     * Sam ledger wie, ze odpowiedz poszla, ale watek jej nie pokazuje, wiec
     * sprawa dalej wyglada na bez odpowiedzi: kolejny czlowiek widzi klienta
     * czekajacego i pisze drugi raz. Odtworzony wpis mowi wprost, ze tresc
     * trzeba sprawdzic u dostawcy, bo ledger trzyma tylko skrot i dlugosc.
     * Naprawa jest idempotentna i NIE wysyla niczego ponownie.
     *
     * Probe czytamy PO rozstrzygnieciu, wiec dziala tak samo dla stanu
     * `uncertain`, jak dla utrwalonego `sending`.
     */
    const attempt = runtime.store.getAttempt(request.requestId);
    /*
     * TA SAMA naprawa co przy `check`.
     *
     * Wczesniej ta sciezka uzywala starszej wersji zwracajacej samo `true/false`,
     * wiec przy nieudanej naprawie odpowiedz mowila `repairedHistory: false`
     * i nic wiecej: nie dalo sie odroznic „nie bylo czego naprawiac" od „nie
     * dalo sie naprawic". Sciezka `check` dostala bogatszy wynik wlasnie z tego
     * powodu; zostawienie tu starej bylo dziura w tym samym miejscu.
     */
    const repair = attempt
      ? restoreOutgoingMessage(runtime.store, attempt, now)
      : null;

    return envelope(
      {
        // Stan FAKTYCZNY z ledgera, nie wywnioskowany z zadania: zgodne
        // ponowienie nad proba anulowana ma pokazac `cancelled`, a nie
        // `failed`, bo to dwie rozne historie tej samej sprawy.
        status: attempt?.status ?? (outcome === "sent" ? "sent" : "failed"),
        requestId: request.requestId,
        manuallyResolved: true,
        /** false = ten sam wynik byl juz zapisany; powtorka nie jest bledem. */
        changed: result.changed,
        repairedHistory: repair?.restoredMessage ?? false,
        reprojectedCase: repair?.reprojectedCase ?? false,
        historyPresent: repair?.present ?? false,
        historyBlockedBy: repair?.blockedBy ?? null,
      },
      now,
    );
  }

  /*
   * Sprzatanie porzuconych `prepared` PRZED wysylka.
   *
   * `prepared` powstaje przed pierwszym requestem i blokuje kazda kolejna
   * probe w sprawie. Gdy proces padl w tym oknie, blokady nie zdejmie nikt:
   * anulowanie jest ruchem czlowieka, a ten nigdy nie zobaczyl potwierdzenia,
   * wiec nie wie, ze jest co anulowac — i sprawa wisi bez konca. Zegar wolno
   * tu zastosowac WYLACZNIE dlatego, ze przy `prepared` do dostawcy nic nie
   * polecialo; `sending` i `uncertain` ledger zostawia nietkniete.
   */
  expirePreparedAttempts(runtime.store, now);

  const transport = buildTransport(context, request);
  if (!transport.ok) return failure(transport.status, transport.error);

  const outcome = await sendReply({
    store: runtime.store,
    requestId: request.requestId,
    caseId: request.caseId,
    text: request.text,
    expectedLastIncomingMessageId: request.expectedLastIncomingMessageId,
    transport: transport.transport,
    now: () => context.now,
  });

  return envelope(toReplyDto(outcome), now);
}

/**
 * Jednoznaczny, TERMINALNY stan próby dla odbiorcy odpowiedzi.
 *
 * Interfejs musi wiedzieć nie „jak się nazywa status", tylko czy wolno
 * odblokować formularz. Trzy pytania są rozłączne i każde ma własne pole,
 * bo sklejone w jedno dawały decyzję na wyczucie:
 *  - `terminal`: los próby jest przesądzony i sam się już nie zmieni,
 *  - `mayRetry`: wiadomo, że do klienta NIC nie poszło, więc wolno pisać od nowa,
 *  - `needsHumanDecision`: request mógł polecieć i tylko człowiek to sprawdzi.
 *
 * `sent` jest terminalne, ale `mayRetry` zostaje na `false`: powtórzenie tej
 * samej treści to druga wiadomość u klienta, a nie naprawa.
 */
function settlementOf(status: string): {
  terminal: boolean;
  outcome: "sent" | "not_sent" | "unknown";
  mayRetry: boolean;
  needsHumanDecision: boolean;
} {
  switch (status) {
    case "sent":
      return { terminal: true, outcome: "sent", mayRetry: false, needsHumanDecision: false };
    case "failed":
    case "cancelled":
    // Brak śladu próby: `prepared` powstaje przed pierwszym żądaniem, więc
    // jego brak dowodzi, że do dostawcy nic nie poszło.
    case "not_found":
      return { terminal: true, outcome: "not_sent", mayRetry: true, needsHumanDecision: false };
    case "sending":
    case "uncertain":
      // Request MÓGŁ dojść. Odblokowanie formularza tutaj kosztuje drugą
      // wiadomość u klienta, więc droga wyjścia jest jedna: `resolve_*`.
      return { terminal: false, outcome: "unknown", mayRetry: false, needsHumanDecision: true };
    case "prepared":
      // Nic nie poleciało, ale próba dalej blokuje sprawę. Właściwym ruchem
      // jest anulowanie, a nie ponowienie ani orzekanie o losie wysyłki.
      return { terminal: false, outcome: "not_sent", mayRetry: false, needsHumanDecision: false };
    default:
      return { terminal: false, outcome: "unknown", mayRetry: false, needsHumanDecision: true };
  }
}

function describeAttempt(status: string): string {
  switch (status) {
    case "prepared":
      return "Odpowiedź czeka na potwierdzenie";
    case "sending":
      return "Wysyłka w toku — nie ponawiaj bez sprawdzenia";
    case "sent":
      return "Wiadomość została wysłana";
    case "failed":
      return "Wiadomość nie została wysłana";
    case "uncertain":
      return "Wynik wysyłki jest nieznany — sprawdź u dostawcy przed kolejną próbą";
    case "cancelled":
      return "Próba została anulowana";
    default:
      return "Nieznany stan próby";
  }
}

function toReplyDto(outcome: SendOutcome): Record<string, unknown> {
  return {
    status: outcome.status === "rejected" ? "failed" : outcome.status,
    rejected: outcome.status === "rejected",
    requestId: outcome.requestId,
    externalMessageId: outcome.status === "sent" ? outcome.externalMessageId : null,
    code: "code" in outcome ? outcome.code : null,
    message: "message" in outcome ? outcome.message : "Wiadomosc zostala wyslana",
    /*
     * Stan HISTORII przechodzi az do odbiorcy.
     *
     * Bez tego pole zylo wylacznie wewnatrz adaptera: czat dostawal „wyslano"
     * i nie mial jak odroznic wysylki z kompletnym watkiem od takiej, ktorej
     * wpisu nie udalo sie odtworzyc. Komentarz przy polu obiecywal to
     * rozroznienie, a granica HTTP je zjadala.
     */
    historyComplete: "historyComplete" in outcome ? outcome.historyComplete : null,
    /*
     * Jedyny dopuszczalny dowod „nie wyslano".
     *
     * Odbiorca nie ma prawa wnioskowac tego z kodu HTTP: brama albo proxy
     * potrafi zwrocic 4xx po tym, jak zadanie juz poszlo dalej. Bez tego pola
     * czat zamienial 408, 425 i 429 w terminalne `failed` i odblokowywal
     * formularz po faktycznie wykonanym POST-cie.
     */
    settledNotSent: "settledNotSent" in outcome ? outcome.settledNotSent : false,
  };
}

type TransportResolution =
  | { readonly ok: true; readonly transport: Parameters<typeof sendReply>[0]["transport"] }
  | { readonly ok: false; readonly status: number; readonly error: string };

function buildTransport(
  context: ReplyRequestContext,
  request: Extract<InboxReplyRequest, { operation: "send" }>,
): TransportResolution {
  const { runtime } = context;
  const record = runtime.store.getCase(request.caseId)!;

  // Odbiorca, dostawca i konto wynikają ze sprawy, nie z żądania.
  const resolved = resolveRecipient(runtime.store, record);
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.code === "provider_uses_dedicated_bridge" ? 409 : 422,
      error: resolved.code,
    };
  }

  if (record.provider === "email") {
    const mailbox = runtime.config.email.find((entry) => entry.accountKey === record.accountKey);
    const apiKey = runtime.config.outbound.resendApiKey;
    // Fail-closed: bez klucza i bez zweryfikowanej skrzynki nie próbujemy.
    // Odpowiedź z cudzego adresu jest gorsza od braku odpowiedzi.
    if (!mailbox || !apiKey) return { ok: false, status: 503, error: "email_outbound_not_configured" };
    // Konto nadawcze musi należeć do źródła sprawy: odpowiedź na wiadomość
    // wysłaną do `hurt@` nie ma prawa wyjść z `sklep@`.
    if (!accountMatchesCase(record, mailbox)) {
      return { ok: false, status: 409, error: "account_does_not_match_case" };
    }
    return {
      ok: true,
      transport: resendTransport({
        apiKey,
        mailbox: { accountKey: mailbox.accountKey, fromAddress: mailbox.address, fromName: mailbox.label },
        to: resolved.recipient,
        subject: record.subject,
        text: request.text,
        inReplyTo: resolved.inReplyTo,
        fetchImpl: context.fetchImpl,
      }),
    };
  }

  if (record.provider === "instagram" || record.provider === "facebook") {
    const account = runtime.config.meta.find((entry) => entry.accountKey === record.accountKey);
    if (!account) return { ok: false, status: 503, error: "meta_outbound_not_configured" };
    if (!accountMatchesCase(record, account)) {
      return { ok: false, status: 409, error: "account_does_not_match_case" };
    }
    return {
      ok: true,
      transport: metaTransport({
        account: {
          provider: account.provider,
          accountKey: account.accountKey,
          pageId: account.pageId,
          accessToken: account.accessToken,
        },
        recipientId: resolved.recipient,
        text: request.text,
        lastIncomingAt: record.lastIncomingAt,
        now: context.now,
        fetchImpl: context.fetchImpl,
      }),
    };
  }

  // Allegro ma własną, przetestowaną bramę w TeaBrew i nie przechodzi tędy.
  return { ok: false, status: 409, error: "provider_uses_dedicated_bridge" };
}

/** Przygotowanie odpowiedzi bez wysyłki: wiąże treść, sprawę i marker. */
export function handleInboxPrepare(context: {
  readonly runtime: InboxRuntime;
  readonly requestId: string;
  readonly caseId: string;
  readonly text: string;
  readonly expectedLastIncomingMessageId: string | null;
  readonly now: number;
}): HttpResult {
  const result = prepareAttempt({
    store: context.runtime.store,
    requestId: context.requestId,
    caseId: context.caseId,
    text: context.text,
    expectedLastIncomingMessageId: context.expectedLastIncomingMessageId,
    now: context.now,
  });
  if (!result.ok) return failure(409, result.code);
  return envelope(
    {
      requestId: result.attempt.requestId,
      status: result.attempt.status,
      contentSha256: result.attempt.contentSha256,
      contentLength: result.attempt.contentLength,
    },
    context.now,
  );
}

// ── webhooki ─────────────────────────────────────────────────────────────────

export interface MetaWebhookContext {
  readonly runtime: InboxRuntime;
  readonly method: string;
  readonly params: URLSearchParams;
  readonly rawBody: string;
  readonly signatureHeader: string | null | undefined;
  readonly now: number;
}

export function handleMetaWebhook(context: MetaWebhookContext): HttpResult {
  const { runtime } = context;
  const appSecret = runtime.config.outbound.metaAppSecret;
  const verifyToken = runtime.config.outbound.metaVerifyToken;

  if (context.method === "GET") {
    if (!verifyToken) return failure(503, "meta_webhook_not_configured");
    const challenge = metaVerificationChallenge({
      mode: context.params.get("hub.mode"),
      token: context.params.get("hub.verify_token"),
      challenge: context.params.get("hub.challenge"),
      expectedToken: verifyToken,
    });
    if (challenge === null) return failure(403, "verification_failed");
    return { status: 200, body: null, text: challenge };
  }

  if (context.method !== "POST") return failure(405, "use_post");
  if (!appSecret) return failure(503, "meta_webhook_not_configured");

  // Podpis PRZED zapisem. Bez tego dowolny host w internecie wstawia sprawy
  // do kolejki obsługi klienta.
  if (!verifyMetaSignature({ rawBody: context.rawBody, header: context.signatureHeader, appSecret })) {
    return failure(401, "invalid_signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(context.rawBody);
  } catch {
    return failure(400, "invalid_json");
  }
  const parsed = MetaWebhookPayload.safeParse(payload);
  if (!parsed.success) {
    // 200, nie 4xx: Meta traktuje kod błędu jako sygnał do ponowienia, a
    // ładunku, którego nie rozumiemy, nie zrozumiemy też za piątym razem.
    return envelope({ accepted: false, reason: "unsupported_payload" }, context.now);
  }

  const events = normalizeMetaPayload(parsed.data, runtime.config.meta, context.now);
  /*
   * `durable: true` — zapis na dysk PRZED odpowiedzią 200.
   *
   * Po 200 Meta uznaje wiadomość za doręczoną i jej nie ponowi. Bez wymuszenia
   * utrata zasilania w oknie między zapisem a odpowiedzią kasuje wiadomość
   * bez śladu — a to jest dokładnie ta cicha utrata, której zabrania kontrakt.
   */
  const result = ingestMetaEvents(runtime.store, events, { durable: true });

  for (const mid of result.deliveries) {
    applyDeliveryEvent(runtime.store, { externalMessageId: mid }, "delivered");
  }

  /*
   * Potwierdzenie ODBIORU, po trwałym zapisie.
   *
   * Komentarz nad pętlą Meta w `runtime.ts` obiecuje, że zielone światło daje
   * udany odczyt ALBO zweryfikowany webhook. Druga połowa nie miała pokrycia:
   * webhook zapisywał wiadomość i nie dotykał zdrowia, więc źródło z żywymi
   * webhookami wyglądało na stare przez większość godziny — a przez najstarszy
   * sukces ciągnęło na czerwono cały kanał, razem ze zdrowymi skrzynkami.
   *
   * Znacznik jest OSOBNY od `lastSuccessfulSyncAt` i celowo nie udaje pełnego
   * uzgodnienia: webhook nie wie, czego dostawca nie dowiózł. Zapisujemy go
   * dopiero PO `ingestMetaEvents`, żeby awaria zapisu nie zostawiła śladu
   * „odebrano" po wiadomości, której nie ma na dysku.
   */
  for (const entryId of new Set(parsed.data.entry.map((entry) => entry.id))) {
    const account = runtime.config.meta.find((candidate) => candidate.accountKey === entryId);
    if (!account) continue;
    recordInboundReceipt(
      runtime.store,
      {
        key: { provider: account.provider, accountKey: account.accountKey },
        label: account.label,
        active: true,
      },
      context.now,
    );
  }

  return envelope(
    { accepted: true, stored: result.stored, duplicates: result.duplicates, echoes: result.echoes },
    context.now,
  );
}

export interface ResendWebhookContext {
  readonly runtime: InboxRuntime;
  readonly rawBody: string;
  readonly svixId: string | null | undefined;
  readonly svixTimestamp: string | null | undefined;
  readonly svixSignature: string | null | undefined;
  readonly now: number;
}

export function handleResendWebhook(context: ResendWebhookContext): HttpResult {
  const secret = context.runtime.config.outbound.resendWebhookSecret;
  if (!secret) return failure(503, "resend_webhook_not_configured");

  if (
    !verifyResendWebhook({
      rawBody: context.rawBody,
      svixId: context.svixId,
      svixTimestamp: context.svixTimestamp,
      svixSignature: context.svixSignature,
      secret,
      now: context.now,
    })
  ) {
    return failure(401, "invalid_signature");
  }

  // Weryfikacja podpisu i tak odrzuca żądanie bez `svix-id`; ta linia trzyma
  // to wprost, bo dalej cały porządek deduplikacji stoi na tym identyfikatorze.
  if (!context.svixId) return failure(400, "missing_svix_id");

  let payload: { type?: unknown; created_at?: unknown; data?: { email_id?: unknown } };
  try {
    payload = JSON.parse(context.rawBody);
  } catch {
    // 400 PRZED oznaczeniem svix-id jako obsłużonego. Odwrotna kolejność
    // kasowała zdarzenie: ponowienie dostawało 200 „duplikat", choć nic się
    // nie wydarzyło.
    return failure(400, "invalid_json");
  }

  const state = typeof payload.type === "string" ? resendDeliveryState(payload.type) : null;
  const emailId = typeof payload.data?.email_id === "string" ? payload.data.email_id : null;
  if (!state || !emailId) {
    /*
     * Zdarzenie bez skutku (`email.sent`, `email.delivery_delayed`, ładunek
     * bez `email_id`). Ponowienie niczego by nie zmieniło, więc domykamy je
     * jawnie: `svix-id` zużyty, odpowiedź 200 z podanym powodem.
     */
    context.runtime.store.acceptWebhook(context.svixId, context.now);
    return envelope(
      { accepted: true, applied: false, reason: state ? "missing_email_id" : "unsupported_event_type" },
      context.now,
    );
  }

  /*
   * Nieznany `email_id` to WYŚCIG, nie koniec obsługi.
   *
   * Webhook odbicia potrafi wyprzedzić zapis `externalMessageId` przez ścieżkę
   * wysyłki. Odpowiedź 200 z `applied: false` spalała wtedy jedyne
   * powiadomienie o tym, że wiadomość do klienta NIE doszła: dostawca nie
   * ponawiał, a monitoring nie widział żadnego błędu. Utrata była całkowicie
   * cicha. Kod 5xx jest jedynym wyjściem, po którym zdarzenie wróci — i
   * dlatego `svix-id` nie może tu zostać oznaczony jako obsłużony.
   */
  const target = context.runtime.store
    .listAttempts()
    .find((entry) => entry.externalMessageId === emailId);
  if (!target) {
    /*
     * Ponawianie ma KONIEC.
     *
     * Wyścig z zapisem `externalMessageId` trwa sekundy, nie godziny. Wiadomość
     * wysłana przez to samo konto Resend, ale przez inną integrację, nigdy nie
     * trafi do naszego ledgera i odpowiadanie na nią 5xx w nieskończoność
     * zamieniłoby jeden nieistotny webhook w stały strumień błędów.
     *
     * Po upływie okna przyjmujemy zdarzenie, ale NIE udajemy, że je
     * zastosowaliśmy: zapisujemy awarię przy źródle, żeby zniknięcie odbicia
     * było widoczne w kanale zamiast zostać w logu.
     */
    const age = context.now - resendEventTime(payload, context.now);
    if (age <= RESEND_RETRY_WINDOW_MS) return failure(503, "delivery_target_not_found");

    context.runtime.store.acceptWebhook(context.svixId, context.now);
    recordFailure(
      context.runtime.store,
      { key: { provider: "email", accountKey: "resend#delivery" }, label: "Resend — doręczenia", active: true },
      "error",
      `Zdarzenie doręczenia bez pasującej wysyłki (${emailId.slice(0, 12)}…)`,
      context.now,
    );
    return envelope(
      { accepted: true, applied: false, reason: "delivery_target_not_found" },
      context.now,
    );
  }

  /*
   * Kolejność: ZASTOSUJ, potem oznacz jako obsłużone.
   *
   * Wcześniej trwały znacznik `svix-id` powstawał przed parsowaniem
   * i zastosowaniem, więc każde zakończenie inne niż udane zastosowanie —
   * błąd zapisu, restart, nierozpoznany ładunek — kasowało zdarzenie na
   * zawsze: ponowienie dostawało 200 „duplikat", nie zrobiwszy niczego.
   *
   * Odwrócenie kolejności jest bezpieczne, bo `applyDeliveryEvent` jest
   * monotoniczne: stan dostarczenia nigdy się nie cofa, a zdarzenie o randze
   * nie wyższej niż zapisana nic nie zmienia. Powtórka jest więc bez skutku
   * i wolno ją rozpoznać dopiero PO zastosowaniu.
   */
  const applied = applyDeliveryEvent(context.runtime.store, { externalMessageId: emailId }, state);
  const pierwszeDoreczenie = context.runtime.store.acceptWebhook(context.svixId, context.now);
  if (!pierwszeDoreczenie) return envelope({ accepted: true, duplicate: true }, context.now);
  // `applied: false` przy PIERWSZYM doręczeniu znaczy, że zdarzenie było
  // słabsze od już zapisanego. Ponowienie nic by nie dało.
  return envelope({ accepted: true, applied }, context.now);
}
