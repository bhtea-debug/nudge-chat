import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fromPackageRoot } from "../paths.js";
import {
  OPEN_STATUSES,
  OWNER_ONLY_STATUSES,
  type ChangeSet,
  type FolderCheckpoint,
  type Issue,
  type IssueCategory,
  type IssuePatch,
  type IssuePriority,
  type IssueStatus,
  type SeenEntry,
  type SourceRef,
  type StateEvent,
} from "./types.js";

/**
 * Trwały stan Copilota jako dziennik zdarzeń w JSONL.
 *
 * Dlaczego dziennik, a nie baza:
 *  - dwa procesy dopisują (monitor w tle i adapter MCP) — dopisanie do pliku
 *    otwartego w trybie append jest atomowe, więc nie potrzeba blokad,
 *  - właściciel może to przeczytać zwykłym `cat` i zobaczyć, dlaczego sprawa
 *    wygląda tak, jak wygląda; snapshot sam tej odpowiedzi nie da,
 *  - zero zależności i zero wdrożenia — awaria stanu nie może zatrzymać firmy,
 *    a im mniej ruchomych części, tym mniejsza szansa tej awarii.
 *
 * Odtwarzamy CAŁY dziennik przy każdym otwarciu. Przy skali „kilkanaście spraw
 * i kilka tysięcy wiadomości rocznie" to milisekundy, a kompakcja trzyma plik
 * w rozmiarze. Gdyby to kiedyś przestało wystarczać, zmiana dotknie tego
 * jednego pliku.
 */

const DEFAULT_DIR = "state";
const LOG = "events.jsonl";
/** Powyżej tej liczby zdarzeń kompaktujemy dziennik do jednego snapshotu. */
const COMPACT_ABOVE = 4_000;

export interface StoreOptions {
  /** Katalog stanu. Ścieżka relatywna liczona od katalogu pakietu, nie od cwd. */
  readonly dir?: string;
  /** Kto zapisuje — trafia do historii sprawy. */
  readonly actor: string;
}

export class CopilotStore {
  private readonly logPath: string;
  private readonly actor: string;

  private issues = new Map<string, Issue>();
  private seen = new Map<string, SeenEntry>();
  private folders = new Map<string, FolderCheckpoint>();
  /** Domeny, do których kiedykolwiek pisaliśmy. Z folderu wysłanych. */
  private knownDomains = new Set<string>();
  private knownDomainsAt: string | null = null;
  private eventCount = 0;
  /** Niepuste, gdy dziennik miał linie, których nie dało się odczytać. */
  private readonly damaged: string[] = [];

  constructor(opts: StoreOptions) {
    this.logPath = join(fromPackageRoot(opts.dir ?? DEFAULT_DIR), LOG);
    this.actor = opts.actor;
    mkdirSync(dirname(this.logPath), { recursive: true });
    this.replay();
  }

  // ── odtwarzanie ────────────────────────────────────────────────────────────

  private replay(): void {
    if (!existsSync(this.logPath)) return;
    const raw = readFileSync(this.logPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: StateEvent;
      try {
        ev = JSON.parse(line) as StateEvent;
      } catch {
        // Przerwany zapis to jedna zła linia, nie powód, żeby stracić resztę.
        // Ale liczymy je — cicha utrata stanu byłaby gorsza niż widoczna.
        this.damaged.push(line.slice(0, 120));
        continue;
      }
      this.apply(ev);
      this.eventCount += 1;
    }
  }

