import { DEFAULT_TICK_INTERVAL_MS, RECONCILE_EVERY_TICKS } from "./config.js";
import {
  FRESHNESS_POLICY,
  overallFreshness,
  sourceKeyString,
  type HealthState,
  type SourceHealth,
  type SourceKey,
} from "./contract.js";
import type { InboxStore } from "./store.js";

/**
 * Zdrowie źródeł i świeżość kanału.
 *
 * Jedna zasada rządzi całym plikiem: **błąd źródła nigdy nie może wyglądać jak
 * pusta kolejka**. Pusta lista i zepsute połączenie wyglądają w interfejsie
 * identycznie, jeśli nikt nie policzy różnicy — a to najgorszy możliwy stan,
 * bo wygląda jak spokojny dzień.
 */

/** Backoff wykładniczy z sufitem. Bez sufitu źródło zasypia na kilka godzin. */
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;

export function backoffDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const delay = BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 8);
  return Math.min(delay, BACKOFF_MAX_MS);
}

export interface HealthInput {
  readonly key: SourceKey;
  readonly label: string;
  readonly active: boolean;
}

export function recordSuccess(store: InboxStore, input: HealthInput, now: number): SourceHealth {
  const health: SourceHealth = {
    provider: input.key.provider,
    accountKey: input.key.accountKey,
    label: input.label,
    state: "ok",
    active: input.active,
    lastSuccessfulSyncAt: now,
    lastAttemptAt: now,
    nextAttemptAt: null,
    consecutiveFailures: 0,
    message: null,
  };
  store.setHealth(health);
  return health;
}

export type FailureKind = "reconnect_required" | "missing_scope" | "rate_limited" | "error";

export function recordFailure(
  store: InboxStore,
  input: HealthInput,
  kind: FailureKind,
  message: string,
  now: number,
): SourceHealth {
  const previous = store.getHealth(input.key);
  const failures = (previous?.consecutiveFailures ?? 0) + 1;
  // `reconnect_required` i `missing_scope` nie mijają same. Backoff ma je
  // odpytywać rzadko, ale stan musi zostać widoczny, bo wymaga człowieka.
  const state: HealthState = kind === "error" && failures > 1 ? "backoff" : kind;

  const health: SourceHealth = {
    provider: input.key.provider,
    accountKey: input.key.accountKey,
    label: input.label,
    state,
    active: input.active,
    // Ostatni SUKCES zostaje nietknięty. Nadpisanie go czasem próby
    // pokazywałoby świeże dane tam, gdzie od godziny nic nie przychodzi.
    lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt ?? null,
    lastAttemptAt: now,
    nextAttemptAt: now + backoffDelay(failures),
    consecutiveFailures: failures,
    message: sanitizeMessage(message),
  };
  store.setHealth(health);
  return health;
}

/**
 * Sufiks klucza znacznika potwierdzonego ODBIORU.
 *
 * Ten sam wzorzec, co `#sent` w poczcie: osobny wpis zdrowia zamiast nowego
 * pola w kontrakcie. Wpis jest NIEAKTYWNY, bo nie jest źródłem do odpytywania,
 * tylko śladem po tym, że coś do nas dotarło.
 */
const RECEIPT_SUFFIX = "#receipt";

export function receiptSourceKey(key: SourceKey): SourceKey {
  return { provider: key.provider, accountKey: `${key.accountKey}${RECEIPT_SUFFIX}` };
}

/** Źródło, do którego należy znacznik. `null` = to zwykłe źródło, nie znacznik. */
function sourceOfReceipt(health: SourceHealth): string | null {
  if (!health.accountKey.endsWith(RECEIPT_SUFFIX)) return null;
  return sourceKeyString({
    provider: health.provider,
    accountKey: health.accountKey.slice(0, -RECEIPT_SUFFIX.length),
  });
}

