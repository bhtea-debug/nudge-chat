import { describe, expect, it } from "vitest";
import {
  assignThreadIds,
  baseSubject,
  normalizeReferences,
  parentRefsWithin,
  threadMemberIds,
} from "../src/mail/thread.js";
import {
  htmlToPlainText,
  makeSnippet,
  stripQuotedHistory,
  truncateBody,
} from "../src/mail/text.js";
import { FixtureMailProvider, resolveFixtureDate } from "../src/mail/fixture.js";
import { planFolders, type MailboxInfo } from "../src/mail/folders.js";
import { MailThread } from "../src/mail/types.js";
import {
  toMarkdownTable,
  toMcpToolList,
  toOpenApiDocument,
  toToolDefinitions,
} from "../src/capability/projections.js";
import { createRegistryForProjections } from "../src/index.js";
import { ROUTES } from "../src/teabrew/contract.js";

describe("rekonstrukcja wątków", () => {
  it("normalizuje References podane jako string i jako tablicę", () => {
    // Realna pułapka: mailparser zwraca References raz tak, raz tak.
    expect(normalizeReferences("<a@x> <b@x>", null)).toEqual(["<a@x>", "<b@x>"]);
    expect(normalizeReferences(["<a@x>", "<b@x>"], null)).toEqual(["<a@x>", "<b@x>"]);
    expect(normalizeReferences(undefined, "<c@x>")).toEqual(["<c@x>"]);
    expect(normalizeReferences("<a@x>", "<a@x>")).toEqual(["<a@x>"]);
  });

  it("scala wiadomości w jeden wątek przez References", () => {
    const ids = assignThreadIds([
      { id: "<c@x>", inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"], subject: "Re: t", date: "2026-08-03" },
      { id: "<a@x>", inReplyTo: null, references: [], subject: "t", date: "2026-08-01" },
      { id: "<b@x>", inReplyTo: "<a@x>", references: ["<a@x>"], subject: "Re: t", date: "2026-08-02" },
    ]);
    // Najstarsza posiadana wiadomość jest identyfikatorem wątku, niezależnie
    // od kolejności wejścia.
    expect([...new Set(ids.values())]).toEqual(["<a@x>"]);
  });

  it("nie scala niepowiązanych wiadomości", () => {
    const ids = assignThreadIds([
      { id: "<a@x>", inReplyTo: null, references: [], subject: "jedno", date: "2026-08-01" },
      { id: "<z@x>", inReplyTo: null, references: [], subject: "drugie", date: "2026-08-02" },
    ]);
    expect(new Set(ids.values()).size).toBe(2);
  });

  it("zbiera identyfikatory do dociągnięcia i czyści temat z prefiksów", () => {
    expect(
      threadMemberIds({
        id: "<c@x>",
        inReplyTo: "<b@x>",
        references: ["<a@x>"],
        subject: "Re: t",
        date: "2026-08-03",
      }).sort(),
    ).toEqual(["<a@x>", "<b@x>", "<c@x>"]);

    expect(baseSubject("Re: Odp: FWD: Zamówienie 12345")).toBe("Zamówienie 12345");
    expect(baseSubject("")).toBe("(brak tematu)");
  });
});

describe("normalizacja treści", () => {
  it("zamienia HTML na tekst i nie zostawia znaczników", () => {
    const out = htmlToPlainText(
      "<html><style>p{color:red}</style><body><p>Cześć&nbsp;Anna</p><br><div>Do środy</div></body></html>",
    );
    expect(out).not.toMatch(/<[^>]+>/);
    expect(out).toContain("Cześć Anna");
    expect(out).toContain("Do środy");
    expect(out).not.toContain("color:red");
  });

  it("odcina cytowaną historię, ale nie kasuje krótkiej wiadomości", () => {
    const withQuote = "Ponawiam pytanie o 12345.\n\n> Dzień dobry,\n> pytałam wczoraj o to zamówienie.";
    expect(stripQuotedHistory(withQuote)).toBe("Ponawiam pytanie o 12345.");

    const onlyQuote = "ok\n\nW dniu 2026-08-15 Anna napisał:\n> treść";
    // Po odcięciu zostałoby „ok" — za mało, więc lepiej pokazać całość.
    expect(stripQuotedHistory(onlyQuote)).toContain("W dniu");
  });

  it("przycina długie treści i oznacza to jawnie", () => {
    const { body, truncated } = truncateBody("x".repeat(9000));
    expect(truncated).toBe(true);
    expect(body).toContain("treść przycięta");
    expect(truncateBody("krótka").truncated).toBe(false);
  });

  it("podgląd jest jednolinijkowy i ograniczony", () => {
    const snippet = makeSnippet("linia 1\n\nlinia 2   z   odstępami");
    expect(snippet).toBe("linia 1 linia 2 z odstępami");
    expect(makeSnippet("y".repeat(1000)).length).toBeLessThanOrEqual(321);
  });
});

describe("dostawca na fiksturach", () => {
  const provider = new FixtureMailProvider({
    filePath: new URL("../fixtures/mail/inbox.json", import.meta.url).pathname,
  });

  it("rozwiązuje daty względne, więc okno czasowe zawsze działa", () => {
    const now = Date.UTC(2026, 7, 16, 12, 0, 0);
    expect(resolveFixtureDate("{{-2h}}", now)).toBe("2026-08-16T10:00:00.000Z");
    expect(resolveFixtureDate("{{-1d}}", now)).toBe("2026-08-15T12:00:00.000Z");
    expect(resolveFixtureDate("2026-01-02T03:04:05.000Z", now)).toBe("2026-01-02T03:04:05.000Z");
  });

  it("filtruje po oknie czasowym i po nieprzeczytanych", async () => {
    const recent = await provider.listRecent({ limit: 50, since: new Date(Date.now() - 7 * 3_600_000) });
    expect(recent.messages.length).toBeGreaterThan(0);
    expect(
      recent.messages.every((m) => Date.now() - new Date(m.date).getTime() <= 7 * 3_600_000),
    ).toBe(true);
    // Nic nie zostało obcięte, więc liczba trafień równa się liczbie zwróconych.
    expect(recent.matched).toBe(recent.messages.length);

    const unread = await provider.listRecent({
      limit: 50,
      since: new Date(Date.now() - 3 * 86_400_000),
      unreadOnly: true,
    });
    expect(unread.messages.every((m) => !m.seen)).toBe(true);
  });

  it("szuka w temacie, nadawcy i treści", async () => {
    // Trzy trafienia: dwa pytania klienta i nasza odpowiedź (temat też liczy się
    // do wyszukiwania) — agent widzi, że sprawa już raz była obsłużona.
    expect((await provider.search({ query: "12345", limit: 10 })).messages.length).toBe(3);
    expect((await provider.search({ query: "sanepid", limit: 10 })).messages.length).toBe(1);
    expect((await provider.search({ query: "hurt-herbaty", limit: 10 })).messages.length).toBe(1);
    expect((await provider.search({ query: "nie ma takiej frazy xyz", limit: 10 })).messages.length).toBe(0);
  });

  it("mówi, ile trafień było PRZED przycięciem do limitu", async () => {
    // Znalezione na żywo: model poprosił o 30 wiadomości, dostał 30 i napisał,
    // że pobrał „pełne 30 z 7 dni". Nie miał z czego tego wiedzieć.
    const all = await provider.listRecent({ limit: 50, since: new Date(0) });
    expect(all.matched).toBeGreaterThan(1);

    const capped = await provider.listRecent({ limit: 1, since: new Date(0) });
    expect(capped.messages).toHaveLength(1);
    // Liczba dostępnych trafień nie zmienia się od tego, ile ich poprosiliśmy.
    expect(capped.matched).toBe(all.matched);
  });

  it("zwraca cały wątek dla dowolnej wiadomości z wątku", async () => {
    const fromReply = await provider.getThread({
      messageId: "<zam-12345-2@sklep-ziolowy.example>",
      maxMessages: 10,
    });
    const fromOriginal = await provider.getThread({
      messageId: "<zam-12345-1@sklep-ziolowy.example>",
      maxMessages: 10,
    });
    // Trzy wiadomości: dwa pytania klienta z INBOX i nasza odpowiedź z Sent.
    expect(fromReply?.messageCount).toBe(3);
    expect(fromReply?.threadId).toBe(fromOriginal?.threadId);
    expect(fromReply?.subject).toBe("Zapytanie o zamówienie 12345");
    // Chronologicznie, od najstarszej.
    expect(fromReply!.messages[0]!.id).toBe("<zam-12345-1@sklep-ziolowy.example>");
    // Wątek przechodzi przez oba foldery — to jest cała stawka wykrywania \Sent.
    expect(new Set(fromReply!.messages.map((m) => m.folder))).toEqual(
      new Set(["INBOX", "Sent"]),
    );
  });

  it("nieistniejąca wiadomość to null, nie wymyślony wątek", async () => {
    expect(await provider.getThread({ messageId: "<nie-ma@x>", maxMessages: 5 })).toBeNull();
  });
});

describe("wykrywanie folderów — nazwy folderu wysłanych nie wolno zgadywać", () => {
  const box = (
    path: string,
    specialUse?: string,
    source = "extension",
  ): MailboxInfo => ({
    path,
    name: path.split(/[./]/).pop() ?? path,
    specialUse,
    specialUseSource: specialUse ? source : undefined,
    subscribed: true,
  });

  it("rozpoznaje folder wysłanych po SPECIAL-USE, niezależnie od nazwy", () => {
    for (const name of ["Sent", "Sent Items", "INBOX.Sent", "Elementy wysłane"]) {
      const plan = planFolders([box("INBOX"), box(name, "\\Sent")], ["auto"]);
      expect(plan.sent).toBe(name);
      expect(plan.threadFolders).toEqual(["INBOX", name]);
      expect(plan.warnings).toHaveLength(0);
    }
  });

  it("nie bierze folderu tylko dlatego, że nazywa się Sent", () => {
    // Folder o „właściwej" nazwie, ale bez atrybutu \Sent — np. archiwum
    // użytkownika. Zgadywanie po nazwie kazałoby go użyć.
    const plan = planFolders([box("INBOX"), box("Sent")], ["auto"]);
    expect(plan.sent).toBeNull();
    expect(plan.threadFolders).toEqual(["INBOX"]);
    expect(plan.warnings.join(" ")).toMatch(/nie wskazał folderu wysłanych/);
  });

  it("ostrzega, gdy serwer nie ma folderu wysłanych", () => {
    const plan = planFolders([box("INBOX"), box("Trash", "\\Trash")], ["auto"]);
    expect(plan.sent).toBeNull();
    expect(plan.warnings.join(" ")).toMatch(/nie zobaczy naszych odpowiedzi/);
  });

  it("respektuje jawną listę, ale ostrzega o pominiętym folderze wysłanych", () => {
    const plan = planFolders(
      [box("INBOX"), box("Sent Items", "\\Sent")],
      ["INBOX"],
    );
    expect(plan.threadFolders).toEqual(["INBOX"]);
    expect(plan.warnings.join(" ")).toMatch(/Sent Items.*nie ma go w MAIL_THREAD_FOLDERS/s);
  });

  it("ostrzega o folderze, którego na serwerze nie ma", () => {
    const plan = planFolders([box("INBOX")], ["INBOX", "Wyslane"]);
    expect(plan.warnings.join(" ")).toMatch(/"Wyslane".*nie ma na serwerze/s);
  });

  it("nie duplikuje folderów", () => {
    const plan = planFolders(
      [box("INBOX"), box("Sent", "\\Sent")],
      ["INBOX", "INBOX", "Sent"],
    );
    expect(plan.threadFolders).toEqual(["INBOX", "Sent"]);
  });
});

describe("projekcje — jedna definicja, wiele klientów", () => {
  const caps = createRegistryForProjections().list();

  it("rejestr zawiera dokładnie zaplanowane capability", () => {
    expect(caps.map((c) => c.name)).toEqual([
      "budzecik_get_budgets",
      "budzecik_get_overview",
      "budzecik_get_sales_progress",
      "budzecik_search_records",
      // Pamięć Copilota — sprawy. Zakres issues:read, wyłącznie odczyt.
      "copilot_get_changes_since",
      "copilot_get_issue",
      "copilot_get_open_issues",
      "copilot_search_issues",
      "mail_get_thread",
      "mail_list_recent",
      "mail_search",
      "marketing_get_my_tasks",
      "marketing_get_schedule",
      "marketing_list_campaigns",
      "teabrew_find_product",
      "teabrew_get_allegro_customer_case",
      "teabrew_get_allegro_customer_case_messages",
      "teabrew_get_order_status",
      "teabrew_get_production_status",
      "teabrew_get_sales_summary",
      "teabrew_get_stock",
      "teabrew_list_allegro_customer_cases",
      "teabrew_search_allegro_customer_cases",
    ]);
  });

  it("definicje narzędzi mają poprawny JSON Schema dla każdej capability", () => {
    const tools = toToolDefinitions(caps);
    expect(tools).toHaveLength(caps.length);
    for (const t of tools) {
      expect(t.input_schema["type"]).toBe("object");
      expect(t.input_schema).not.toHaveProperty("$schema");
      expect(t.description).toContain("read-only");
    }
    const stock = tools.find((t) => t.name === "teabrew_get_stock")!;
    const props = stock.input_schema["properties"] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["codes", "profile"]);
    expect(stock.input_schema["required"]).toEqual(["codes"]);
    const marketing = tools.find((t) => t.name === "marketing_get_my_tasks")!;
    const marketingProps = marketing.input_schema["properties"] as Record<string, unknown>;
    expect(Object.keys(marketingProps).sort()).toEqual(["dueFrom", "dueTo", "limit", "view"]);
    expect(marketing.input_schema["required"]).toBeUndefined();
    const schedule = tools.find((t) => t.name === "marketing_get_schedule")!;
    const scheduleProps = schedule.input_schema["properties"] as Record<string, unknown>;
    expect(Object.keys(scheduleProps).sort()).toEqual(["from", "limit", "to"]);
    expect(schedule.input_schema["required"]).toEqual(["from", "to"]);
    const campaigns = tools.find((t) => t.name === "marketing_list_campaigns")!;
    expect(Object.keys(campaigns.input_schema["properties"] as Record<string, unknown>).sort())
      .toEqual(["limit", "view"]);
  });

  it("OpenAPI powstaje dla wszystkich capability i wymusza bearer", () => {
    const doc = toOpenApiDocument(caps, { title: "t", version: "1" });
    const paths = doc["paths"] as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(paths)).toHaveLength(caps.length);
    for (const cap of caps) {
      const op = paths[`/capabilities/${cap.name}`]!["post"]!;
      expect(op["operationId"]).toBe(cap.name);
      expect(op["x-effect-class"]).toBe("read");
      expect(op["security"]).toEqual([{ bearerAuth: [] }]);
    }
  });

  it("projekcja MCP używa tego samego rejestru", () => {
    const mcp = toMcpToolList(caps);
    expect(mcp.map((t) => t.name)).toEqual(caps.map((c) => c.name));
    expect(mcp.every((t) => (t.inputSchema["type"] as string) === "object")).toBe(true);
  });

  it("tabela dla człowieka wypisuje effectClass każdej capability", () => {
    const md = toMarkdownTable(caps);
    expect(md.match(/\| read \|/g)).toHaveLength(caps.length);
  });
});

