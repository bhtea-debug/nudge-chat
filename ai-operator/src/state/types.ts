import { z } from "zod";

/**
 * Operational State — pamięć Copilota.
 *
 * To NIE jest system prawdy firmy. Prawda o zamówieniu jest w TeaBrew, prawda
 * o korespondencji jest w poczcie. Tutaj trzymamy wyłącznie to, czego żaden
 * z tych systemów nie wie: **które sprawy są otwarte i co już właścicielowi
 * pokazaliśmy**.
 *
 * Konsekwencje, które trzeba trzymać w głowie:
 *  - awaria tego stanu nie może zatrzymać poczty, TeaBrew ani sprzedaży,
 *  - treści maili tu NIE MA — są referencje i krótkie streszczenie,
 *  - zapis do TEGO stanu jest dozwolony (to nasza pamięć); zapis do systemów
 *    źródłowych pozostaje niemożliwy konstrukcyjnie.
 */

/** Pięć kategorii z zadania. Nie każda wiadomość zostaje sprawą. */
export const ISSUE_CATEGORIES = [
  "urgent",
  "decision",
  "reply",
  "monitor",
  "informational",
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const ISSUE_PRIORITIES = ["high", "normal", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/**
 * Statusy sprawy. `resolved` jest celowo osobno traktowany: model NIE MOŻE go
 * ustawić. Najdalej, na co mu wolno, to `probably_resolved` — potwierdza człowiek.
 * Wymuszone w store.ts, nie w promptcie.
 */
export const ISSUE_STATUSES = [
  "new",
  "needs_attention",
  "waiting_for_owner",
  "waiting_external",
  "monitoring",
  "probably_resolved",
  "resolved",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/** Statusy, które liczą się jako „mam to jeszcze na głowie". */
export const OPEN_STATUSES: readonly IssueStatus[] = [
  "new",
  "needs_attention",
  "waiting_for_owner",
  "waiting_external",
  "monitoring",
];

/** Status, którego operator nie ma prawa ustawić — tylko człowiek. */
export const OWNER_ONLY_STATUSES: readonly IssueStatus[] = ["resolved"];

/**
 * Referencja do źródła. Nigdy treść — sam wskaźnik plus tyle metadanych, żeby
 * człowiek i model wiedzieli, o którą wiadomość chodzi, bez otwierania poczty.
 */
export const SourceRef = z.object({
  kind: z.literal("mail"),
  /** RFC Message-ID — kanoniczny identyfikator w całym systemie. */
  messageId: z.string(),
  threadId: z.string().nullable(),
  folder: z.string(),
  date: z.string(),
  subject: z.string(),
  from: z.string().nullable(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** Wpis historii. Odpowiada na „co się z tą sprawą działo", bez treści maili. */
export const IssueChange = z.object({
  at: z.string(),
  what: z.string(),
  by: z.string(),
});
export type IssueChange = z.infer<typeof IssueChange>;

export const Issue = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  source: z.literal("mail"),
  sourceRefs: z.array(SourceRef),
  title: z.string(),
  summary: z.string(),
  category: z.enum(ISSUE_CATEGORIES),
  priority: z.enum(ISSUE_PRIORITIES),
  status: z.enum(ISSUE_STATUSES),
  relatedOrderRefs: z.array(z.string()),
  relatedProductRefs: z.array(z.string()),
  /** Kiedy ostatnio mieliśmy TWARDY dowód (wywołanie capability) w tej sprawie. */
  lastEvidenceAt: z.string().nullable(),
  /** Co TeaBrew powiedział ostatnio. Krótkie zdanie, nie kopia rekordu. */
  lastErpSummary: z.string().nullable(),
  /** Na co czekamy. Puste = nie wiadomo, i wtedy tak trzeba powiedzieć. */
  waitingFor: z.string().nullable(),
  /** Kiedy sprawa była pokazana właścicielowi. Zapisuje adapter, nie capability. */
  lastPresentedAt: z.string().nullable(),
  /** Czy to jest sytuacja warta powiadomienia na telefon. Kanał jeszcze nie istnieje. */
  notificationCandidate: z.boolean(),
  notificationReason: z.string().nullable(),
  history: z.array(IssueChange),
});
export type Issue = z.infer<typeof Issue>;

/** Pola, które operator w tle może zmienić w istniejącej sprawie. */
export type IssuePatch = Partial<
  Pick<
    Issue,
    | "title"
    | "summary"
    | "category"
    | "priority"
    | "status"
    | "relatedOrderRefs"
    | "relatedProductRefs"
    | "lastEvidenceAt"
    | "lastErpSummary"
    | "waitingFor"
    | "notificationCandidate"
    | "notificationReason"
  >
>;

/**
 * Checkpoint per folder — „dokąd bezpiecznie doszedłem".
 *
 * Świadomie NIE opieramy tożsamości wiadomości na IMAP UID: UID jest unikalny
 * tylko w obrębie folderu i zmienia się przy przeniesieniu wiadomości. Cały
 * system używa RFC Message-ID jako identyfikatora kanonicznego i checkpoint
 * robi to samo. Dzięki temu przeniesienie maila między folderami, powtórne
 * pojawienie się i duplikat nie tworzą drugiej sprawy.
 */
export const FolderCheckpoint = z.object({
  folder: z.string(),
  /** Data najnowszej przetworzonej wiadomości. Od niej startuje kolejny skan. */
  processedThrough: z.string().nullable(),
  lastScanAt: z.string().nullable(),
  lastOkScanAt: z.string().nullable(),
  lastError: z.string().nullable(),
  /** Ile wiadomości przeszło przez model w tym folderze — do rachunku kosztów. */
  messagesSeen: z.number().int().nonnegative(),
});
export type FolderCheckpoint = z.infer<typeof FolderCheckpoint>;

/**
 * Zdarzenia. Stan jest odtwarzany z dziennika, bo dziennik odpowiada na pytanie
 * „dlaczego ta sprawa tak wygląda", którego snapshot sam nie odpowie.
 */
export type StateEvent =
  | { t: "snapshot"; at: string; issues: Issue[]; seen: [string, SeenEntry][]; folders: FolderCheckpoint[] }
  | { t: "issue_created"; at: string; issue: Issue }
  | { t: "issue_patched"; at: string; id: string; patch: IssuePatch; why: string; by: string }
  | { t: "issue_source_added"; at: string; id: string; ref: SourceRef; why: string }
  | { t: "issue_presented"; at: string; ids: string[]; to: string }
  | { t: "message_seen"; at: string; messageId: string; issueId: string | null; folder: string }
  | { t: "checkpoint"; at: string; checkpoint: FolderCheckpoint };

export interface SeenEntry {
  readonly at: string;
  readonly issueId: string | null;
  readonly folder: string;
}

/** Widok, który capability zwraca dla `get_changes_since`. */
export interface ChangeSet {
  readonly since: string;
  readonly now: string;
  readonly newIssues: readonly Issue[];
  readonly updatedIssues: readonly Issue[];
  readonly statusChanges: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: IssueStatus;
    readonly at: string;
    readonly what: string;
  }[];
  readonly probablyResolved: readonly Issue[];
  readonly nothingNew: boolean;
  /** Kiedy monitor ostatnio realnie zajrzał do poczty. Bez tego „nic nowego" kłamie. */
  readonly lastScanAt: string | null;
  readonly staleNote: string | null;
}