/**
 * Potwierdzenie ODBIORU: zweryfikowany i trwale zapisany webhook.
 *
 * To NIE jest uzgodnienie i nie wolno tych dwóch rzeczy sklejać. Webhook
 * dowodzi wyłącznie, że kanał przyjmowania żyje; nie mówi ani słowa o tym,
 * czy nie brakuje wiadomości, których dostawca nie dowiózł. Dlatego znacznik
 * jest osobny i NIGDY nie nadpisuje `lastSuccessfulSyncAt` źródła — inaczej
 * strona bez uzgodnienia od doby wyglądałaby na w pełni zsynchronizowaną,
 * czyli dokładnie odwrotnie do prawdy.
 */
export function recordInboundReceipt(
  store: InboxStore,
  input: HealthInput,
  now: number,
): SourceHealth {
  const key = receiptSourceKey(input.key);
  const health: SourceHealth = {
    provider: key.provider,
    accountKey: key.accountKey,
    label: `${input.label} — odbiór`.slice(0, 64),
    state: "ok",
    // Świadomie NIEAKTYWNY: znacznik nie ma prawa sam z siebie ani zapalić,
    // ani zgasić kanału. Liczy się wyłącznie przy swoim źródle.
    active: false,
    lastSuccessfulSyncAt: now,
    lastAttemptAt: now,
    nextAttemptAt: null,
    consecutiveFailures: 0,
    message: null,
  };
  store.setHealth(health);
  return health;
}

/** Czas ostatniego potwierdzonego odbioru dla źródła. */
export function lastInboundReceiptAt(store: InboxStore, key: SourceKey): number | null {
  return store.getHealth(receiptSourceKey(key))?.lastSuccessfulSyncAt ?? null;
}

/**
 * Po jakim czasie brak PEŁNEGO uzgodnienia jest osobnym, jawnym stanem.
 *
 * WYLICZANE ze wspólnych stałych, a nie wpisane z ręki: półtora planowanego
 * odstępu uzgodnienia. Wpisana liczba rozjechałaby się przy pierwszej zmianie
 * kadencji i nikt by tego nie zauważył, bo obie wyglądałyby poprawnie.
 *
 * Półtorej znaczy: jedno uzgodnienie mogło się spóźnić, dwa to już awaria.
 * Webhooki, choćby płynęły co minutę, nie powiedzą nam o wiadomości, której
 * dostawca nie dowiózł.
 */
export const RECONCILE_OVERDUE_MS = Math.round(
  1.5 * RECONCILE_EVERY_TICKS * DEFAULT_TICK_INTERVAL_MS,
);

/**
 * Komunikat dla człowieka: krótki, bez adresów, tokenów i odpowiedzi API.
 * Wpadający tu tekst pochodzi z wyjątków bibliotek, więc bywa w nim wszystko.
 */
export function sanitizeMessage(raw: string): string {
  const withoutSecrets = raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[adres]")
    .replace(/\b(?:Bearer|token|password|secret|whsec_[A-Za-z0-9+/=]+)\S*/gi, "[sekret]")
    .replace(/https?:\/\/\S+/g, "[adres]")
    .replace(/\s+/g, " ")
    .trim();
  return withoutSecrets.slice(0, 200);
}

export interface ChannelFreshness {
  readonly state: "green" | "yellow" | "red";
  readonly oldestSuccessAt: number | null;
  readonly ageMs: number | null;
  readonly sources: SourceHealth[];
  /** true = któreś aktywne źródło nie odpowiada; pusta lista NIE znaczy spokoju. */
  readonly degraded: boolean;
  readonly degradedSources: string[];
  /** Ostatni zweryfikowany webhook per źródło. Potwierdza ODBIÓR, nie kompletność. */
  readonly receipts: Array<{ readonly source: string; readonly at: number }>;
  /**
   * Źródła bez pełnego uzgodnienia dłużej niż `RECONCILE_OVERDUE_MS`.
   *
   * Osobne pole, nie alarm: kanał przyjmuje wiadomości, ale nikt nie
   * potwierdził, że przyjął WSZYSTKIE. Wrzucenie tego do czerwonej kropki
   * skończyłoby się alarmem przez większość doby, a alarm, który świeci
   * zawsze, przestaje być alarmem.
   */
  readonly reconcileOverdue: string[];
  readonly policy: typeof FRESHNESS_POLICY;
}

