import { describe, expect, it } from "vitest";
import { buildOperator, buildRegistry, buildTriage, SCOPES } from "./helpers.js";
import { MemoryAuditSink, newCorrelationId } from "../src/capability/audit.js";
import { CapabilityError, type CapabilityContext } from "../src/capability/types.js";
import { checkForFabrication } from "../src/agent/evidence.js";
import { AGENT_ID } from "../src/agent/prompt.js";
import { renderTriage } from "../src/agent/triage.js";

function ctx(): { ctx: CapabilityContext; audit: MemoryAuditSink } {
  const audit = new MemoryAuditSink();
  return {
    audit,
    ctx: { agent: AGENT_ID, correlationId: newCorrelationId(), scopes: SCOPES, audit },
  };
}

/**
 * Pięć scenariuszy akceptacyjnych. Każdy odpowiada jednemu wymaganiu, które
 * ma zostać spełnione po tygodniu. Żaden nie wykonuje zapytania do modelu ani
 * do sieci — model jest atrapą odgrywającą zaplanowane kroki, dane pochodzą
 * z fikstur. Dzięki temu suite jest deterministyczny i działa bez klucza API.
 */
describe("Scenariusz 1 — read-only jest wymuszone konstrukcyjnie, nie promptem", () => {
  it("rejestr odrzuca capability, która zapisuje", () => {
    const registry = buildRegistry();
    expect(() =>
      registry.register({
        name: "teabrew_set_order_status",
        version: "1.0.0",
        description: "zmienia status zamówienia",
        scope: "erp:read",
        effectClass: "write-reversible",
        input: {} as never,
        output: {} as never,
        handler: async () => undefined,
      }),
    ).toThrowError(/forbidden_effect|wyłącznie/);
  });

  it("żadna zarejestrowana capability nie ma innego effectClass niż read", () => {
    const caps = buildRegistry().list();
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.filter((c) => c.effectClass !== "read")).toHaveLength(0);
  });

  it("agent nie ma żadnego narzędzia do wysyłki maila ani do mutacji", () => {
    const names = buildRegistry()
      .list()
      .map((c) => c.name);
    for (const forbidden of ["send", "reply", "create", "update", "set_", "delete", "smtp"]) {
      expect(names.filter((n) => n.includes(forbidden))).toHaveLength(0);
    }
  });

  it("capability poza przyznanym zakresem nie wykona się", async () => {
    const registry = buildRegistry();
    const audit = new MemoryAuditSink();
    const narrow: CapabilityContext = {
      agent: AGENT_ID,
      correlationId: newCorrelationId(),
      scopes: ["mail:read"],
      audit,
    };
    await expect(
      registry.invoke("teabrew_get_order_status", { ref: "12345" }, narrow),
    ).rejects.toThrowError(CapabilityError);
    // Odrzucone wywołanie też musi zostawić ślad w audycie.
    expect(audit.records()).toHaveLength(1);
    expect(audit.records()[0]!.ok).toBe(false);
  });
});

