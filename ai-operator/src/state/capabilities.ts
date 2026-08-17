import { z } from "zod";
import type { AnyCapability, Capability } from "../capability/types.js";
import { ISSUE_CATEGORIES, ISSUE_PRIORITIES, ISSUE_STATUSES, OPEN_STATUSES } from "./types.js";
import type { CopilotStore, } from "./store.js";
import type { Issue } from "./types.js";

/**
 * Capability Copilota — pamięć spraw jako narzędzia dla Claude.
 *
 * Wszystkie są `effectClass: "read"` i to nie jest formalność: **żadna z nich
 * niczego nie zapisuje.** Zapis „to już pokazałem" wykonuje ADAPTER po wysłaniu
 * odpowiedzi, dokładnie tak, jak wpis do audytu robi rejestr. Gdyby capability
 * sama zapisywała, „read-only" przestałoby być prawdą, a testy strzegące tej
 * granicy przestałyby cokolwiek znaczyć.
 *
 * Trzy narzędzia, nie kilkadziesiąt. Czwarte (`search_issues`) jest dodane,
 * bo bez niego pytanie „co było z Rossmannem w zeszłym tygodniu" wymagałoby
 * przeglądania wszystkiego.
 */

const ISSUE_SCOPE = "issues:read" as const;

/**
 * Widok sprawy dla modelu. Świadomie BEZ historii — ta jest tylko w get_issue.
 * Lista dwudziestu spraw z pełną historią każdej to tysiące tokenów, z których
 * model użyje trzech linii.
 */
const IssueBrief = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.enum(ISSUE_CATEGORIES),
  priority: z.enum(ISSUE_PRIORITIES),
  status: z.enum(ISSUE_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  waitingFor: z.string().nullable(),
  relatedOrderRefs: z.array(z.string()),
  relatedProductRefs: z.array(z.string()),
  lastErpSummary: z.string().nullable(),
  lastEvidenceAt: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().nullable(),
  alreadyShown: z.boolean(),
  notificationCandidate: z.boolean(),
  notificationReason: z.string().nullable(),
});

const brief = (i: Issue): z.infer<typeof IssueBrief> => ({
  id: i.id,
  title: i.title,
  summary: i.summary,
  category: i.category,
  priority: i.priority,
  status: i.status,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
  waitingFor: i.waitingFor,
  relatedOrderRefs: i.relatedOrderRefs,
  relatedProductRefs: i.relatedProductRefs,
  lastErpSummary: i.lastErpSummary,
  lastEvidenceAt: i.lastEvidenceAt,
  messageCount: i.sourceRefs.length,
  lastMessageAt: i.sourceRefs.map((r) => r.date).sort().at(-1) ?? null,
  alreadyShown: i.lastPresentedAt !== null,
  notificationCandidate: i.notificationCandidate,
  notificationReason: i.notificationReason,
});

// ── get_changes_since ────────────────────────────────────────────────────────

const ChangesInput = z.object({
  since: z
    .string()
    .optional()
    .describe(
      "Moment, od którego chcesz zmiany, w ISO 8601 (np. 2026-08-18T12:00:00Z). " +
        "Pomiń, żeby dostać zmiany od ostatniego pokazania czegokolwiek.",
    ),
});

const ChangesOutput = z.object({
  since: z.string(),
  now: z.string(),
  nothingNew: z.boolean(),
  newIssues: z.array(IssueBrief),
  updatedIssues: z.array(IssueBrief),
  statusChanges: z.array(
    z.object({ id: z.string(), title: z.string(), status: z.enum(ISSUE_STATUSES), at: z.string(), what: z.string() }),
  ),
  probablyResolved: z.array(IssueBrief),
  lastScanAt: z.string().nullable(),
  /** Niepuste = „brak zmian" może wynikać z awarii monitora, nie ze spokoju. */
  staleNote: z.string().nullable(),
  integrityNote: z.string().nullable(),
});

// ── get_open_issues ──────────────────────────────────────────────────────────

const OpenInput = z.object({
  status: z.array(z.enum(ISSUE_STATUSES)).optional().describe("Domyślnie wszystkie statusy otwarte."),
  category: z.array(z.enum(ISSUE_CATEGORIES)).optional(),
  priority: z.array(z.enum(ISSUE_PRIORITIES)).optional(),
  since: z.string().optional().describe("Tylko sprawy zmienione od tego momentu (ISO 8601)."),
  limit: z.number().int().min(1).max(100).default(50),
});

const OpenOutput = z.object({
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  byStatus: z.record(z.string(), z.number().int()),
  byCategory: z.record(z.string(), z.number().int()),
  issues: z.array(IssueBrief),
  lastScanAt: z.string().nullable(),
  staleNote: z.string().nullable(),
  integrityNote: z.string().nullable(),
});

// ── get_issue ────────────────────────────────────────────────────────────────

