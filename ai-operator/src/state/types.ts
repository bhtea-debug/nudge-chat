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
 * Skąd sprawa się dowiedziała o świecie. Właściciela to nie interesuje w UI —
 * interesuje go, co się dzieje. Ale system musi wiedzieć, bo od źródła zależy,
 * czym dociągnąć treść i czego NIE wolno twierdzić.
 */
export const SOURCE_KINDS = ["mail", "connecteam"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Referencja do źródła. Nigdy treść — sam wskaźnik plus tyle metadanych, żeby
 * człowiek i model wiedzieli, o którą wiadomość chodzi, bez otwierania poczty.
 *
 * Pole `messageId` jest wspólne dla wszystkich źródeł i jest KANONICZNĄ
 * tożsamością wiadomości w całym systemie: na nim stoi odsiewanie duplikatów
 * (`seen`), scalanie źródeł w sprawie i idempotencja webhooka. Dla poczty to RFC
 * Message-ID. Dla Connecteam to `ct:<konwersacja>:<wiadomość>` — prefiks jest
 * konieczny, bo identyfikatory z dwóch różnych systemów mogą się zderzyć, a
 * zderzenie oznaczałoby ciche zgubienie jednej z wiadomości.
 */
const MailRef = z.object({
  kind: z.literal("mail"),
  /** RFC Message-ID — kanoniczny identyfikator w całym systemie. */
  messageId: z.string(),
  threadId: z.string().nullable(),
  folder: z.string(),
  date: z.string(),
  subject: z.string(),
  from: z.string().nullable(),
});

/**
 * Wiadomość z Connecteam. `conversationId` jest tu tym, czym `threadId` w
 * poczcie — najmocniejszym sygnałem „to ta sama rozmowa".
 *
 * Zakres tego, co faktycznie wolno nam odczytać, jest ograniczony po stronie
 * dostawcy i opisany w `docs/DECYZJA-CONNECTEAM.md`. Schemat jest gotowy na
 * treść, ale kod NIE zakłada, że ją dostanie.
 */
const ConnecteamRef = z.object({
  kind: z.literal("connecteam"),
  messageId: z.string(),
  conversationId: z.string(),
  /** Nazwa czatu/kanału, jeśli dostawca ją podał. Nie zgadujemy. */
  conversationName: z.string().nullable(),
  date: z.string(),
  /** Kto napisał — nazwa widoczna w Connecteam, nie identyfikator. */
  authorName: z.string().nullable(),
  /** Podgląd treści, jeśli dostawca ją zwrócił. Puste = mamy tylko fakt zdarzenia. */
  preview: z.string(),
});

export const SourceRef = z.discriminatedUnion("kind", [MailRef, ConnecteamRef]);
export type SourceRef = z.infer<typeof SourceRef>;
export type MailSourceRef = z.infer<typeof MailRef>;
export type ConnecteamSourceRef = z.infer<typeof ConnecteamRef>;

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
  /**
   * Skąd sprawa POWSTAŁA. Nie jest to lista jej źródeł — te są w `sourceRefs`
   * i mogą pochodzić z różnych systemów. Trzymamy to osobno, bo „przyszło
   * mailem, potem produkcja dopisała w Connecteam" i „zaczęło się w Connecteam"
   * to dwie różne historie tej samej sprawy.
   */
  source: z.enum(SOURCE_KINDS),
  sourceRefs: z.array(SourceRef),
  title: z.string(),
  summary: z.string(),
  category: z.enum(ISSUE_CATEGORIES),
  priority: z.enum(ISSUE_PRIORITIES),
  status: z.enum(ISSUE_STATUSES),
  /**
   * Skąd wzięły się kategoria, priorytet i streszczenie.
   *
   * `deterministic` = z faktów: nadawca, temat, numery, odpowiedź TeaBrew.
   * Nic nie zostało przeformułowane, więc nic nie mogło zostać zmyślone — ale
   * kategoria jest wtedy słabym sygnałem, nie oceną, i Claude ma prawo ją
   * nadpisać własnym rozumowaniem.
   *
   * `model` = ocenione przez model po naszej stronie (wymaga kredytów API,
   * domyślnie wyłączone).
   */
  classifier: z.enum(["deterministic", "model"]).default("deterministic"),
  /**
   * DLACZEGO ta sprawa jest na liście i dlaczego ma taki priorytet — zdanie
   * z faktów, nie z oceny modelu.
   *
   * Powstało po uwadze właściciela, że raport „nie rozdziela spamu od
   * wiadomości, nie ma priorytetów ani wyjaśnienia". Lista bez uzasadnienia
   * zmusza go do otwarcia każdej pozycji, czyli do wykonania tej pracy, którą
   * miał zdjąć z siebie.
   */
  whyListed: z.string().default(""),
  /**
   * true = prawdopodobnie NIE korespondencja: nieznany nadawca, brak numeru
   * i brak wątku. Nie usuwamy takiej sprawy — pokazujemy ją osobno i zwiniętą,
   * bo pomyłka w tę stronę oznaczałaby ukrycie pierwszego maila od klienta.
   */
  likelyIrrelevant: z.boolean().default(false),
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
    | "whyListed"
    | "likelyIrrelevant"
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
  | {
      t: "snapshot";
      at: string;
      issues: Issue[];
      seen: [string, SeenEntry][];
      folders: FolderCheckpoint[];
      knownDomains?: string[];
      knownDomainsAt?: string | null;
    }
  /**
   * Domeny, z którymi FAKTYCZNIE korespondowaliśmy — zebrane z folderu
   * wysłanych. To najmocniejszy dostępny bez modelu sygnał „to jest kontrahent,
   * a nie wysyłka masowa", bo wynika z naszego własnego działania.
   */
  | { t: "known_domains"; at: string; domains: string[] }
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