describe("Scenariusz 2 — mail o zamówieniu 12345 kończy się odpowiedzią z prawdziwych danych", () => {
  it("czyta pocztę, rekonstruuje wątek, sprawdza zamówienie i ma na to dowody", async () => {
    const { operator, model } = buildOperator([
      { tools: [{ name: "mail_search", input: { query: "12345", limit: 10 } }] },
      {
        tools: [
          {
            name: "mail_get_thread",
            input: { messageId: "<zam-12345-2@sklep-ziolowy.example>", maxMessages: 10 },
          },
        ],
      },
      { tools: [{ name: "teabrew_get_order_status", input: { ref: "12345", limit: 5 } }] },
      {
        text:
          "Zamówienie 12345 (Sklep Ziołowy) jest w produkcji, opłacone, termin za 2 dni. " +
          "Earl Grey 50 g: zrealizowane 60 z 200 szt. Klient pisze, że potrzebuje dostawy do środy.",
      },
    ]);

    const result = await operator.ask("Co z zamówieniem 12345?");

    const called = result.audit.map((r) => r.capability);
    expect(called).toEqual([
      "mail_search",
      "mail_get_thread",
      "teabrew_get_order_status",
    ]);
    expect(result.audit.every((r) => r.ok)).toBe(true);

    // Wątek odtworzony z nagłówka References, PONAD FOLDERAMI: dwa pytania
    // klienta z INBOX plus nasza odpowiedź z folderu wysłanych. Bez tej
    // trzeciej wiadomości agent uznałby, że klientowi nikt nie odpisał.
    const thread = JSON.parse(model.observed[1]!.result) as {
      messageCount: number;
      messages: { folder: string; from: { address: string } | null }[];
    };
    expect(thread.messageCount).toBe(3);
    expect(thread.messages.some((m) => m.folder === "Sent")).toBe(true);
    expect(thread.messages.some((m) => m.folder === "INBOX")).toBe(true);

    // Zamówienie zostało dopasowane po realnym polu, nie „jakoś".
    const order = JSON.parse(model.observed[2]!.result) as {
      matchedBy: string;
      orders: {
        fulfillmentStatus: string;
        items: { skuCode: string; fulfilledQty: number }[];
        production: { status: string }[];
      }[];
    };
    expect(order.matchedBy).toBe("externalOrderId");
    // W TeaBrew „jest w produkcji" NIE jest statusem realizacji zamówienia —
    // orderFulfillmentStatus to awaiting_payment|new|confirmed|in_picking|
    // packed|shipped|delivered|cancelled. O produkcji mówi powiązane zlecenie.
    expect(order.orders[0]!.fulfillmentStatus).toBe("confirmed");
    expect(order.orders[0]!.production[0]!.status).toBe("in_progress");

    // Stopka dowodowa pochodzi z audytu, nie od modelu.
    expect(result.answerWithEvidence).toContain("Co sprawdziłem, zanim odpowiedziałem");
    expect(result.answerWithEvidence).toContain("teabrew_get_order_status");
    expect(result.findings).toHaveLength(0);
  });
});

describe("Scenariusz 3 — czego nie ma w TeaBrew, tego agent nie wymyśli", () => {
  it("nieistniejące zamówienie zwraca matchedBy=none, a nie puste zamówienie", async () => {
    const { ctx: c } = ctx();
    const res = (await buildRegistry().invoke(
      "teabrew_get_order_status",
      { ref: "99999" },
      c,
    )) as { matchedBy: string; count: number; orders: unknown[] };
    expect(res.matchedBy).toBe("none");
    expect(res.count).toBe(0);
    expect(res.orders).toHaveLength(0);
  });

  it("kontrola dowodów łapie status podany bez wywołania TeaBrew", async () => {
    const { operator } = buildOperator([
      {
        text:
          "Sprawdziłem w TeaBrew — zamówienie 99999 jest już spakowane i czeka na kuriera.",
      },
    ]);
    const result = await operator.ask("Co z zamówieniem 99999?");

    expect(result.audit).toHaveLength(0);
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain("claim_without_any_erp_call");
    expect(codes).toContain("order_ref_never_checked");
    // Ostrzeżenie musi być widoczne dla człowieka, nie tylko w strukturze.
    expect(result.answerWithEvidence).toContain("KONTROLA DOWODÓW ZGŁOSIŁA PROBLEM");
    expect(result.answerWithEvidence).toContain("nic");
  });

  it("kontrola nie zgłasza fałszywych alarmów, gdy numer faktycznie sprawdzono", async () => {
    const { operator } = buildOperator([
      { tools: [{ name: "teabrew_get_order_status", input: { ref: "99999" } }] },
      {
        text:
          "Zamówienia 99999 nie ma w TeaBrew. Klient twierdzi, że miało być wysłane w piątek, " +
          "ale w systemie nie ma takiego numeru — trzeba ustalić, pod jakim numerem zostało założone.",
      },
    ]);
    const result = await operator.ask("Co z zamówieniem 99999?");
    expect(result.audit.map((r) => r.capability)).toEqual(["teabrew_get_order_status"]);
    expect(result.findings).toHaveLength(0);
  });

  it("ilości, kwoty i lata nie są traktowane jako numery zamówień", () => {
    // Ani jedna z tych liczb nie jest powołaniem się na rekord w systemie,
    // więc kontrola nie ma prawa niczego zgłosić — inaczej właściciel
    // nauczyłby się ignorować ostrzeżenia.
    const findings = checkForFabrication(
      "Umowa z 2024 roku, wolumen 1200 opakowań, wartość kontraktu 4500 zł.",
      [],
    );
    expect(findings).toHaveLength(0);
  });

  it("numer zlecenia z prefiksem jest sprawdzany zawsze", () => {
    const findings = checkForFabrication("Produkcja idzie na zleceniu ZP-2026-9999.", []);
    expect(findings.map((f) => f.code)).toContain("order_ref_never_checked");
  });

  it("numer po słowie „zamówienie” jest sprawdzany", () => {
    const findings = checkForFabrication("Zamówienie 12345 jest gotowe do wysyłki.", []);
    expect(findings.map((f) => f.code)).toContain("order_ref_never_checked");
  });
});