const IssueInput = z.object({
  id: z.string().min(1).describe("Identyfikator sprawy (pole id) z get_open_issues albo get_changes_since."),
});

const IssueOutput = z.object({
  found: z.boolean(),
  issue: IssueBrief.nullable(),
  history: z.array(z.object({ at: z.string(), what: z.string(), by: z.string() })),
  /**
   * Referencje do wiadomości. To WSKAŹNIKI, nie treść — po treść model musi
   * wywołać mail_get_thread, i to jest zamierzone: dzięki temu w pamięci
   * Copilota nie leżą kopie korespondencji.
   */
  messages: z.array(
    z.object({
      messageId: z.string(),
      subject: z.string(),
      from: z.string().nullable(),
      date: z.string(),
      folder: z.string(),
    }),
  ),
  nextStep: z.string(),
});

// ── search_issues ────────────────────────────────────────────────────────────

const SearchInput = z.object({
  query: z.string().min(2).max(100).describe("Fraza szukana w tytule, streszczeniu, numerach i tematach wiadomości."),
  includeResolved: z.boolean().default(false),
  limit: z.number().int().min(1).max(50).default(20),
});

const SearchOutput = z.object({
  query: z.string(),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  issues: z.array(IssueBrief),
});

const tally = (issues: readonly Issue[], key: "status" | "category"): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of issues) out[i[key]] = (out[i[key]] ?? 0) + 1;
  return out;
};

