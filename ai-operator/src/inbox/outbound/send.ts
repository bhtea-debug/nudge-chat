import type { InboxStore, OutboundAttempt } from "../store.js";
import {
  beginSending,
  finishFailed,
  finishSent,
  markUncertain,
  markerStillValid,
  prepareAttempt,
} from "./ledger.js";
import {
  outgoingMessagePresent,
  recordOutgoingMessage,
  restoreOutgoingMessage,
} from "./record.js";
import { replySubject, sendViaResend, type ResendMailbox, type ResendResult } from "./resend.js";
import { sendViaMeta, type MetaSendAccount, type MetaSendResult } from "./meta-send.js";

/**
 * Jedna droga wysyłki dla wszystkich dostawców.
 *
 * Kolejność kroków jest identyczna niezależnie od kanału, bo niezależne od
 * kanału są też sposoby, na jakie wysyłka może pójść źle: podwójne kliknięcie,
 * nowa wiadomość klienta w międzyczasie, timeout w połowie, restart procesu.
 * Różni się wyłącznie ostatni krok — samo wywołanie API dostawcy.
 */

export type SendOutcome =
  | {
      readonly status: "sent";
      readonly requestId: string;
      readonly externalMessageId: string | null;
      /** true = powtórzone żądanie uzupełniło brakującą wiadomość w wątku. */
      readonly repairedHistory?: boolean;
      /**
       * Czy wątek zawiera odpowiedź z TEJ próby po zakończeniu żądania.
       * `false` znaczy, że naprawa się nie udała — a nie, że nie była
       * potrzebna. Bez tego rozróżnienia „wysłano" brzmiało tak samo dla
       * historii kompletnej i dla historii, której nie dało się odtworzyć.
       */
      readonly historyComplete?: boolean;
    }
  | {
      readonly status: "failed";
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
      /**
       * Czy da się DOWIEŚĆ, że wiadomość nie dotarła do klienta.
       *
       * Odbiorca nie ma prawa wnioskować tego z kodu HTTP: bramka albo proxy
       * potrafi zwrócić 4xx po tym, jak żądanie już poszło dalej. Terminalne
       * „nie wysłano" wolno przyjąć WYŁĄCZNIE wtedy, gdy mówi to ten kontrakt.
       *
       * `true` znaczy: albo nic nie opuściło tego procesu (odmowa przed
       * POST-em), albo dostawca odpowiedział jednoznaczną odmową.
       */
      readonly settledNotSent: boolean;
    }
  | { readonly status: "uncertain"; readonly requestId: string; readonly code: string; readonly message: string }
  | {
      readonly status: "rejected";
      readonly requestId: string;
      readonly code: string;
      readonly message: string;
      /** Odmowa PRZED POST-em: do dostawcy nie poszło nic. Zawsze `true`. */
      readonly settledNotSent: true;
    };

export interface SendTransport {
  /** Wysyła i zwraca wynik. Nie wolno mu ponawiać samodzielnie. */
  send(attempt: OutboundAttempt): Promise<ResendResult | MetaSendResult>;
}

export interface SendRequest {
  readonly store: InboxStore;
  readonly requestId: string;
  readonly caseId: string;
  readonly text: string;
  readonly expectedLastIncomingMessageId: string | null;
  readonly transport: SendTransport;
  readonly now: () => number;
}