describe("Scenariusz 4 — pytanie o dostępność produktu z nazwy handlowej", () => {
  it("nazwa z maila daje kilka trafień, a stan liczy się dla wybranego kodu", async () => {
    const registry = buildRegistry();
    const { ctx: c } = ctx();

    const found = (await registry.invoke(
      "teabrew_find_product",
      { query: "Rooibos Vanilla" },
      c,
    )) as { skus: { code: string }[]; totalCount: number };
    // Dwa warianty gramatury — agent nie ma prawa wybrać jednego za człowieka.
    expect(found.skus.map((s) => s.code).sort()).toEqual([
      "BHT-ROO-VAN-100",
      "BHT-ROO-VAN-50",
    ]);

    const stock = (await registry.invoke(
      "teabrew_get_stock",
      { codes: ["BHT-ROO-VAN-100"], profile: "finished_goods" },
      c,
    )) as { items: { available: number; onHand: number }[]; unknownCodes: string[] };
    expect(stock.items[0]!.onHand).toBe(412);
    expect(stock.items[0]!.available).toBe(292);
    expect(stock.unknownCodes).toHaveLength(0);
  });

  it("nieznany kod trafia do unknownCodes, a nie do stanu zero", async () => {
    const { ctx: c } = ctx();
    const stock = (await buildRegistry().invoke(
      "teabrew_get_stock",
      { codes: ["BHT-NIE-MA-TAKIEGO"], profile: "finished_goods" },
      c,
    )) as { items: unknown[]; unknownCodes: string[] };
    expect(stock.items).toHaveLength(0);
    expect(stock.unknownCodes).toEqual(["BHT-NIE-MA-TAKIEGO"]);
  });

  it("odpowiedź o stanie bez wywołania stanu jest zgłaszana", () => {
    const findings = checkForFabrication("Stan magazynowy wynosi 292 sztuki.", []);
    expect(findings.map((f) => f.code)).toContain("stock_claim_without_stock_call");
  });
});

