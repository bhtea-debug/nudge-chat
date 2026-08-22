/**
 * Zegar odpowiedzi dla źródeł spoza Allegro.
 *
 * Świadomie te same progi i ta sama semantyka, co w pilocie Allegro: jedna
 * kolejka z dwiema definicjami „pilne" byłaby gorsza od braku priorytetu,
 * bo zespół nie wiedziałby, którą wersję czyta.
 *
 * Zegar zatrzymuje się w weekend w strefie Europe/Warsaw. Wiadomość z piątku
 * po południu nie może być przeterminowana w niedzielę rano — nikt wtedy nie
 * pracuje, a czerwony alarm w poniedziałek uczy zespół ignorować kolor.
 */

export type SlaState = "ok" | "yellow" | "red" | "critical" | "overdue";
export type Priority = "P0" | "P1" | "P2";

/** Docelowy czas pierwszej merytorycznej odpowiedzi. */
const RESPONSE_BUDGET_MS = 24 * 60 * 60_000;
/** Bezwzględne maksimum, liczone czasem ciągłym, bez pauzy weekendowej. */
const ABSOLUTE_MAX_MS = 12 * 60 * 60_000;

const THRESHOLDS: ReadonlyArray<{ readonly withinMs: number; readonly state: SlaState }> = [
  { withinMs: 2 * 60 * 60_000, state: "critical" },
  { withinMs: 4 * 60 * 60_000, state: "red" },
  { withinMs: 12 * 60 * 60_000, state: "yellow" },
];

/**
 * Czy dana chwila wypada w weekend w Warszawie.
 *
 * Liczone przez `Intl`, a nie przez ręczne przesunięcie o dwie godziny:
 * przesunięcie strefy zmienia się dwa razy w roku i ręczna wersja myli się
 * w te dwa weekendy, czyli dokładnie wtedy, gdy nikt tego nie sprawdza.
 */
function isWeekendInWarsaw(at: number): boolean {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Warsaw",
    weekday: "short",
  }).format(new Date(at));
  return day === "Sat" || day === "Sun";
}

/**
 * Czas roboczy między dwiema chwilami, z pominięciem weekendów.
 *
 * Krok godzinny wystarcza: zegar odpowiedzi ma progi w godzinach, więc
 * dokładność do minuty niczego nie zmienia, a pełne przejście po minutach
 * przy sprawie sprzed miesiąca to kilkadziesiąt tysięcy iteracji na rekord.
 */
export function businessElapsedMs(from: number, to: number): number {
  if (to <= from) return 0;
  const HOUR = 60 * 60_000;
  let elapsed = 0;
  let cursor = from;
  while (cursor < to) {
    const step = Math.min(HOUR, to - cursor);
    if (!isWeekendInWarsaw(cursor)) elapsed += step;
    cursor += step;
  }
  return elapsed;
}

export interface SlaResult {
  readonly state: SlaState | null;
  readonly priority: Priority | null;
  readonly responseDueAt: number | null;
  /** Twarde maksimum od początku oczekiwania, czasem ciągłym. */
  readonly serviceMaxAt: number | null;
  readonly waitingMs: number | null;
}

export interface SlaInput {
  readonly waitingSince: number | null;
  readonly requiresResponse: boolean;
  readonly pendingAction: boolean;
  readonly now: number;
  /** Sprawa oznaczona do weryfikacji nie dostaje priorytetu P0 „na zapas". */
  readonly needsReview?: boolean;
}

/**
 * Stan zegara dla jednej sprawy.
 *
 * Sprawa bez wymaganej odpowiedzi NIE ma zegara — także wtedy, gdy czeka na
 * realizację. Naliczanie SLA odpowiedzi na zobowiązanie wysyłkowe pokazywałoby
 * czerwony alarm za to, że paczka jedzie.
 */
export function evaluateSla(input: SlaInput): SlaResult {
  if (!input.requiresResponse || input.waitingSince === null) {
    return {
      state: null,
      priority: input.pendingAction ? "P2" : null,
      responseDueAt: null,
      serviceMaxAt: input.waitingSince === null ? null : input.waitingSince + ABSOLUTE_MAX_MS,
      waitingMs: null,
    };
  }

  const worked = businessElapsedMs(input.waitingSince, input.now);
  const remaining = RESPONSE_BUDGET_MS - worked;

  let state: SlaState = "ok";
  if (remaining <= 0) state = "overdue";
  else {
    for (const threshold of THRESHOLDS) {
      if (remaining <= threshold.withinMs) {
        state = threshold.state;
        break;
      }
    }
  }

  // Priorytet wynika ze stanu zegara, a nie z osobnej, rozjeżdżającej się skali.
  const priority: Priority =
    state === "overdue" || state === "critical" || state === "red"
      ? "P0"
      : state === "yellow"
        ? "P1"
        : "P2";

  return {
    state,
    priority: input.needsReview && priority === "P0" ? "P1" : priority,
    // Termin liczony czasem roboczym: budżet minus to, co już upłynęło.
    responseDueAt: input.now + Math.max(0, remaining),
    serviceMaxAt: input.waitingSince + ABSOLUTE_MAX_MS,
    waitingMs: Math.max(0, input.now - input.waitingSince),
  };
}