export async function sendReply(request: SendRequest): Promise<SendOutcome> {
  const { store, requestId } = request;

  const prepared = prepareAttempt({
    store,
    requestId,
    caseId: request.caseId,
    text: request.text,
    expectedLastIncomingMessageId: request.expectedLastIncomingMessageId,
    now: request.now(),
  });
  if (!prepared.ok) {
    return {
      status: "rejected",
      settledNotSent: true,
      requestId,
      code: prepared.code,
      message: rejectionMessage(prepared.code),
    };
  }

  // Idempotencja na poziomie naszego API: powtórzone żądanie z tym samym
  // requestId dostaje wynik pierwotnej próby, a nie drugą wysyłkę.
  const existing = prepared.attempt;
  if (existing.status === "sent") {
    /*
     * Zanim odpowiemy „już wysłane", sprawdzamy, czy historia się zgadza.
     *
     * Awaria zapisu albo restart między `finishSent` a zapisem wiadomości
     * zostawia stan, w którym ledger mówi „wysłano", a wątek tego nie ma.
     * Bez tej naprawy każde kolejne żądanie zwracało wczesne `sent`
     * i wiadomość nie pojawiała się w wątku już nigdy.
     *
     * Brak jest rozpoznawany po identyfikatorze TEJ próby, nigdy po tym, czy
     * w sprawie jest jakakolwiek wiadomość wychodząca: przy starszej
     * odpowiedzi to drugie zawsze mówiło „komplet" i brakujący wpis nie
     * powstawał już nigdy.
     *
     * Naprawa NIE wykonuje żadnego requestu do dostawcy: wiadomość u klienta
     * już jest, chodzi wyłącznie o naszą historię.
     */
    const repair = restoreOutgoingMessage(store, existing, request.now());
    return {
      status: "sent",
      requestId,
      externalMessageId: existing.externalMessageId,
      repairedHistory: repair.restoredMessage || repair.reprojectedCase,
      historyComplete: repair.present,
    };
  }
  if (existing.status === "failed") {
    return {
      status: "failed",
      requestId,
      code: existing.failureCode ?? "failed",
      message: "Wiadomosc nie zostala wyslana",
      /*
       * Powtorka nad proba juz zamknieta jako `failed`. Ledger zapisal ten
       * wynik dopiero po ustaleniu, ze wiadomosc nie poszla, wiec jest to
       * rozstrzygniete.
       */
      settledNotSent: true,
    };
  }
  if (existing.status === "uncertain") {
    return {
      status: "uncertain",
      requestId,
      code: existing.failureCode ?? "uncertain",
      message: "Wynik poprzedniej proby jest nieznany",
    };
  }
  if (existing.status === "cancelled") {
    return {
      status: "rejected",
      requestId,
      code: "cancelled",
      message: "Proba zostala anulowana",
      settledNotSent: true,
    };
  }

  const started = beginSending(store, requestId, request.now());
  if (!started.ok) {
    return {
      status: "rejected",
      requestId,
      code: started.code,
      message: "Wysylka jest juz w toku",
      settledNotSent: true,
    };
  }

  // Ostatnia bramka przed POST-em: klient mógł napisać między potwierdzeniem
  // a tym momentem, a wtedy zatwierdzona treść odpowiada na nieaktualny stan.
  if (!markerStillValid(store, started.attempt)) {
    finishFailed(store, requestId, "stale_marker", request.now());
    return {
      status: "failed",
      requestId,
      code: "stale_marker",
      message: "Klient napisal ponownie, potwierdz odpowiedz jeszcze raz",
      // Bramka markera stoi PRZED POST-em: do dostawcy nie poszlo nic.
      settledNotSent: true,
    };
  }

  let result: ResendResult | MetaSendResult;
  try {
    result = await request.transport.send(started.attempt);
  } catch {
    // Wyjątek transportu jest nieodróżnialny od timeoutu: nie wiemy, czy
    // request doszedł. Bez gwarancji dostawcy nie wolno ponowić.
    markUncertain(store, requestId, "transport_exception");
    return {
      status: "uncertain",
      requestId,
      code: "transport_exception",
      message: "Nie udalo sie potwierdzic wyniku wysylki",
    };
  }

  if (result.status === "sent") {
    /*
     * KOLEJNOŚĆ: najpierw ledger, potem wątek. Zostaje taka, jaka jest.
     *
     * Odwrotna kolejność (najpierw wątek) skraca okno w jednym miejscu i
     * otwiera gorsze w drugim: proces zabity po zapisie wiadomości, a przed
     * `finishSent`, gubi BEZPOWROTNIE identyfikator od dostawcy — a to po nim
     * `applyDeliveryEvent` dopasowuje odbicia i skargi (`http.ts` woła je
     * z `externalMessageId`). Odbita wiadomość wyglądałaby wtedy na
     * doręczoną. Dodatkowo próba zostaje w `sending`, czyli blokuje sprawę do
     * czasu ręcznego rozstrzygnięcia przez człowieka, który o niczym nie wie.
     *
     * Żadna z kolejności nie grozi drugą wysyłką: powtórzenie tego samego
     * `requestId` odbija się o `beginSending`, a inny `requestId` o aktywną
     * próbę w `prepareAttempt`. Decyduje więc to, który osad da się naprawić —
     * i naprawialny jest osad TEJ kolejności: brakujący wpis w wątku ma
     * deterministyczny identyfikator i odtwarza go `restoreOutgoingMessage`,
     * bez jednego bajtu do dostawcy.
     */
    finishSent(store, requestId, result.externalMessageId, request.now());
    /*
     * Odpowiedź staje się częścią wątku.
     *
     * Bez tego kroku ledger wiedział o wysyłce, a wątek nie: sprawa dalej
     * „wymagała reakcji", w historii nie było naszej wiadomości, a kolejny
     * odczyt wyglądał jak klient bez odpowiedzi. Późniejsze echo albo kopia
     * z folderu wysłanych trafia w ten sam identyfikator i jest wchłaniana
     * przez dedup zamiast tworzyć duplikat.
     */
    const recorded = recordOutgoingMessage({
      store,
      attempt: started.attempt,
      text: request.text,
      externalMessageId: result.externalMessageId,
      now: request.now(),
    });

    /*
     * `historyComplete` mówi to, co jest, a nie to, co miało się udać.
     *
     * `recordOutgoingMessage` oddaje `null` także wtedy, gdy wpis już był —
     * echo Meta potrafi wrócić szybciej niż nasz zapis — więc brak zapisu nie
     * znaczy braku historii. Rozstrzyga sprawdzenie po identyfikatorze próby
     * z ledgera, już po `finishSent`.
     */
    const settled = store.getAttempt(requestId);
    return {
      status: "sent",
      requestId,
      externalMessageId: result.externalMessageId,
      historyComplete: recorded !== null || (settled ? outgoingMessagePresent(store, settled) : false),
    };
  }
  if (result.status === "failed") {
    finishFailed(store, requestId, result.code, request.now());
    /*
     * Dostawca odpowiedzial JEDNOZNACZNA odmowa (np. zamkniete okno
     * odpowiedzi). Transport zwraca `failed` wylacznie w takim przypadku;
     * wszystko, czego nie potrafi rozstrzygnac, oddaje jako `uncertain`.
     */
    return {
      status: "failed",
      requestId,
      code: result.code,
      message: result.message,
      settledNotSent: true,
    };
  }
  markUncertain(store, requestId, result.code);
  return { status: "uncertain", requestId, code: result.code, message: result.message };
}