export function channelFreshness(store: InboxStore, now: number): ChannelFreshness {
  const sources = store.listHealth();

  const receipts = new Map<string, number>();
  for (const entry of sources) {
    const parent = sourceOfReceipt(entry);
    if (parent === null || entry.lastSuccessfulSyncAt === null) continue;
    receipts.set(parent, Math.max(receipts.get(parent) ?? 0, entry.lastSuccessfulSyncAt));
  }

  /*
   * Świeżość liczona z ODBIORU, degradacja dalej z uzgodnienia.
   *
   * Meta uzgadnia się raz na godzinę, a progi świeżości są pięcio- i
   * piętnastominutowe. Bez tego złożenia zdrowa strona z żywymi webhookami
   * była zielona pięć minut na godzinę, a przez pozostałe pięćdziesiąt pięć
   * ciągnęła CAŁY kanał na czerwono, bo ogólny stan bierze najstarszy sukces
   * spośród aktywnych źródeł — czyli zdrowe skrzynki pocztowe płaciły za
   * kadencję Mety.
   *
   * Zmieniamy WYŁĄCZNIE wiek. `state` źródła zostaje nietknięty, więc webhook
   * nie ma jak zamalować `backoff` ani `reconnect_required`: to, że coś do nas
   * dociera, nie znaczy, że uzgodnienie działa.
   */
  const effective = sources.map((entry) => {
    const receiptAt = receipts.get(sourceKeyString(entry));
    if (receiptAt === undefined) return entry;
    if (entry.lastSuccessfulSyncAt !== null && entry.lastSuccessfulSyncAt >= receiptAt) return entry;
    return { ...entry, lastSuccessfulSyncAt: receiptAt };
  });
  const overall = overallFreshness(effective, now);

  const reconcileOverdue = sources
    .filter((entry) => sourceOfReceipt(entry) === null)
    .filter((entry) => entry.active)
    .filter(
      (entry) =>
        entry.lastSuccessfulSyncAt === null || now - entry.lastSuccessfulSyncAt > RECONCILE_OVERDUE_MS,
    )
    .map((entry) => sourceKeyString(entry));

  return {
    state: overall.state,
    oldestSuccessAt: overall.oldestSuccessAt,
    ageMs: overall.ageMs,
    /*
     * Znaczniki odbioru NIE sa zrodlami i nie moga wyjsc na zewnatrz jako
     * zrodla. Odbiorca tej odpowiedzi (czat) zaklada z nich wiersze stanu
     * i rysuje kafelki, wiec „Facebook — odbior" pojawilby sie w interfejsie
     * jako osobne, nieistniejace konto. Czas odbioru jest osobno, w `receipts`.
     */
    sources: sources
      .filter((entry) => sourceOfReceipt(entry) === null)
      .sort((a, b) => `${a.provider}${a.accountKey}`.localeCompare(`${b.provider}${b.accountKey}`)),
    degraded: overall.degradedSources.length > 0,
    degradedSources: overall.degradedSources,
    receipts: [...receipts.entries()]
      .map(([source, at]) => ({ source, at }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    reconcileOverdue,
    policy: FRESHNESS_POLICY,
  };
}

/**
 * Czy wolno pokazać „brak spraw".
 *
 * Wolno wyłącznie wtedy, gdy każde aktywne źródło odpowiedziało i lista jest
 * naprawdę pusta. W każdym innym przypadku interfejs ma powiedzieć, że część
 * danych jest niedostępna.
 */
export function mayReportEmptyQueue(freshness: ChannelFreshness): boolean {
  if (freshness.degraded) return false;
  /*
   * Konfiguracja BEZ ani jednego aktywnego źródła nie jest „pustą kolejką",
   * tylko brakiem kanału. Wcześniej `every` na pustej liście zwracało `true`
   * i taki stan przechodził jako spokojny.
   */
  const active = freshness.sources.filter((source) => source.active);
  if (active.length === 0) return false;
  return active.every((source) => source.state === "ok" && source.lastSuccessfulSyncAt !== null);
}
