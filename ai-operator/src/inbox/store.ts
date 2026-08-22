import { join } from "node:path";
import { fromPackageRoot } from "../paths.js";
import { Journal, type JournalDamage } from "./journal.js";
import {
  CLASSIFIER_VERSION,
  type ClassificationReason,
  type InboxCase,
  type InboxMessage,
  type SourceHealth,
  type SourceKey,
  sourceKeyString,
} from "./contract.js";
import { messageDedupKey } from "./ids.js";

/**
 * Trwały stan kolejki obsługi klienta.
 *
 * Dziennik JSONL z odtwarzaniem i kompakcją, tak jak `state/store.ts`: dwa
 * procesy dopisują (tick synchronizacji i obsługa webhooka), a dopisanie do
 * pliku otwartego w trybie append jest atomowe, więc nie potrzeba blokad.
 *
 * Najważniejsza właściwość tego pliku nie jest wydajnościowa, tylko
 * niezawodnościowa: wiadomość jest zapisana ZANIM cokolwiek ją oceni, i kursor
 * źródła przesuwa się dopiero po trwałym zapisie całej partii. Awaria między
 * jednym a drugim powtarza partię (dedup ją wchłania), ale nigdy jej nie gubi.
 */

/**
 * Zdarzenia wymuszane na dysk natychmiast.
 *
 * Kursor, bo po jego przesunięciu nie wrócimy już po tamte wiadomości.
 * Ledger wysyłki, bo jego utrata znaczy albo zgubioną, albo podwójną
 * odpowiedź u klienta. Zdrowie, bo alarm integralności ma przeżyć restart.
 * Wiadomości i sprawy nie: ich utrata przed wymuszeniem kończy się co najwyżej
 * powtórnym pobraniem, a `fsync` opróżnia cały bufor pliku, więc zapis kursora
 * utrwala też całą poprzedzającą go partię.
 */
const DURABLE_EVENTS = new Set(["cursor", "outbound", "health", "webhook"]);

const DEFAULT_DIR = "state";
const LOG = "inbox.jsonl";
const COMPACT_ABOVE = 20_000;

export type OutboundStatus = "prepared" | "sending" | "sent" | "failed" | "uncertain" | "cancelled";

/**
 * Ledger wysyłki. Powstaje PRZED pierwszym requestem, żeby restart w połowie
 * nie zostawił wysłanej wiadomości bez śladu, ani śladu bez wiadomości.
 */
export interface OutboundAttempt {
  readonly requestId: string;
  readonly caseId: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly externalConversationId: string;
  readonly contentSha256: string;
  readonly contentLength: number;
  /** Marker ostatniej wiadomości klienta w chwili przygotowania. */
  readonly expectedLastIncomingMessageId: string | null;
  readonly expectedLastIncomingAt: number | null;
  /** Klucz idempotencji dostawcy. Deterministyczny z requestId, nie losowy. */
  readonly idempotencyKey: string;
  status: OutboundStatus;
  externalMessageId: string | null;
  postStartedAt: number | null;
  completedAt: number | null;
  failureCode: string | null;
  createdAt: number;
  /** Potwierdzenie dostarczenia z webhooka dostawcy. */
  deliveryState: "unknown" | "delivered" | "bounced" | "complained" | "failed";
}

export interface StoredCase extends InboxCase {
  /** Ostatnia zapisana ocena. Reklasyfikacja porównuje wersję z tą wartością. */
  readonly classifierVersion: number;
}

interface CursorRecord {
  readonly sourceKey: string;
  /** Nieprzejrzysty kursor dostawcy. IMAP: `${uidValidity}:${uid}`. */
  readonly cursor: string;
  readonly committedAt: number;
}

type Event =
  | { readonly t: "message"; readonly at: number; readonly message: InboxMessage }
  | { readonly t: "webhook"; readonly at: number; readonly id: string }
  | { readonly t: "case"; readonly at: number; readonly value: StoredCase }
  | { readonly t: "cursor"; readonly at: number; readonly value: CursorRecord }
  | { readonly t: "health"; readonly at: number; readonly value: SourceHealth }
  | { readonly t: "outbound"; readonly at: number; readonly value: OutboundAttempt }
  | { readonly t: "snapshot"; readonly at: number; readonly value: Snapshot };