export function createIssueCapabilities(store: () => CopilotStore): AnyCapability[] {
  const changes: Capability<z.infer<typeof ChangesInput>, z.infer<typeof ChangesOutput>> = {
    name: "copilot_get_changes_since",
    version: "1.0.0",
    description:
      "Zwraca WYŁĄCZNIE to, co zmieniło się od podanego momentu: nowe sprawy, sprawy ze zmianą, " +
      "zmiany statusów i sprawy prawdopodobnie zamknięte. Użyj tego jako PIERWSZEGO narzędzia przy " +
      "pytaniach „co nowego”, „co się zmieniło”, „co przyszło przez ostatnie dwie godziny”. " +
      "Nie powtarza rzeczy już pokazanych, o ile się nie zmieniły. " +
      "Sprawdź staleNote: jeśli jest niepusty, „brak zmian” może oznaczać awarię monitora, " +
      "a nie spokojną skrzynkę — powiedz to wprost.",
    scope: ISSUE_SCOPE,
    effectClass: "read",
    input: ChangesInput,
    output: ChangesOutput,
    auditRefs: (input, output) => ({
      since: input.since ?? "auto",
      nowe: output?.newIssues.length ?? 0,
      zmienione: output?.updatedIssues.length ?? 0,
    }),
    handler: async (input) => {
      const s = store();
      const now = new Date().toISOString();
      // Bez `since` bierzemy najpóźniejszy moment pokazania czegokolwiek —
      // czyli dokładnie „od kiedy ostatnio patrzyłeś".
      const since =
        input.since ??
        s
          .all()
          .map((i) => i.lastPresentedAt)
          .filter((t): t is string => t !== null)
          .sort()
          .at(-1) ??
        new Date(Date.now() - 24 * 3_600_000).toISOString();

      const c = s.changesSince(since, now);
      return {
        since: c.since,
        now: c.now,
        nothingNew: c.nothingNew,
        newIssues: c.newIssues.map(brief),
        updatedIssues: c.updatedIssues.map(brief),
        statusChanges: [...c.statusChanges],
        probablyResolved: c.probablyResolved.map(brief),
        lastScanAt: c.lastScanAt,
        staleNote: c.staleNote,
        integrityNote: s.integrityWarning(),
      };
    },
  };

  const open: Capability<z.infer<typeof OpenInput>, z.infer<typeof OpenOutput>> = {
    name: "copilot_get_open_issues",
    version: "1.0.0",
    description:
      "Wypisuje otwarte sprawy — to, co właścicielowi zostało na głowie. Użyj przy pytaniach " +
      "„co mi zostało”, „co wymaga mojej uwagi”, „kto czeka na odpowiedź”, „czym powinienem " +
      "zająć się teraz”. Zwraca też liczniki po statusie i kategorii, żebyś mógł podać obraz " +
      "całości jednym zdaniem przed wyliczaniem szczegółów.",
    scope: ISSUE_SCOPE,
    effectClass: "read",
    input: OpenInput,
    output: OpenOutput,
    auditRefs: (input, output) => ({
      status: (input.status ?? OPEN_STATUSES).join(","),
      count: output?.count ?? 0,
    }),
    handler: async (input) => {
      const s = store();
      const found = s.openIssues({
        ...(input.status ? { status: input.status } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.since ? { since: input.since } : {}),
      });
      const shown = found.slice(0, input.limit);
      const now = new Date().toISOString();
      const c = s.changesSince(now, now);
      return {
        count: found.length,
        truncated: found.length > shown.length,
        byStatus: tally(found, "status"),
        byCategory: tally(found, "category"),
        issues: shown.map(brief),
        lastScanAt: c.lastScanAt,
        staleNote: c.staleNote,
        integrityNote: s.integrityWarning(),
      };
    },
  };

  const detail: Capability<z.infer<typeof IssueInput>, z.infer<typeof IssueOutput>> = {
    name: "copilot_get_issue",
    version: "1.0.0",
    description:
      "Szczegóły jednej sprawy: streszczenie, historia zmian, referencje do wiadomości, powiązane " +
      "zamówienia i produkty oraz to, na co czekamy. Użyj, gdy właściciel mówi „rozwiń” albo pyta " +
      "o konkretną sprawę. Zwraca WSKAŹNIKI do wiadomości, nie ich treść — po treść wywołaj " +
      "mail_get_thread z podanym messageId, a po aktualny stan zamówienia teabrew_get_order_status. " +
      "Dane w tej sprawie mogą być sprzed godzin; jeśli mają znaczenie, sprawdź je na świeżo.",
    scope: ISSUE_SCOPE,
    effectClass: "read",
    input: IssueInput,
    output: IssueOutput,
    auditRefs: (input, output) => ({ id: input.id, found: output?.found ?? false }),
    handler: async (input) => {
      const issue = store().get(input.id);
      if (!issue) {
        return {
          found: false,
          issue: null,
          history: [],
          messages: [],
          nextStep:
            `Sprawy o identyfikatorze ${input.id} NIE MA w pamięci Copilota. ` +
            "Nie zgaduj, o co chodziło — poproś o wskazanie sprawy z get_open_issues.",
        };
      }
      return {
        found: true,
        issue: brief(issue),
        history: [...issue.history],
        messages: issue.sourceRefs
          .map((r) => ({
            messageId: r.messageId,
            subject: r.subject,
            from: r.from,
            date: r.date,
            folder: r.folder,
          }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        nextStep:
          issue.waitingFor ??
          (issue.relatedOrderRefs.length > 0
            ? `Sprawdź w TeaBrew: ${issue.relatedOrderRefs.join(", ")}`
            : "Nie wiadomo, na co czekamy — przeczytaj wątek (mail_get_thread) zamiast zakładać."),
      };
    },
  };

  const search: Capability<z.infer<typeof SearchInput>, z.infer<typeof SearchOutput>> = {
    name: "copilot_search_issues",
    version: "1.0.0",
    description:
      "Szuka wśród spraw po frazie — nazwie klienta, numerze zamówienia, produkcie. Użyj, gdy " +
      "właściciel pyta o coś, co mogło być kiedyś załatwiane. Pusty wynik znaczy „nie mam takiej " +
      "sprawy w pamięci”, a NIE „nic takiego nie było” — korespondencja może istnieć bez sprawy, " +
      "więc wtedy poszukaj też przez mail_search.",
    scope: ISSUE_SCOPE,
    effectClass: "read",
    input: SearchInput,
    output: SearchOutput,
    auditRefs: (input, output) => ({ query: input.query, count: output?.count ?? 0 }),
    handler: async (input) => {
      const needle = input.query.toLowerCase().trim();
      const found = store()
        .all()
        .filter((i) => (input.includeResolved ? true : i.status !== "resolved"))
        .filter((i) =>
          [
            i.title,
            i.summary,
            ...i.relatedOrderRefs,
            ...i.relatedProductRefs,
            ...i.sourceRefs.map((r) => `${r.subject} ${r.from ?? ""}`),
          ]
            .join("\n")
            .toLowerCase()
            .includes(needle),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const shown = found.slice(0, input.limit);
      return {
        query: input.query,
        count: found.length,
        truncated: found.length > shown.length,
        issues: shown.map(brief),
      };
    },
  };

  return [changes, open, detail, search];
}

/**
 * Sprawy, które adapter powinien oznaczyć jako pokazane po udanej odpowiedzi.
 * Wyciągnięte tutaj, żeby ani `mcp.ts`, ani serwer HTTP nie musiały znać
 * kształtu wyników — i żeby oba robiły to samo.
 */
export function presentedIds(capability: string, output: unknown): string[] {
  const o = output as Record<string, unknown> | null;
  if (!o) return [];
  const collect = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.map((x) => (x as { id?: unknown }).id).filter((x): x is string => typeof x === "string")
      : [];

  switch (capability) {
    case "copilot_get_changes_since":
      return [...collect(o["newIssues"]), ...collect(o["updatedIssues"]), ...collect(o["probablyResolved"])];
    case "copilot_get_open_issues":
    case "copilot_search_issues":
      return collect(o["issues"]);
    case "copilot_get_issue": {
      const id = (o["issue"] as { id?: unknown } | null)?.id;
      return typeof id === "string" ? [id] : [];
    }
    default:
      return [];
  }
}