function rejectionMessage(code: string): string {
  switch (code) {
    case "active_attempt_exists":
      return "Dla tej sprawy trwa juz inna wysylka";
    case "stale_marker":
      return "Klient napisal ponownie, potwierdz odpowiedz jeszcze raz";
    case "request_id_reused":
      return "Ten sam identyfikator zadania uzyty z inna trescia";
    case "case_not_found":
      return "Nie znaleziono sprawy";
    default:
      return "Wysylka odrzucona";
  }
}

/** Transport e-mail: Resend z deterministycznym kluczem idempotencji. */
export function resendTransport(input: {
  readonly apiKey: string;
  readonly mailbox: ResendMailbox;
  readonly to: string;
  readonly subject: string | null;
  readonly text: string;
  readonly inReplyTo: Parameters<typeof sendViaResend>[0]["inReplyTo"];
  readonly fetchImpl?: typeof fetch;
}): SendTransport {
  return {
    send: (attempt) =>
      sendViaResend({
        apiKey: input.apiKey,
        mailbox: input.mailbox,
        to: input.to,
        subject: replySubject(input.subject),
        text: input.text,
        attempt,
        inReplyTo: input.inReplyTo,
        fetchImpl: input.fetchImpl,
      }),
  };
}

/** Transport Meta: bez idempotencji dostawcy, więc bez automatycznych retry. */
export function metaTransport(input: {
  readonly account: MetaSendAccount;
  readonly recipientId: string;
  readonly text: string;
  readonly lastIncomingAt: number | null;
  readonly now: number;
  readonly fetchImpl?: typeof fetch;
}): SendTransport {
  return {
    send: (attempt) =>
      sendViaMeta({
        account: input.account,
        recipientId: input.recipientId,
        text: input.text,
        attempt,
        lastIncomingAt: input.lastIncomingAt,
        now: input.now,
        fetchImpl: input.fetchImpl,
      }),
  };
}