interface Snapshot {
  readonly webhookSeen?: Array<[string, number]>;
  readonly messages: InboxMessage[];
  readonly cases: StoredCase[];
  readonly cursors: CursorRecord[];
  readonly health: SourceHealth[];
  readonly outbound: OutboundAttempt[];
}

export interface InboxStoreOptions {
  readonly dir?: string;
  /**
   * Próg kompakcji. Istnieje, żeby kompakcja była testowalna: bez tego
   * jedyny sposób jej sprawdzenia to wygenerowanie dwudziestu tysięcy zdarzeń,
   * czyli ścieżka, której nikt nie uruchomi.
   */
  readonly compactAbove?: number;
}

export class InboxStore {
  private readonly journal: Journal;
  private readonly logPath: string;

  private readonly messages = new Map<string, InboxMessage>();
  private readonly cases = new Map<string, StoredCase>();
  private readonly cursors = new Map<string, CursorRecord>();
  private readonly health = new Map<string, SourceHealth>();
  private readonly outbound = new Map<string, OutboundAttempt>();
  /**
   * Zdarzenia webhooka już przetworzone.
   *
   * TRWALE, nie w pamięci: dostawca ponawia doręczenie, a restart procesu
   * kasował dotychczasową pamięć i to samo zdarzenie wykonywało efekt drugi
   * raz. Przy potwierdzeniach dostarczenia to niegroźne, przy każdym
   * przyszłym zdarzeniu ze skutkiem — już nie.
   */
  private readonly webhookSeen = new Map<string, number>();
  private eventCount = 0;
  private damage: JournalDamage | null = null;
  private readonly compactAbove: number;

  constructor(opts: InboxStoreOptions = {}) {
    this.compactAbove = opts.compactAbove ?? COMPACT_ABOVE;
    this.logPath = join(fromPackageRoot(opts.dir ?? DEFAULT_DIR), LOG);
    this.journal = new Journal(this.logPath);
    this.replay();
  }

  // ── odtwarzanie ────────────────────────────────────────────────────────────

  private replay(): void {
    // Naprawa dzieje się TU, przed pierwszym dopisaniem. Gdyby uszkodzony ogon
    // został, następny append dokleiłby się do niego i przy kolejnym restarcie
    // zniknęłyby obie części — razem z wiadomością, za którą stoi już kursor.
    const result = this.journal.replay<Event>((line) => JSON.parse(line) as Event);
    for (const event of result.events) {
      this.apply(event);
      this.eventCount += 1;
    }
    this.damage = result.damage;
    if (result.damage) this.recordIntegrityAlarm(result.damage);
  }

  /**
   * Alarm integralności jako TRWAŁY rekord zdrowia.
   *
   * Tablica w pamięci ginie razem z procesem, a to jest dokładnie ten rodzaj
   * problemu, który trzeba zobaczyć po restarcie. Alarm zostaje, dopóki
   * człowiek go nie zdejmie — sam z siebie nie znika.
   */
  private recordIntegrityAlarm(damage: JournalDamage): void {
    const health: SourceHealth = {
      provider: "store",
      accountKey: "integrity",
      label: "Dziennik kanału",
      state: "error",
      active: true,
      lastSuccessfulSyncAt: null,
      lastAttemptAt: damage.detectedAt,
      nextAttemptAt: null,
      consecutiveFailures: damage.lines,
      message: `uszkodzone wpisy dziennika: ${damage.lines}; wymaga sprawdzenia`,
    };
    this.write({ t: "health", at: damage.detectedAt, value: health });
  }