  private apply(ev: StateEvent): void {
    switch (ev.t) {
      case "snapshot":
        this.issues = new Map(ev.issues.map((i) => [i.id, i]));
        this.seen = new Map(ev.seen);
        this.folders = new Map(ev.folders.map((f) => [f.folder, f]));
        this.knownDomains = new Set(ev.knownDomains ?? []);
        this.knownDomainsAt = ev.knownDomainsAt ?? null;
        return;
      case "known_domains":
        for (const d of ev.domains) this.knownDomains.add(d);
        this.knownDomainsAt = ev.at;
        return;
      case "issue_created":
        this.issues.set(ev.issue.id, ev.issue);
        return;
      case "issue_patched": {
        const cur = this.issues.get(ev.id);
        if (!cur) return;
        this.issues.set(ev.id, {
          ...cur,
          ...ev.patch,
          updatedAt: ev.at,
          history: [...cur.history, { at: ev.at, what: ev.why, by: ev.by }],
        });
        return;
      }
      case "issue_source_added": {
        const cur = this.issues.get(ev.id);
        if (!cur) return;
        if (cur.sourceRefs.some((r) => r.messageId === ev.ref.messageId)) return;
        this.issues.set(ev.id, {
          ...cur,
          sourceRefs: [...cur.sourceRefs, ev.ref],
          updatedAt: ev.at,
          history: [...cur.history, { at: ev.at, what: ev.why, by: this.actor }],
        });
        return;
      }
      case "issue_presented":
        for (const id of ev.ids) {
          const cur = this.issues.get(id);
          // Pokazanie NIE jest zmianą sprawy — nie rusza updatedAt i nie wchodzi
          // do historii. Inaczej samo przeczytanie raportu wyglądałoby jak zmiana
          // i sprawa wracałaby w następnej delcie.
          if (cur) this.issues.set(id, { ...cur, lastPresentedAt: ev.at });
        }
        return;
      case "message_seen":
        this.seen.set(ev.messageId, { at: ev.at, issueId: ev.issueId, folder: ev.folder });
        return;
      case "checkpoint":
        this.folders.set(ev.checkpoint.folder, ev.checkpoint);
        return;
    }
  }

  private write(ev: StateEvent): void {
    this.apply(ev);
    this.eventCount += 1;
    appendFileSync(this.logPath, JSON.stringify(ev) + "\n", "utf8");
  }

  // ── odczyt ─────────────────────────────────────────────────────────────────

  /** Ostrzeżenie o uszkodzonym dzienniku. `null` = wszystko w porządku. */
  integrityWarning(): string | null {
    return this.damaged.length === 0
      ? null
      : `${this.damaged.length} nieczytelnych wpisów w dzienniku stanu — część historii mogła zniknąć`;
  }

  all(): Issue[] {
    return [...this.issues.values()];
  }

  get(id: string): Issue | null {
    return this.issues.get(id) ?? null;
  }

