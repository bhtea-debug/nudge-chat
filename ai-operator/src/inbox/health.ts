import {
  FRESHNESS_POLICY,
  overallFreshness,
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
  readonly policy: typeof FRESHNESS_POLICY;
}

export function channelFreshness(store: InboxStore, now: number): ChannelFreshness {
  const sources = store.listHealth();
  const overall = overallFreshness(sources, now);
  return {
    state: overall.state,
    oldestSuccessAt: overall.oldestSuccessAt,
    ageMs: overall.ageMs,
    sources: [...sources].sort((a, b) => `${a.provider}${a.accountKey}`.localeCompare(`${b.provider}${b.accountKey}`)),
    degraded: overall.degradedSources.length > 0,
    degradedSources: overall.degradedSources,
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