  /** Zdjęcie alarmu integralności. Wyłącznie świadoma decyzja człowieka. */
  acknowledgeIntegrityAlarm(now: number): boolean {
    const key = { provider: "store", accountKey: "integrity" };
    if (!this.getHealth(key)) return false;
    this.write({
      t: "health",
      at: now,
      value: {
        provider: "store",
        accountKey: "integrity",
        label: "Dziennik kanału",
        state: "ok",
        active: false,
        lastSuccessfulSyncAt: now,
        lastAttemptAt: now,
        nextAttemptAt: null,
        consecutiveFailures: 0,
        message: null,
      },
    });
    return true;
  }

  private apply(event: Event): void {
    switch (event.t) {
      case "message":
        this.messages.set(this.messageKey(event.message), event.message);
        break;
      case "case":
        this.cases.set(event.value.caseId, event.value);
        break;
      case "cursor":
        this.cursors.set(event.value.sourceKey, event.value);
        break;
      case "health":
        this.health.set(sourceKeyString(event.value), event.value);
        break;
      case "outbound":
        this.outbound.set(event.value.requestId, event.value);
        break;
      case "webhook":
        this.webhookSeen.set(event.id, event.at);
        break;
      case "snapshot":
        this.messages.clear();
        this.cases.clear();
        this.cursors.clear();
        this.health.clear();
        this.outbound.clear();
        for (const message of event.value.messages) this.messages.set(this.messageKey(message), message);
        for (const value of event.value.cases) this.cases.set(value.caseId, value);
        for (const value of event.value.cursors) this.cursors.set(value.sourceKey, value);
        for (const value of event.value.health) this.health.set(sourceKeyString(value), value);
        for (const value of event.value.outbound) this.outbound.set(value.requestId, value);
        for (const [id, at] of event.value.webhookSeen ?? []) this.webhookSeen.set(id, at);
        break;
      default: {
        // Nieznany typ zdarzenia z nowszej wersji kodu. Pomijamy zamiast
        // wysypywać proces: starsza wersja ma czytać, czego nie rozumie.
        break;
      }
    }
  }

  private messageKey(message: InboxMessage): string {
    return messageDedupKey(
      { provider: message.provider, accountKey: message.accountKey },
      message.externalMessageId,
    );
  }

  private write(event: Event): void {
    // Kolejność jest istotna: najpierw zapis do dziennika, dopiero potem
    // zmiana stanu w pamięci. Odwrotna kolejność dawałaby stan, którego
    // dziennik nie potwierdza.
    this.journal.append(JSON.stringify(event), DURABLE_EVENTS.has(event.t));
    this.apply(event);
    this.eventCount += 1;
    if (this.eventCount > this.compactAbove) this.compact();
  }

  private compact(): void {
    const snapshot: Event = {
      t: "snapshot",
      at: Date.now(),
      value: {
        messages: [...this.messages.values()],
        cases: [...this.cases.values()],
        cursors: [...this.cursors.values()],
        health: [...this.health.values()],
        outbound: [...this.outbound.values()],
        webhookSeen: [...this.webhookSeen.entries()],
      },
    };
    this.journal.rewrite([JSON.stringify(snapshot)]);
    this.eventCount = 1;
  }

  // ── wiadomości ─────────────────────────────────────────────────────────────

  /** Czy wiadomość jest już trwale zapisana. Sedno odporności na retry. */
  hasMessage(key: SourceKey, externalMessageId: string): boolean {
    return this.messages.has(messageDedupKey(key, externalMessageId));
  }

  getMessage(key: SourceKey, externalMessageId: string): InboxMessage | null {
    return this.messages.get(messageDedupKey(key, externalMessageId)) ?? null;
  }

  /**
   * Trwały claim wiadomości. Wywoływany PRZED klasyfikacją; zwraca `false`,
   * gdy rekord już był (powtórka webhooka, retry partii, restart w połowie).
   */
  claimMessage(message: InboxMessage): boolean {
    const key = this.messageKey(message);
    if (this.messages.has(key)) return false;
    this.write({ t: "message", at: Date.now(), message });
    return true;
  }