  /** Czy tę wiadomość już kiedykolwiek widzieliśmy — w DOWOLNYM folderze. */
  hasSeen(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  seenEntry(messageId: string): SeenEntry | null {
    return this.seen.get(messageId) ?? null;
  }

  checkpoint(folder: string): FolderCheckpoint {
    return (
      this.folders.get(folder) ?? {
        folder,
        processedThrough: null,
        lastScanAt: null,
        lastOkScanAt: null,
        lastError: null,
        messagesSeen: 0,
      }
    );
  }

  /** Czy pisaliśmy kiedykolwiek do tej domeny. */
  isKnownDomain(domain: string | null): boolean {
    return domain !== null && this.knownDomains.has(domain.toLowerCase());
  }

  knownDomainCount(): number {
    return this.knownDomains.size;
  }

  /** Kiedy ostatnio odświeżyliśmy listę z folderu wysłanych. */
  knownDomainsRefreshedAt(): string | null {
    return this.knownDomainsAt;
  }

  rememberKnownDomains(domains: readonly string[], at?: string): void {
    const fresh = domains.map((d) => d.toLowerCase()).filter((d) => d && !this.knownDomains.has(d));
    // Zapisujemy tylko NOWE domeny — inaczej dziennik rósłby o kilkaset wpisów
    // przy każdym odświeżeniu, nic nie zmieniając.
    this.write({ t: "known_domains", at: at ?? new Date().toISOString(), domains: fresh });
  }

  checkpoints(): FolderCheckpoint[] {
    return [...this.folders.values()];
  }

  /** Najnowszy udany skan któregokolwiek folderu. Bez tego „nic nowego" kłamie. */
  lastOkScanAt(): string | null {
    const times = this.checkpoints()
      .map((c) => c.lastOkScanAt)
      .filter((t): t is string => t !== null)
      .sort();
    return times.at(-1) ?? null;
  }

  openIssues(filter?: {
    status?: readonly IssueStatus[];
    category?: readonly IssueCategory[];
    priority?: readonly IssuePriority[];
    since?: string;
  }): Issue[] {
    const statuses = filter?.status ?? OPEN_STATUSES;
    return this.all()
      .filter((i) => statuses.includes(i.status))
      .filter((i) => !filter?.category || filter.category.includes(i.category))
      .filter((i) => !filter?.priority || filter.priority.includes(i.priority))
      .filter((i) => !filter?.since || i.updatedAt >= filter.since)
      .sort(byUrgency);
  }

  /**
   * Delta. Zwraca WYŁĄCZNIE to, co się zmieniło od podanego momentu.
   *
   * Sprawa pokazana wcześniej wraca do delty tylko wtedy, gdy naprawdę się
   * zmieniła po pokazaniu (`updatedAt > lastPresentedAt`) — samo obejrzenie jej
   * nie liczy się jako zmiana. To jest cała różnica między „co nowego" i
   * „pokaż mi znowu to samo".
   */
  changesSince(since: string, now: string): ChangeSet {
    const changed = this.all().filter((i) => i.updatedAt > since);
    const newIssues = changed.filter((i) => i.createdAt > since).sort(byUrgency);
    const newIds = new Set(newIssues.map((i) => i.id));

    const updatedIssues = changed
      .filter((i) => !newIds.has(i.id))
      .filter((i) => i.lastPresentedAt === null || i.updatedAt > i.lastPresentedAt)
      .sort(byUrgency);

    const statusChanges = changed
      .flatMap((i) =>
        i.history
          .filter((h) => h.at > since && h.what.startsWith("status:"))
          .map((h) => ({ id: i.id, title: i.title, status: i.status, at: h.at, what: h.what })),
      )
      .sort((a, b) => a.at.localeCompare(b.at));

    const probablyResolved = changed
      .filter((i) => i.status === "probably_resolved")
      .sort(byUrgency);

    const lastScan = this.lastOkScanAt();
    // „Nic nowego" znaczy coś zupełnie innego, gdy monitor nie działa od godzin.
    const staleNote =
      lastScan === null
        ? "Monitor poczty nie wykonał jeszcze ani jednego udanego skanu — brak zmian NIE znaczy, że nic nie przyszło."
        : minutesBetween(lastScan, now) > 90
          ? `Ostatni udany skan poczty: ${lastScan}. To ponad półtorej godziny temu — brak zmian może wynikać z niedziałającego monitora, nie ze spokojnej skrzynki.`
          : null;

    return {
      since,
      now,
      newIssues,
      updatedIssues,
      statusChanges,
      probablyResolved,
      nothingNew:
        newIssues.length === 0 && updatedIssues.length === 0 && statusChanges.length === 0,
      lastScanAt: lastScan,
      staleNote,
    };
  }

  // ── zapis: monitor w tle ───────────────────────────────────────────────────

  createIssue(input: {
    title: string;
    summary: string;
    category: IssueCategory;
    priority: IssuePriority;
    status: IssueStatus;
    classifier?: "deterministic" | "model";
    whyListed?: string;
    likelyIrrelevant?: boolean;
    ref: SourceRef;
    relatedOrderRefs?: readonly string[];
    relatedProductRefs?: readonly string[];
    waitingFor?: string | null;
    notificationCandidate?: boolean;
    notificationReason?: string | null;
    at?: string;
  }): Issue {
    const at = input.at ?? new Date().toISOString();
    const status = this.guardStatus(input.status);
    const issue: Issue = {
      id: `spr_${randomUUID().slice(0, 8)}`,
      createdAt: at,
      updatedAt: at,
      source: "mail",
      sourceRefs: [input.ref],
      title: input.title,
      summary: input.summary,
      category: input.category,
      priority: input.priority,
      status,
      classifier: input.classifier ?? "deterministic",
      whyListed: input.whyListed ?? "",
      likelyIrrelevant: input.likelyIrrelevant ?? false,
      relatedOrderRefs: [...(input.relatedOrderRefs ?? [])],
      relatedProductRefs: [...(input.relatedProductRefs ?? [])],
      lastEvidenceAt: null,
      lastErpSummary: null,
      waitingFor: input.waitingFor ?? null,
      lastPresentedAt: null,
      notificationCandidate: input.notificationCandidate ?? false,
      notificationReason: input.notificationReason ?? null,
      history: [{ at, what: `utworzona ze wiadomości ${input.ref.messageId}`, by: this.actor }],
    };
    this.write({ t: "issue_created", at, issue });
    return issue;
  }

  patchIssue(id: string, patch: IssuePatch, why: string, at?: string): void {
    if (!this.issues.has(id)) return;
    const safe = { ...patch };
    if (safe.status) safe.status = this.guardStatus(safe.status);
    this.write({
      t: "issue_patched",
      at: at ?? new Date().toISOString(),
      id,
      patch: safe,
      why,
      by: this.actor,
    });
  }

  addSource(id: string, ref: SourceRef, why: string, at?: string): void {
    this.write({
      t: "issue_source_added",
      at: at ?? new Date().toISOString(),
      id,
      ref,
      why,
    });
  }

  markMessageSeen(messageId: string, folder: string, issueId: string | null, at?: string): void {
    this.write({
      t: "message_seen",
      at: at ?? new Date().toISOString(),
      messageId,
      issueId,
      folder,
    });
  }

  saveCheckpoint(cp: FolderCheckpoint, at?: string): void {
    this.write({ t: "checkpoint", at: at ?? new Date().toISOString(), checkpoint: cp });
  }

  // ── zapis: adapter (co już pokazaliśmy) ────────────────────────────────────

  /**
   * Zapisuje, że te sprawy zostały właścicielowi przedstawione.
   *
   * Woła to ADAPTER po udanej odpowiedzi, nie capability. Capability pozostaje
   * czystym odczytem (`effectClass: "read"`) — dokładnie tak, jak zapis do
   * audytu jest efektem ubocznym rejestru, a nie zapisem w domenie. Gdyby
   * capability sama to zapisywała, „read-only" przestałoby być prawdą.
   */
  markPresented(ids: readonly string[], to: string, at?: string): void {
    if (ids.length === 0) return;
    this.write({ t: "issue_presented", at: at ?? new Date().toISOString(), ids: [...ids], to });
  }

  // ── zapis: decyzja człowieka ───────────────────────────────────────────────

  /**
   * Zamknięcie sprawy przez właściciela. Jedyna droga do statusu `resolved`.
   * Operator w tle tej drogi nie ma — patrz guardStatus.
   */
  ownerResolve(id: string, note: string, at?: string): boolean {
    if (!this.issues.has(id)) return false;
    this.write({
      t: "issue_patched",
      at: at ?? new Date().toISOString(),
      id,
      patch: { status: "resolved" },
      why: `status: zamknięta przez właściciela${note ? ` — ${note}` : ""}`,
      by: "wlasciciel",
    });
    return true;
  }

  /**
   * Model nie ma prawa uznać sprawy za definitywnie zamkniętą. Najdalej
   * `probably_resolved` — potwierdza człowiek. Wymuszone tutaj, nie w promptcie,
   * bo prompt można obejść przypadkiem, a tę funkcję trzeba obejść świadomie.
   */
  private guardStatus(status: IssueStatus): IssueStatus {
    if (OWNER_ONLY_STATUSES.includes(status) && this.actor !== "wlasciciel") {
      return "probably_resolved";
    }
    return status;
  }

  // ── kompakcja ──────────────────────────────────────────────────────────────

  /**
   * Zwija dziennik do jednego snapshotu. Wołane wyłącznie z monitora (jeden
   * pisarz), bo przepisanie pliku nie jest atomowe wobec dopisywania.
   */
  compactIfNeeded(): boolean {
    if (this.eventCount < COMPACT_ABOVE) return false;
    const at = new Date().toISOString();
    const snapshot: StateEvent = {
      t: "snapshot",
      at,
      issues: this.all(),
      seen: [...this.seen.entries()],
      folders: this.checkpoints(),
      knownDomains: [...this.knownDomains],
      knownDomainsAt: this.knownDomainsAt,
    };
    const tmp = `${this.logPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot) + "\n", "utf8");
    renameSync(tmp, this.logPath);
    this.eventCount = 1;
    return true;
  }
}

/** Kolejność, w jakiej właściciel chce to widzieć: pilne i świeże na górze. */
function byUrgency(a: Issue, b: Issue): number {
  const cat = ["urgent", "decision", "reply", "monitor", "informational"];
  const pri = ["high", "normal", "low"];
  return (
    cat.indexOf(a.category) - cat.indexOf(b.category) ||
    pri.indexOf(a.priority) - pri.indexOf(b.priority) ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

function minutesBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 60_000;
}