describe("kontrakt TeaBrew", () => {
  it("ścieżki są nazwane po konsumencie, zgodnie z konwencją convex/http.ts", () => {
    for (const route of Object.values(ROUTES)) {
      expect(route.startsWith("/ai-operator/")).toBe(true);
    }
  });
});

describe("wątek niepełny musi się przyznać, a nie wyglądać na krótki", () => {
  it("kontrakt MailThread wymaga flagi incomplete i powodu", () => {
    // Cicho przycięty wątek jest groźniejszy od błędu: agent nie wymyśli
    // brakującej wiadomości, ale wyciągnie z braku wniosek „nikt nie odpisał".
    const shape = MailThread.shape;
    expect(Object.keys(shape)).toContain("incomplete");
    expect(Object.keys(shape)).toContain("incompleteNote");

    // Brak tych pól musi być błędem walidacji, nie cichym domyślnym false.
    const withoutFlag = {
      threadId: "<a@x>",
      subject: "t",
      messageCount: 1,
      messages: [],
    };
    expect(MailThread.safeParse(withoutFlag).success).toBe(false);
  });

  it("opis capability mówi modelowi, żeby nie wnioskował z niepełnego wątku", () => {
    const cap = createRegistryForProjections()
      .list()
      .find((c) => c.name === "mail_get_thread")!;
    expect(cap.description).toMatch(/incomplete/);
    expect(cap.description).toMatch(/nie twierdź, że nikt nie odpisał/i);
  });
});

