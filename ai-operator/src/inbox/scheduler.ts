import type { InboxRuntime, TickReport } from "./runtime.js";

/**
 * Scheduler synchronizacji kanału.
 *
 * Istnieje, bo `tick()` bez tego pliku był funkcją, której nikt nie wołał:
 * cała trwała synchronizacja stała w miejscu, a health i tak pokazywał kolejkę.
 * To jest dokładnie ten rodzaj awarii, przed którym ma chronić reszta modułu —
 * wygląda jak działanie, a nie jest.
 *
 * Cztery właściwości, które ten scheduler musi mieć:
 *  1. przebiegi się nie nakładają — dwa równoległe ticki na jednym pliku stanu
 *     dublują pobrania i ścigają się o kursor,
 *  2. pierwszy przebieg jest opóźniony, żeby health po starcie nie czekał na IMAP,
 *  3. zamknięcie czeka na trwający przebieg zamiast ucinać go w połowie partii,
 *  4. stan schedulera jest widoczny w health, bo „nie ma nowych spraw" i „nic
 *     się nie synchronizuje" wyglądają identycznie.
 */

export interface SchedulerState {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly startedAt: number | null;
  readonly lastRunStartedAt: number | null;
  /** Ostatni przebieg, który przeszedł CAŁĄ pętlę źródeł bez wyjątku. */
  readonly lastFullRunFinishedAt: number | null;
  readonly lastRunDurationMs: number | null;
  readonly consecutiveErrors: number;
  readonly lastError: string | null;
  readonly skippedOverlaps: number;
  readonly runs: number;
}

export interface SchedulerOptions {
  readonly runtime: InboxRuntime;
  readonly firstDelayMs: number;
  readonly intervalMs: number;
  /** Wołane po każdym przebiegu. Służy logowaniu; nie może rzucać. */
  readonly onRun?: (report: TickReport | null, error: Error | null) => void;
  readonly now?: () => number;
}

export class InboxScheduler {
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private readonly controller = new AbortController();

  private startedAt: number | null = null;
  private lastRunStartedAt: number | null = null;
  private lastFullRunFinishedAt: number | null = null;
  private lastRunDurationMs: number | null = null;
  private consecutiveErrors = 0;
  private lastError: string | null = null;
  private skippedOverlaps = 0;
  private runs = 0;

  constructor(private readonly options: SchedulerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.now();
    this.firstTimer = setTimeout(() => void this.runOnce(), this.options.firstDelayMs);
    this.firstTimer.unref?.();
    this.timer = setInterval(() => void this.runOnce(), this.options.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Jeden przebieg. Nakładający się wywołanie jest POLICZONE i pominięte,
   * nie skolejkowane: kolejka opóźnionych ticków po dłuższej awarii źródła
   * zamienia się w lawinę pobrań w chwili, gdy źródło wraca.
   */
  async runOnce(): Promise<TickReport | null> {
    if (this.stopped) return null;
    if (this.inFlight) {
      this.skippedOverlaps += 1;
      return null;
    }

    const startedAt = this.now();
    this.lastRunStartedAt = startedAt;
    let report: TickReport | null = null;
    let failure: Error | null = null;

    const run = (async () => {
      try {
        report = await this.options.runtime.tick(startedAt, this.controller.signal);
        // Pełny przebieg = pętla po wszystkich źródłach zakończona bez wyjątku.
        // Pojedyncze źródło mogło zgłosić błąd; to widać w jego własnym zdrowiu.
        this.lastFullRunFinishedAt = this.now();
        this.consecutiveErrors = 0;
        this.lastError = null;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        this.consecutiveErrors += 1;
        this.lastError = sanitize(failure.message);
      } finally {
        this.lastRunDurationMs = this.now() - startedAt;
        this.runs += 1;
        this.inFlight = null;
      }
    })();

    this.inFlight = run;
    await run;
    this.options.onRun?.(report, failure);
    return report;
  }

  /** Zatrzymanie: timery gasną, a trwający przebieg dostaje szansę dokończyć. */
  async stop(graceMs = 8_000): Promise<void> {
    this.stopped = true;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    if (this.timer) clearInterval(this.timer);
    this.firstTimer = null;
    this.timer = null;
    if (!this.inFlight) return;

    // Przerwanie partii w połowie jest bezpieczne (kursor stoi), ale kosztuje
    // powtórne pobranie. Dajemy przebiegowi dokończyć, zanim go przerwiemy.
    const timeout = new Promise<void>((resolve) => {
      const handle = setTimeout(() => {
        this.controller.abort();
        resolve();
      }, graceMs);
      handle.unref?.();
    });
    await Promise.race([this.inFlight, timeout]);
  }

  state(): SchedulerState {
    return {
      enabled: true,
      running: this.inFlight !== null,
      startedAt: this.startedAt,
      lastRunStartedAt: this.lastRunStartedAt,
      lastFullRunFinishedAt: this.lastFullRunFinishedAt,
      lastRunDurationMs: this.lastRunDurationMs,
      consecutiveErrors: this.consecutiveErrors,
      lastError: this.lastError,
      skippedOverlaps: this.skippedOverlaps,
      runs: this.runs,
    };
  }
}

export const DISABLED_SCHEDULER_STATE: SchedulerState = {
  enabled: false,
  running: false,
  startedAt: null,
  lastRunStartedAt: null,
  lastFullRunFinishedAt: null,
  lastRunDurationMs: null,
  consecutiveErrors: 0,
  lastError: null,
  skippedOverlaps: 0,
  runs: 0,
};

function sanitize(message: string): string {
  return message
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[adres]")
    .replace(/\b(?:Bearer|token|password|secret)\S*/gi, "[sekret]")
    .replace(/https?:\/\/\S+/g, "[adres]")
    .slice(0, 200);
}
