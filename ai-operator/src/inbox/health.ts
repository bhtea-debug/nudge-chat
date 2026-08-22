import { DEFAULT_TICK_INTERVAL_MS, RECONCILE_EVERY_TICKS } from "./config.js";
import {
  FRESHNESS_POLICY,
  INBOX_HEALTH_CONTRACT_VERSION,
  normalizeSourceState,
  overallFreshness,
  sourceKeyString,
  type ChannelHealth,
  type CompletenessGap,
  type HealthState,
  type SourceCompleteness,
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
export function reconcileOverdueMsFor(tickIntervalMs: number): number {
  return Math.round(1.5 * RECONCILE_EVERY_TICKS * tickIntervalMs);
}

/**
 * Próg dla kadencji DOMYŚLNEJ.
 *
 * Zostaje wyłącznie jako wartość awaryjna dla wywołań bez dostępu do
 * konfiguracji. Każde miejsce, które konfigurację ma, liczy próg z
 * `tickIntervalMs` przez `reconcileOverdueMsFor` i podaje go wprost, bo
 * instancja z kadencją minutową zaległa po osiemnastu minutach, a nie po
 * dziewięćdziesięciu.
 */
export const RECONCILE_OVERDUE_MS = reconcileOverdueMsFor(DEFAULT_TICK_INTERVAL_MS);

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


/**
 * Nazwa historyczna kształtu zdrowia kanału.
 *
 * Zostaje jako alias, bo `freshness` w odpowiedzi kolejki i sprawy nazywa się
 * tak od początku i nie ma powodu przepisywać sygnatur tylko dla nazwy.
 * Kształt jest JEDEN: `ChannelHealth` z kontraktu.
 */
export type ChannelFreshness = ChannelHealth;

export interface ChannelHealthOptions {
  /**
   * Próg zaległego uzgodnienia policzony z RZECZYWISTEJ kadencji.
   *
   * Podaje go ten, kto ma konfigurację (warstwa HTTP). Bez tego parametru
   * funkcja liczyłaby próg z kadencji domyślnej i instancja odpytująca co
   * minutę ogłaszałaby komplet przez pierwsze półtorej godziny ciszy.
   */
  readonly reconcileOverdueMs?: number;
}

/**
 * JEDEN obiekt zdrowia i kompletności kanału.
 *
 * Zbiera trzy niezależne fakty i nie pozwala ich pomylić:
 *  - ostatnie PEŁNE uzgodnienie (jedyny dowód, że nic nie przepadło),
 *  - ostatni potwierdzony ODBIÓR (dowód, że kanał przyjmowania żyje),
 *  - stan źródeł (czy w ogóle odpowiadają).
 *
 * `completeView` jest wyliczone TU i tylko tu. Wcześniej każdy konsument
 * składał własny warunek z tych samych pól i wychodziły z tego dwie różne
 * odpowiedzi na jedno pytanie.
 */
export function channelFreshness(
  store: InboxStore,
  now: number,
  options: ChannelHealthOptions = {},
): ChannelHealth {
  const overdueMs = options.reconcileOverdueMs ?? RECONCILE_OVERDUE_MS;
  const stored = store.listHealth();

  const receipts = new Map<string, number>();
  for (const entry of stored) {
    const parent = sourceOfReceipt(entry);
    if (parent === null || entry.lastSuccessfulSyncAt === null) continue;
    receipts.set(parent, Math.max(receipts.get(parent) ?? 0, entry.lastSuccessfulSyncAt));
  }

  /*
   * Znaczniki odbioru NIE są źródłami i nie mogą wyjść na zewnątrz jako
   * źródła. Odbiorca zakłada z tej listy wiersze stanu i rysuje kafelki, więc
   * „Facebook, odbiór" pojawiłby się w interfejsie jako osobne, nieistniejące
   * konto. Czas odbioru jedzie przy swoim źródle, w `lastReceiptAt`.
   *
   * Stan normalizujemy OD RAZU: dalej w tym pliku nie ma już prawa pojawić się
   * surowy string, bo to od jego dwóch pisowni („ok" i „ready") brały się dwie
   * różne odpowiedzi o tym samym źródle.
   */
  const real = stored
    .filter((entry) => sourceOfReceipt(entry) === null)
    .map((entry) => ({ raw: entry, state: normalizeSourceState(entry.state) }));

  /*
   * Świeżość liczona z ODBIORU, degradacja dalej z uzgodnienia.
   *
   * Meta uzgadnia się raz na godzinę, a progi świeżości są pięcio- i
   * piętnastominutowe. Bez tego złożenia zdrowa strona z żywymi webhookami
   * była zielona pięć minut na godzinę, a przez pozostałe pięćdziesiąt pięć
   * ciągnęła CAŁY kanał na czerwono, bo ogólny stan bierze najstarszy sukces
   * spośród aktywnych źródeł, czyli zdrowe skrzynki pocztowe płaciły za
   * kadencję Mety.
   *
   * Zmieniamy WYŁĄCZNIE wiek. `state` źródła zostaje nietknięty, więc webhook
   * nie ma jak zamalować `backoff` ani `reconnect_required`: to, że coś do nas
   * dociera, nie znaczy, że uzgodnienie działa.
   */
  const effective: SourceHealth[] = real.map((entry) => {
    const receiptAt = receipts.get(sourceKeyString(entry.raw));
    const reconciled = entry.raw.lastSuccessfulSyncAt;
    const lastSuccessfulSyncAt =
      receiptAt !== undefined && (reconciled === null || reconciled < receiptAt)
        ? receiptAt
        : reconciled;
    return { ...entry.raw, state: entry.state, lastSuccessfulSyncAt };
  });
  const overall = overallFreshness(effective, now);

  const sources: SourceCompleteness[] = real
    .map((entry): SourceCompleteness => {
      const source = sourceKeyString(entry.raw);
      const lastReconciledAt = entry.raw.lastSuccessfulSyncAt;
      return {
        source,
        provider: entry.raw.provider,
        accountKey: entry.raw.accountKey,
        label: entry.raw.label,
        state: entry.state,
        rawState: entry.raw.state,
        active: entry.raw.active,
        healthy: entry.state === "ok",
        lastReconciledAt,
        lastReceiptAt: receipts.get(source) ?? null,
        /*
         * Brak JAKIEGOKOLWIEK uzgodnienia jest zaległością, a nie stanem
         * neutralnym: nikt nigdy nie potwierdził, że mamy komplet.
         */
        reconcileOverdue:
          entry.raw.active && (lastReconciledAt === null || now - lastReconciledAt > overdueMs),
        nextAttemptAt: entry.raw.nextAttemptAt,
        consecutiveFailures: entry.raw.consecutiveFailures,
        message: entry.raw.message,
      };
    })
    .sort((a, b) => a.source.localeCompare(b.source));

  const active = sources.filter((entry) => entry.active);
  const reconcileOverdue = sources
    .filter((entry) => entry.reconcileOverdue)
    .map((entry) => entry.source);

  /*
   * Kompletność ma DOKŁADNIE trzy powody, dla których jej nie ma. Lista
   * powodów jedzie na zewnątrz, żeby interfejs mógł napisać, czego brakuje,
   * zamiast wyświetlić samo „niepełne".
   */
  const incompleteBecause: CompletenessGap[] = [];
  // Konfiguracja BEZ ani jednego aktywnego źródła nie jest „pustą kolejką",
  // tylko brakiem kanału.
  if (active.length === 0) incompleteBecause.push("no_active_source");
  if (active.some((entry) => !entry.healthy)) incompleteBecause.push("source_degraded");
  /*
   * Zaległe uzgodnienie ZABRANIA ogłoszenia kompletu.
   *
   * To jest cała poprawka P0.4: żywy webhook potwierdza odbiór bieżących
   * zdarzeń, ale nie dowodzi, że nic nie przepadło podczas restartu albo
   * przerwy. Kanał, który przez dobę nie zrobił pełnego uzgodnienia, nie ma
   * podstaw napisać „brak spraw", choć każde źródło odpowiada.
   */
  if (reconcileOverdue.length > 0) incompleteBecause.push("reconcile_overdue");

  const reconciledTimes = active
    .map((entry) => entry.lastReconciledAt)
    .filter((value): value is number => value !== null);
  const receiptTimes = [...receipts.values()];

  return {
    contractVersion: INBOX_HEALTH_CONTRACT_VERSION,
    generatedAt: now,
    state: overall.state,
    ageMs: overall.ageMs,
    oldestSuccessAt: overall.oldestSuccessAt,
    oldestReconciledAt:
      reconciledTimes.length === active.length && reconciledTimes.length > 0
        ? Math.min(...reconciledTimes)
        : null,
    lastReceiptAt: receiptTimes.length > 0 ? Math.max(...receiptTimes) : null,
    sources,
    degraded: overall.degradedSources.length > 0,
    degradedSources: overall.degradedSources,
    reconcileOverdue,
    reconcileOverdueMs: overdueMs,
    completeView: incompleteBecause.length === 0,
    incompleteBecause,
    policy: FRESHNESS_POLICY,
  };
}

/**
 * Czy wolno pokazać „brak spraw".
 *
 * Cienka nakładka na `completeView` z kontraktu. Zostaje pod starą nazwą dla
 * kolejki, ale NIE ma prawa mieć własnej reguły: dwie reguły to dokładnie ten
 * błąd, który tu naprawiamy.
 */
export function mayReportEmptyQueue(freshness: ChannelHealth): boolean {
  return freshness.completeView;
}