describe("autoreferencja nie może udawać rodzica w skrzynce", () => {
  // Realny przypadek z produkcyjnej skrzynki: automat OpenERP/Odoo wstawia
  // własny Message-ID do własnego nagłówka References. Bez wykluczenia
  // samej siebie taka wiadomość wygląda jak odpowiedź, której rodzic leży
  // w skrzynce — i poprawnie odtworzony wątek jednoelementowy wygląda wtedy
  // jak usterka rekonstrukcji.
  const selfRef = {
    id: "<567027834315781.1786888864-openerp-reply_to@eupp259>",
    inReplyTo: null,
    references: ["<567027834315781.1786888864-openerp-reply_to@eupp259>"],
    subject: "Back at work & catching up on your requests",
    date: "2026-08-14",
  };

  it("wiadomość referencująca samą siebie nie ma rodzica w zbiorze", () => {
    const ids = new Set([selfRef.id]);
    expect(parentRefsWithin(selfRef, ids)).toEqual([]);
  });

  it("prawdziwy rodzic nadal jest znajdowany", () => {
    const child = {
      id: "<c@x>",
      inReplyTo: "<b@x>",
      references: ["<a@x>", "<b@x>", "<c@x>"],
      subject: "Re: t",
      date: "2026-08-03",
    };
    // <c@x> to on sam, <a@x> nie ma w zbiorze — zostaje wyłącznie <b@x>.
    expect(parentRefsWithin(child, new Set(["<b@x>", "<c@x>"]))).toEqual(["<b@x>"]);
  });

  it("normalizeReferences NADAL oddaje nagłówek wiernie, w tym autoreferencję", () => {
    // Wierność nagłówkowi jest celowa: interpretacja należy do miejsca użycia,
    // nie do parsera. Gdyby parser odsiewał autoreferencje, nie dałoby się
    // odróżnić nagłówka wadliwego od poprawionego po drodze.
    expect(normalizeReferences([selfRef.id], null)).toEqual([selfRef.id]);
  });

  it("wątek takiej wiadomości ma jeden element i NIE jest oznaczony jako niepełny", async () => {
    const provider = new FixtureMailProvider({
      messages: [
        {
          id: selfRef.id,
          subject: selfRef.subject,
          from: { address: "auto@example.invalid" },
          replyTo: null,
          date: new Date().toISOString(),
          references: selfRef.references,
          text: "Automatyczna odpowiedź.",
        },
      ],
    });
    const thread = await provider.getThread({ messageId: selfRef.id, maxMessages: 20 });
    expect(thread?.messageCount).toBe(1);
    // Jednoelementowy wątek to tu POPRAWNY wynik, nie zgubiony dowód.
    expect(thread?.incomplete).toBe(false);
  });
});
