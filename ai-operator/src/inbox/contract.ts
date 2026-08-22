import { z } from "zod";

/**
 * Generyczny model domenowy kanału „Obsługa klienta".
 *
 * Powstał, bo kolejka przestała być kolejką Allegro. Nazwy `allegro*` opisywały
 * jedno źródło; tu opisujemy KAŻDE źródło, więc identyfikator dostawcy jest
 * zwykłym stringiem walidowanym przez rejestr, a nie zamkniętą unią w zapisie.
 * Dodanie WhatsAppa ma być wpisem w rejestrze, nie migracją schematu.
 */

/** Identyfikator dostawcy. Walidację „czy znany" robi rejestr, nie typ. */
export const ProviderId = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, "provider: małe litery, cyfry i podkreślenie");
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * Konto w obrębie dostawcy: skrzynka `sklep|biuro|hurt`, strona FB, konto IG,
 * a dla Allegro rozróżnienie Centrum wiadomości i Dyskusji.
 *
 * Osobny klucz konta jest tu po to, żeby każde konto miało własny kursor,
 * własne zdrowie i własną tożsamość nadawcy. Jedna zdrowa skrzynka nie może
 * zamaskować zepsutej, a odpowiedź nie może wyjść z cudzego adresu.
 */
export const AccountKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "accountKey: bez spacji i znaków sterujących");
export type AccountKey = z.infer<typeof AccountKey>;

export const SourceKey = z.object({ provider: ProviderId, accountKey: AccountKey }).strict();
export type SourceKey = z.infer<typeof SourceKey>;

export function sourceKeyString(key: SourceKey): string {
  return `${key.provider}:${key.accountKey}`;
}

export const MessageDirection = z.enum(["incoming", "outgoing", "system"]);
export type MessageDirection = z.infer<typeof MessageDirection>;