describe("Scenariusz 5 — audyt odpowiada, co agent sprawdził, i nie zawiera treści maili", () => {
  it("każde wywołanie ma pełny wpis: czas, agent, capability, wynik, czas trwania, korelację", async () => {
    const { operator } = buildOperator([
      { tools: [{ name: "mail_list_recent", input: { sinceDays: 2, limit: 10 } }] },
      { text: "Podsumowanie poczty." },
    ]);
    const result = await operator.ask("Co ważnego przyszło?");

    expect(result.audit).toHaveLength(1);
    const r = result.audit[0]!;
    expect(r.agent).toBe("inbox-operator");
    expect(r.capability).toBe("mail_list_recent");
    expect(r.capabilityVersion).toBe("1.0.0");
    expect(r.ok).toBe(true);
    expect(typeof r.latencyMs).toBe("number");
    expect(r.correlationId).toBe(result.correlationId);
    expect(new Date(r.ts).toString()).not.toBe("Invalid Date");
  });

  it("audyt nie zawiera tematów ani treści wiadomości", async () => {
    const { operator } = buildOperator([
      { tools: [{ name: "mail_list_recent", input: { sinceDays: 2, limit: 25 } }] },
      {
        tools: [
          {
            name: "mail_get_thread",
            input: { messageId: "<reklamacja-2026-08@delikatesy-nowak.example>" },
          },
        ],
      },
      { text: "Gotowe." },
    ]);
    const result = await operator.ask("Przejrzyj pocztę");

    const dump = JSON.stringify(result.audit);
    // Fragmenty, które MUSZĄ nie wyciekać do logu.
    for (const secret of [
      "Reklamacja",
      "sanepid",
      "plastik",
      "delikatesy-nowak.example",
      "klientka",
    ]) {
      expect(dump.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    // A jednocześnie log musi być użyteczny: widać, czego dotyczyło wywołanie.
    expect(dump).toContain("messageCount");
    expect(dump).toContain("messageIdHash");
  });

  it("fraza wyszukiwania jest logowana, ale adres nadawcy zamaskowany", async () => {
    const { operator } = buildOperator([
      {
        tools: [
          { name: "mail_search", input: { query: "12345", limit: 5 } },
          {
            name: "mail_search",
            input: { query: "marek.nowak@delikatesy-nowak.example", limit: 5 },
          },
        ],
      },
      { text: "Gotowe." },
    ]);
    const result = await operator.ask("Znajdź te sprawy");

    const refs = result.audit.map((r) => String(r.refs?.["query"] ?? ""));
    // Numer zamówienia zostaje — bez niego audyt nie odpowiada na pytanie,
    // czego agent szukał.
    expect(refs).toContain("12345");
    // Adres nie — została domena, po której widać sens zapytania.
    expect(refs.some((q) => q.includes("m***@delikatesy-nowak.example"))).toBe(true);
    expect(JSON.stringify(result.audit)).not.toContain("marek.nowak@");
  });

  it("nieudane wywołanie zapisuje kod błędu, nie dane", async () => {
    const { operator } = buildOperator([
      { tools: [{ name: "mail_get_thread", input: { messageId: "<nie-istnieje@example>" } }] },
      { text: "Nie znalazłem tej wiadomości." },
    ]);
    const result = await operator.ask("Pokaż wątek");
    expect(result.audit[0]!.ok).toBe(false);
    expect(result.audit[0]!.error).toBe("not_found");
  });
});

describe("Widok triage — pięć kategorii i status z TeaBrew przy sprawach pilnych", () => {
  it("grupuje pocztę i dociąga status zamówienia dla pilnych", async () => {
    const { triage } = buildTriage([
      {
        id: "<zam-12345-2@sklep-ziolowy.example>",
        kategoria: "Pilne",
        uzasadnienie: "Klient potrzebuje dostawy do środy.",
        konkrety: ["12345"],
        czyWymagaOdpowiedzi: true,
      },
      {
        id: "<rabat-q4@hurt-herbaty.example>",
        kategoria: "Wymaga decyzji",
        uzasadnienie: "Prośba o rabat 12% na Q4.",
        konkrety: [],
        czyWymagaOdpowiedzi: true,
      },
      {
        id: "<newsletter-opakowania@targi-packaging.example>",
        kategoria: "Można pominąć",
        uzasadnienie: "Newsletter targowy.",
        konkrety: [],
        czyWymagaOdpowiedzi: false,
      },
    ]);

    const result = await triage.run({ sinceDays: 2, limit: 25 });

    expect(result.items.map((i) => i.category)).toEqual([
      "Pilne",
      "Wymaga decyzji",
      "Można pominąć",
    ]);

    const urgent = result.items[0]!;
    expect(urgent.erp).toHaveLength(1);
    expect(urgent.erp[0]!.found).toBe(true);
    expect(urgent.erp[0]!.summary).toContain("confirmed");

    // Wiadomości, których model nie zaklasyfikował, nie dostają kategorii na siłę.
    expect(result.unclassified.length).toBeGreaterThan(0);

    const rendered = renderTriage(result);
    expect(rendered).toContain("## Pilne (1)");
    expect(rendered).toContain("TeaBrew 12345");
    expect(rendered).toContain("Nieklasyfikowane");
    expect(rendered).toContain("Co sprawdziłem");
  });
});