  messagesForCase(caseId: string): InboxMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.caseId === caseId)
      .sort((a, b) => (a.sourceCreatedAt ?? a.receivedAt) - (b.sourceCreatedAt ?? b.receivedAt));
  }

  allMessages(): InboxMessage[] {
    return [...this.messages.values()];
  }

  // ── sprawy ─────────────────────────────────────────────────────────────────

  getCase(caseId: string): StoredCase | null {
    return this.cases.get(caseId) ?? null;
  }

  listCases(): StoredCase[] {
    return [...this.cases.values()];
  }

  upsertCase(value: StoredCase): void {
    const existing = this.cases.get(value.caseId);
    if (existing && shallowEqualCase(existing, value)) return;
    this.write({ t: "case", at: Date.now(), value });
  }

  /**
   * Reklasyfikacja. Nie dotyka spraw ocenionych już bieżącą wersją, więc
   * powtórzony przebieg nie generuje zapisów ani nie miga w interfejsie.
   */
  casesNeedingReclassification(): StoredCase[] {
    return [...this.cases.values()].filter((value) => value.classifierVersion < CLASSIFIER_VERSION);
  }

  // ── kursory ────────────────────────────────────────────────────────────────

  getCursor(key: SourceKey): string | null {
    return this.cursors.get(sourceKeyString(key))?.cursor ?? null;
  }

  /**
   * Zatwierdzenie kursora. Wolno je wywołać dopiero, gdy CAŁA partia jest już
   * trwale zapisana — przesunięcie kursora przed zapisem to jedyny sposób,
   * żeby wiadomość zniknęła po cichu.
   */
  commitCursor(key: SourceKey, cursor: string): void {
    this.write({
      t: "cursor",
      at: Date.now(),
      value: { sourceKey: sourceKeyString(key), cursor, committedAt: Date.now() },
    });
  }

  // ── zdrowie ────────────────────────────────────────────────────────────────

  getHealth(key: SourceKey): SourceHealth | null {
    return this.health.get(sourceKeyString(key)) ?? null;
  }

  listHealth(): SourceHealth[] {
    return [...this.health.values()];
  }

  setHealth(value: SourceHealth): void {
    this.write({ t: "health", at: Date.now(), value });
  }

  // ── ledger wysyłki ─────────────────────────────────────────────────────────

  getAttempt(requestId: string): OutboundAttempt | null {
    return this.outbound.get(requestId) ?? null;
  }

  /** Aktywna próba na sprawę. Blokuje drugą wysyłkę z innym requestId. */
  activeAttemptForCase(caseId: string): OutboundAttempt | null {
    for (const attempt of this.outbound.values()) {
      if (attempt.caseId !== caseId) continue;
      if (attempt.status === "prepared" || attempt.status === "sending" || attempt.status === "uncertain") {
        return attempt;
      }
    }
    return null;
  }

  putAttempt(attempt: OutboundAttempt): void {
    this.write({ t: "outbound", at: Date.now(), value: attempt });
  }

  listAttempts(): OutboundAttempt[] {
    return [...this.outbound.values()];
  }

  /**
   * Rejestracja zdarzenia webhooka. `false` = już je widzieliśmy.
   *
   * Stare wpisy są odsiewane przy zapisie snapshotu, a nie przy każdym
   * sprawdzeniu: przegląd mapy na gorącej ścieżce webhooka kosztowałby
   * więcej niż samo zdarzenie.
   */
  acceptWebhook(id: string, now: number, ttlMs = 7 * 24 * 60 * 60_000): boolean {
    const seenAt = this.webhookSeen.get(id);
    if (seenAt !== undefined && now - seenAt <= ttlMs) return false;
    this.write({ t: "webhook", at: now, id });
    return true;
  }

  /** Niepuste, gdy dziennik miał linie nie do odczytania. Widoczne w zdrowiu. */
  damageReport(): JournalDamage | null {
    return this.damage;
  }

  /** Zamknięcie deskryptora. Używane przy shutdownie i w testach. */
  close(): void {
    this.journal.close();
  }
}

function shallowEqualCase(a: StoredCase, b: StoredCase): boolean {
  const keys = Object.keys(a) as Array<keyof StoredCase>;
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export type { ClassificationReason };