export const AttachmentMeta = z
  .object({
    id: z.string().min(1).max(256),
    fileName: z.string().max(256).nullable(),
    mimeType: z.string().max(128).nullable(),
    sizeBytes: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type AttachmentMeta = z.infer<typeof AttachmentMeta>;

/**
 * Wiadomość znormalizowana. `sourceCreatedAt` to czas ŹRÓDŁA — nigdy czas
 * kliknięcia ani czas zapisu. Gdy źródło go nie poda, pole jest null i UI ma
 * o tym mówić, zamiast podstawiać własny zegar (patrz `receivedAt`).
 */
export const InboxMessage = z
  .object({
    provider: ProviderId,
    accountKey: AccountKey,
    externalConversationId: z.string().min(1).max(256),
    externalMessageId: z.string().min(1).max(512),
    caseId: z.string().min(1).max(128),
    direction: MessageDirection,
    /** Czas nadania wg źródła. */
    sourceCreatedAt: z.number().int().positive().nullable(),
    /** Czas trwałego zapisu u nas. Służy do diagnostyki, nie do SLA. */
    receivedAt: z.number().int().positive(),
    authorLabel: z.string().max(256).nullable(),
    subject: z.string().max(998).nullable(),
    body: z.string().max(64_000),
    bodyTruncated: z.boolean(),
    attachments: z.array(AttachmentMeta).max(50),
    /**
     * Adres z `Reply-To`, jeżeli był jednoznaczny.
     *
     * Trzymany OSOBNO od `authorLabel`: nadawca i adres do odpowiedzi to dwie
     * różne rzeczy, a sklejenie ich uniemożliwiłoby pokazanie człowiekowi,
     * że odpowiedź poleci gdzie indziej, niż przyszła.
     */
    replyToAddress: z.string().max(320).nullable(),
    /** Nagłówki wątkowania RFC — wyłącznie e-mail. */
    rfcMessageId: z.string().max(998).nullable().default(null),
    rfcInReplyTo: z.string().max(998).nullable().default(null),
    rfcReferences: z.array(z.string().max(998)).max(50).default([]),
    /** Echo własnej wysyłki rozpoznane po webhooku/ledgerze. */
    isEcho: z.boolean().default(false),
    /**
     * Wiadomość masowa/automatyczna wg NAGŁÓWKÓW RFC, nie wg nazwy nadawcy.
     *
     * Sygnał był liczony w adapterze poczty i wyrzucany po drodze, więc
     * klasyfikator nie miał najmocniejszego dostępnego dowodu i przepuszczał
     * newslettery do kolejki obsługi klienta.
     */
    bulkHint: z.boolean().default(false),
    /**
     * Odcisk treści: nadawca, czas, temat, ciało. Rozstrzyga kolizję
     * identyfikatorów, gdy nadawca wysyła serię z jednym `Message-ID`.
     * Ten sam odcisk to ta sama wiadomość i dedup ma ją pochłonąć; inny odcisk
     * pod tym samym identyfikatorem to DWIE wiadomości i obie muszą przeżyć.
     */
    contentFingerprint: z.string().min(8).max(64),
  })
  .strict();
export type InboxMessage = z.infer<typeof InboxMessage>;

export const WorkflowState = z.enum(["new", "in_progress", "closed"]);
export type WorkflowState = z.infer<typeof WorkflowState>;

/**
 * Powód klasyfikacji. Zapisujemy powód i wersję, żeby reklasyfikacja była
 * odtwarzalna i żeby dało się zobaczyć, czemu coś trafiło (albo nie trafiło)
 * do kolejki — bez trzymania treści.
 */
export const ClassificationReason = z.enum([
  "customer_message",
  "answered",
  "pending_action",
  "bulk_or_marketing",
  "automated_report",
  "internal_sender",
  "thanks_only",
  "low_confidence_fail_open",
  "classifier_error_fail_open",
  "source_closed",
  "bounce",
  "auto_reply",
  "needs_review",
]);
export type ClassificationReason = z.infer<typeof ClassificationReason>;

export const CLASSIFIER_VERSION = 1;

export const InboxCase = z
  .object({
    caseId: z.string().min(1).max(128),
    provider: ProviderId,
    accountKey: AccountKey,
    externalConversationId: z.string().min(1).max(256),
    subject: z.string().max(998).nullable(),
    participantLabel: z.string().max(256).nullable(),
    orderRef: z.string().max(128).nullable(),
    firstSeenAt: z.number().int().positive(),
    lastMessageAt: z.number().int().positive().nullable(),
    lastIncomingMessageId: z.string().max(512).nullable(),
    lastIncomingAt: z.number().int().positive().nullable(),
    messageCount: z.number().int().nonnegative(),
    requiresResponse: z.boolean(),
    pendingAction: z.boolean(),
    classifierVersion: z.number().int().nonnegative(),
    classificationReason: ClassificationReason,
    /**
     * Sprawa niejednoznaczna.
     *
     * Fail-open zostaje — sprawa jest w kolejce — ale musi być widoczna jako
     * „do weryfikacji", inaczej zalewa główną listę bez żadnego rozróżnienia
     * i zespół uczy się jej nie ufać.
     */
    needsReview: z.boolean().default(false),
    sourceClosed: z.boolean(),
    hasAttachments: z.boolean(),
  })
  .strict();
export type InboxCase = z.infer<typeof InboxCase>;

export const HealthState = z.enum([
  "ok",
  "backoff",
  "reconnect_required",
  "missing_scope",
  "rate_limited",
  "error",
  "never_synced",
  "disabled",
]);
export type HealthState = z.infer<typeof HealthState>;

/**
 * Zdrowie pojedynczego źródła. `lastSuccessfulSyncAt` jest osobno od
 * `lastAttemptAt`, bo „próbowaliśmy" nie jest tym samym co „mamy dane".
 */
export const SourceHealth = z
  .object({
    provider: ProviderId,
    accountKey: AccountKey,
    label: z.string().min(1).max(64),
    state: HealthState,
    active: z.boolean(),
    lastSuccessfulSyncAt: z.number().int().positive().nullable(),
    lastAttemptAt: z.number().int().positive().nullable(),
    nextAttemptAt: z.number().int().positive().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    /** Krótki, nietechniczny komunikat. Bez treści, adresów i payloadów. */
    message: z.string().max(200).nullable(),
  })
  .strict();
export type SourceHealth = z.infer<typeof SourceHealth>;

/**
 * Progi świeżości trzymane centralnie. W UI nie ma być magicznych liczb —
 * inaczej za pół roku „5 minut" znaczy co innego na karcie i w alarmie.
 */
export const FRESHNESS_POLICY = {
  okMs: 5 * 60_000,
  warnMs: 10 * 60_000,
  alarmMs: 15 * 60_000,
} as const;

export type OverallFreshnessState = "green" | "yellow" | "red";

/**
 * Stany, przy których kanał NIE może być zielony.
 *
 * Lista jest pozytywna („co jest zdrowe") odwrócona świadomie: nowy stan
 * dodany do `HealthState` domyślnie liczy się jako zdegradowany, a nie jako
 * zdrowy. Zapomniany wpis daje wtedy fałszywy alarm, a nie fałszywy spokój.
 */
const DEGRADED_STATES: ReadonlySet<HealthState> = new Set([
  "backoff",
  "reconnect_required",
  "missing_scope",
  "rate_limited",
  "error",
  "never_synced",
]);

/**
 * Ogólna świeżość liczona z NAJSTARSZEGO sukcesu wśród aktywnych źródeł.
 * Wersja z najnowszym sukcesem pokazuje zielono, gdy jedna skrzynka żyje,
 * a trzy pozostałe leżą — czyli dokładnie wtedy, kiedy nie wolno.
 */
export function overallFreshness(
  sources: readonly SourceHealth[],
  now: number,
): {
  state: OverallFreshnessState;
  oldestSuccessAt: number | null;
  ageMs: number | null;
  degradedSources: string[];
} {
  const active = sources.filter((s) => s.active);
  if (active.length === 0) {
    return { state: "red", oldestSuccessAt: null, ageMs: null, degradedSources: [] };
  }
  /*
   * Każdy stan poza `ok` jest zdegradowany.
   *
   * Wcześniej `backoff` i `rate_limited` przechodziły jako zdrowe, więc
   * źródło, które właśnie nie odpowiedziało i czeka na ponowienie, świeciło
   * na zielono. Kropka mówiła „mamy wszystko" w chwili, gdy wprost wiemy,
   * że czegoś nie mamy.
   */
  const degraded = active
    .filter((s) => DEGRADED_STATES.has(s.state))
    .map((s) => sourceKeyString(s));
  const neverSynced = active.filter((s) => s.lastSuccessfulSyncAt === null);
  if (neverSynced.length > 0) {
    return {
      state: "red",
      oldestSuccessAt: null,
      ageMs: null,
      degradedSources: [...new Set([...degraded, ...neverSynced.map((s) => sourceKeyString(s))])],
    };
  }
  let oldest = Number.POSITIVE_INFINITY;
  for (const source of active) {
    if (source.lastSuccessfulSyncAt !== null && source.lastSuccessfulSyncAt < oldest) {
      oldest = source.lastSuccessfulSyncAt;
    }
  }
  const oldestSuccessAt = Number.isFinite(oldest) ? oldest : null;
  const ageMs = oldestSuccessAt === null ? null : Math.max(0, now - oldestSuccessAt);
  let state: OverallFreshnessState = "green";
  if (degraded.length > 0) state = "red";
  else if (ageMs !== null && ageMs >= FRESHNESS_POLICY.alarmMs) state = "red";
  else if (ageMs !== null && ageMs >= FRESHNESS_POLICY.okMs) state = "yellow";
  return { state, oldestSuccessAt, ageMs, degradedSources: degraded };
}

/** Tryb treści. `model` redaguje dane kontaktowe przed analizą AI. */
export const ContentMode = z.enum(["none", "display", "model"]);
export type ContentMode = z.infer<typeof ContentMode>;

// ── zdrowie i kompletnosc: JEDEN wersjonowany kontrakt ───────────────────────

/**
 * Wersja kontraktu zdrowia i kompletności.
 *
 * Jedzie w KAŻDEJ odpowiedzi niosącej ten kształt, bo odbiorca (firmowy czat)
 * musi mieć prawo odmówić interpretacji kształtu, którego nie zna, zamiast
 * zgadywać z brakujących pól. Data wdrożenia takiej możliwości nie daje:
 * dwie instancje bywają wdrożone w różnych chwilach.
 *
 * Podnosimy przy KAŻDEJ zmianie znaczenia pola, nie tylko przy usunięciu.
 */
export const INBOX_HEALTH_CONTRACT_VERSION = "inbox-health-1";

/**
 * Stany źródeł spoza naszego słownika, sprowadzone do jednego znaczenia.
 *
 * `ready` przychodzi z mostu TeaBrew (Allegro) i znaczy DOKŁADNIE to, co nasze
 * `ok`. Dopóki każdy konsument tłumaczył je sam, jeden rysował zieloną kropkę,
 * a drugi odmawiał komunikatu o pustej kolejce dla tego samego źródła, więc
 * ta sama chwila wyglądała na dwa różne stany kanału.
 *
 * Tłumaczenie jest tutaj, w kontrakcie, żeby czat mógł zaimportować dokładnie
 * tę funkcję zamiast pisać drugą, równoległą tabelkę.
 */
const KNOWN_HEALTH_STATES: ReadonlySet<string> = new Set(HealthState.options);

/**
 * Walidacja stanu źródła. NIE tłumaczenie.
 *
 * Tłumaczenie żyje w adapterach, przy źródle, które zna swoje własne nazwy
 * (`toSourceHealth` dla Allegro). Druga tabela tutaj wyglądała na wspólny
 * kontrakt, a była równoległą listą, która mogła się z tamtą rozjechać —
 * i zaczęła: jedna uznawała `syncing` za zdrowe, druga za błąd. Dwie tabele
 * dla jednej decyzji to jedna za dużo, więc zostaje ta przy źródle.
 *
 * Tutaj pilnujemy już tylko tego, żeby do kontraktu nie wszedł stan spoza
 * zbioru. Nieznany stan jest BŁĘDEM, a nie cichym „ok": nowa wartość dodana
 * kiedyś po drugiej stronie ma zapalić widoczną awarię, a nie przemknąć jako
 * spokojny dzień.
 */
export function normalizeSourceState(raw: string): HealthState {
  return KNOWN_HEALTH_STATES.has(raw) ? (raw as HealthState) : "error";
}

/** Czy źródło w tym stanie realnie dostarcza dane. Jedno miejsce, jedna reguła. */
export function isSourceStateHealthy(raw: string): boolean {
  return normalizeSourceState(raw) === "ok";
}

/** Dlaczego widok NIE jest kompletny. Pusta lista = jest kompletny. */
export type CompletenessGap = "no_active_source" | "source_degraded" | "reconcile_overdue";

/**
 * Zdrowie i kompletność JEDNEGO źródła.
 *
 * Odbiór i uzgodnienie są tu osobno i nigdy nie wolno ich skleić. Webhook
 * potwierdza wyłącznie, że kanał przyjmowania żyje; nie mówi ani słowa o tym,
 * czy podczas restartu albo przerwy nic nie przepadło. Sklejenie tych dwóch
 * czasów daje stronę, która przez dobę bez uzgodnienia wygląda na w pełni
 * zsynchronizowaną.
 */
export interface SourceCompleteness {
  /** `provider:accountKey`, ten sam format, co w listach kluczy. */
  readonly source: string;
  readonly provider: ProviderId;
  readonly accountKey: AccountKey;
  readonly label: string;
  /** Stan PO normalizacji. Tego pola używa się do decyzji. */
  readonly state: HealthState;
  /** Stan tak, jak go zapisało źródło. Wyłącznie do diagnostyki. */
  readonly rawState: string;
  readonly active: boolean;
  /** `state === "ok"`. Wyliczone raz, żeby nikt nie liczył tego po swojemu. */
  readonly healthy: boolean;
  /** Ostatnie PEŁNE uzgodnienie ze źródłem. Tylko ono dowodzi kompletności. */
  readonly lastReconciledAt: number | null;
  /** Ostatni potwierdzony ODBIÓR (zweryfikowany, trwale zapisany webhook). */
  readonly lastReceiptAt: number | null;
  /** Uzgodnienie starsze niż próg albo żadnego. */
  readonly reconcileOverdue: boolean;
  readonly nextAttemptAt: number | null;
  readonly consecutiveFailures: number;
  readonly message: string | null;
}

/**
 * Zdrowie i kompletność CAŁEGO kanału.
 *
 * Ten sam obiekt jedzie z `/health`, z `freshness` w odpowiedzi kolejki i
 * z `freshness` w odpowiedzi sprawy. Dwie niezależne prawdy o kompletności
 * kończyły się tym, że jedna odpowiedź mówiła „mamy wszystko", a druga
 * „nie wiemy" w tej samej sekundzie.
 */
export interface ChannelHealth {
  readonly contractVersion: typeof INBOX_HEALTH_CONTRACT_VERSION;
  /** Zegar, przy którym policzono ten obiekt. Bez niego wiek jest nieweryfikowalny. */
  readonly generatedAt: number;
  readonly state: OverallFreshnessState;
  /**
   * Wiek NAJSTARSZEGO potwierdzenia (uzgodnienie albo odbiór) wśród aktywnych
   * źródeł. To jest wiek kropki, a nie miara kompletności.
   */
  readonly ageMs: number | null;
  readonly oldestSuccessAt: number | null;
  /** Najstarsze PEŁNE uzgodnienie wśród aktywnych źródeł. */
  readonly oldestReconciledAt: number | null;
  /** Najświeższy potwierdzony ODBIÓR w całym kanale. */
  readonly lastReceiptAt: number | null;
  readonly sources: SourceCompleteness[];
  readonly degraded: boolean;
  readonly degradedSources: string[];
  /** Źródła z zaległym pełnym uzgodnieniem. Klucze `provider:accountKey`. */
  readonly reconcileOverdue: string[];
  /** Próg użyty w TYM wyliczeniu, policzony z rzeczywistej kadencji. */
  readonly reconcileOverdueMs: number;
  /**
   * Czy wolno napisać „to wszystkie sprawy" / „brak spraw".
   *
   * ROZSTRZYGAJĄCE. Konsument nie ma prawa składać własnego warunku ze
   * `state`, `degraded` i `reconcileOverdue`, bo dokładnie takie składanie
   * dało dwie różne odpowiedzi na to samo pytanie.
   */
  readonly completeView: boolean;
  readonly incompleteBecause: CompletenessGap[];
  readonly policy: typeof FRESHNESS_POLICY;
}
