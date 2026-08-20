import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryAuditSink } from "../src/capability/audit.js";
import { CapabilityRegistry } from "../src/capability/registry.js";
import { CapabilityError, type CapabilityContext, type Scope } from "../src/capability/types.js";
import { createTeabrewCapabilities } from "../src/teabrew/capabilities.js";
import {
  FixtureTeabrewReader,
  HttpTeabrewReader,
  type FixtureDataInput,
  type TeabrewReader,
} from "../src/teabrew/client.js";

const NOW = Date.UTC(2026, 7, 20, 10, 0, 0);

const fixture = {
  customerCasesFreshness: {
    status: "ready",
    lastSuccessfulSyncAt: NOW - 60_000,
    nextAttemptAt: NOW + 240_000,
    ageMs: 60_000,
    stale: false,
    scopeState: "ready",
    message: null,
  },
  customerCases: [
    {
      id: "case-product",
      externalId: "thread-7",
      source: "messaging",
      sourceType: "offer_question",
      status: "new",
      isRead: false,
      buyerLogin: "kupujacy_7",
      orderId: null,
      offerId: "offer-7",
      offerName: "Rooibos 100 g",
      subject: "Czy produkt jest bez kofeiny?",
      createdAt: NOW - 3_600_000,
      updatedAt: NOW - 1_800_000,
      lastMessageAt: NOW - 1_800_000,
      lastMessagePreview: "Proszę odpisać na klient@example.com",
      hasAttachments: false,
      category: "product_question",
      priority: "P2",
      responseDueAt: NOW + 20 * 3_600_000,
      waitingSince: NOW - 1_800_000,
      waitingMs: 1_800_000,
      slaState: "ok",
      requiresResponse: true,
      answeredAt: null,
    },
    {
      id: "case-discussion",
      externalId: "issue-1",
      source: "sale_issue",
      sourceType: "discussion",
      status: "open",
      isRead: true,
      buyerLogin: "reklamacja_1",
      orderId: "ORDER-123",
      offerId: "offer-1",
      offerName: "Earl Grey 50 g",
      subject: "Uszkodzona paczka",
      createdAt: NOW - 2 * 86_400_000,
      updatedAt: NOW - 60_000,
      lastMessageAt: NOW - 60_000,
      lastMessagePreview: "Telefon +48 501 234 567, proszę o kontakt",
      hasAttachments: true,
      category: "discussion",
      priority: "P0",
      responseDueAt: NOW + 90 * 60_000,
      waitingSince: NOW - 22 * 3_600_000,
      waitingMs: 22 * 3_600_000,
      serviceTargetAt: null,
      serviceMaxAt: NOW - 10 * 3_600_000,
      slaState: "critical",
      requiresResponse: true,
      answeredAt: null,
    },
  ],
  customerCaseMessages: [
    {
      caseId: "case-discussion",
      id: "message-1",
      kind: "message",
      direction: "incoming",
      authorRole: "buyer",
      authorLogin: "reklamacja_1",
      text: "Napisz na klient@example.com albo zadzwoń +48 501 234 567.",
      subject: "Dane do kontaktu",
      createdAt: NOW - 60_000,
      orderId: "ORDER-123",
      offerId: "offer-1",
      attachments: [
        { id: "attachment-1", fileName: "uszkodzenie.jpg", mimeType: "image/jpeg", status: "ready" },
      ],
    },
  ],
} satisfies FixtureDataInput;

function build() {
  const reader = new FixtureTeabrewReader({ data: fixture });
  const registry = new CapabilityRegistry().registerAll(
    createTeabrewCapabilities(async () => reader),
  );
  return { reader, registry };
}

function context(scopes: Scope[]): { ctx: CapabilityContext; audit: MemoryAuditSink } {
  const audit = new MemoryAuditSink();
  return {
    audit,
    ctx: { agent: "test", correlationId: "customer-cases-test", scopes, audit },
  };
}

describe("sprawy klientów Allegro — prywatność i kolejka P0", () => {
  it("lista metadanych ukrywa treść i sortuje P0 przed P2", async () => {
    const { registry } = build();
    const { ctx } = context(["customer_cases:read"]);

    const result = (await registry.invoke(
      "teabrew_list_allegro_customer_cases",
      { state: "open", limit: 30, includeContent: false },
      ctx,
    )) as any;

    expect(result.cases.map((item: any) => item.id)).toEqual([
      "case-discussion",
      "case-product",
    ]);
    expect(result.cases[0]).toMatchObject({
      priority: "P0",
      slaState: "critical",
      serviceTargetAt: null,
      serviceMaxAt: NOW - 10 * 3_600_000,
      buyerLogin: null,
      subject: null,
      lastMessagePreview: null,
    });
    expect(result.contentIncluded).toBe(false);
    expect(result.contentMode).toBe("none");
  });

  it("treść wymaga purpose i osobnego zakresu", async () => {
    const { registry } = build();
    const metadataOnly = context(["customer_cases:read"]);

    await expect(
      registry.invoke(
        "teabrew_list_allegro_customer_cases",
        { state: "open", includeContent: true, purpose: "authorized_chat_view" },
        metadataOnly.ctx,
      ),
    ).rejects.toMatchObject({ code: "forbidden_scope" });

    const withContent = context(["customer_cases:read", "customer_cases:content"]);
    await expect(
      registry.invoke(
        "teabrew_list_allegro_customer_cases",
        { state: "open", includeContent: true },
        withContent.ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });

    expect(metadataOnly.audit.records()[0]).toMatchObject({ ok: false, error: "forbidden_scope" });
    expect(withContent.audit.records()[0]).toMatchObject({ ok: false, error: "invalid_input" });
  });

  it("tryb modelu redaguje dane osobowe i usuwa metadane załączników", async () => {
    const { registry } = build();
    const { ctx } = context(["customer_cases:content"]);

    const result = (await registry.invoke(
      "teabrew_get_allegro_customer_case_messages",
      { id: "case-discussion", purpose: "user_requested_summary", limit: 50 },
      ctx,
    )) as any;

    expect(result.contentMode).toBe("model");
    expect(result.attachmentsExcluded).toBe(true);
    expect(result.messages[0].authorLogin).toBeNull();
    expect(result.messages[0].text).toContain("[email]");
    expect(result.messages[0].text).toContain("[telefon]");
    expect(result.messages[0].text).not.toContain("klient@example.com");
    expect(result.messages[0].attachments).toEqual([]);
  });

  it("tryb display wymaga osobnego zakresu zaufanego firmowego czatu", async () => {
    const { registry } = build();
    const modelClient = context(["customer_cases:content"]);

    await expect(
      registry.invoke(
        "teabrew_get_allegro_customer_case_messages",
        { id: "case-discussion", purpose: "authorized_chat_view", limit: 50 },
        modelClient.ctx,
      ),
    ).rejects.toMatchObject({ code: "forbidden_scope" });

    const { ctx } = context(["customer_cases:content", "customer_cases:display"]);

    const result = (await registry.invoke(
      "teabrew_get_allegro_customer_case_messages",
      { id: "case-discussion", purpose: "authorized_chat_view", limit: 50 },
      ctx,
    )) as any;

    expect(result.contentMode).toBe("display");
    expect(result.messages[0].text).toContain("klient@example.com");
    expect(result.messages[0].attachments[0]).toEqual({
      id: "attachment-1",
      fileName: "uszkodzenie.jpg",
      mimeType: "image/jpeg",
      status: "ready",
    });
    expect(result.messages[0].attachments[0]).not.toHaveProperty("url");
  });

  it("wyszukiwanie nie zapisuje loginu ani numeru zamówienia w audycie", async () => {
    const { registry } = build();
    const { ctx, audit } = context(["customer_cases:read", "customer_cases:content"]);

    await registry.invoke(
      "teabrew_search_allegro_customer_cases",
      { query: "reklamacja_1", by: "buyer", includeContent: false },
      ctx,
    );

    const serialized = JSON.stringify(audit.records());
    expect(serialized).not.toContain("reklamacja_1");
    expect(serialized).not.toContain("ORDER-123");
    expect(audit.records()[0]?.refs).toMatchObject({ by: "buyer", count: 1 });
  });

  it("wyszukiwanie po loginie wymaga zakresu treści nawet bez zwracania treści", async () => {
    const { registry } = build();
    const { ctx } = context(["customer_cases:read"]);

    await expect(
      registry.invoke(
        "teabrew_search_allegro_customer_cases",
        { query: "reklamacja_1", by: "buyer", includeContent: false },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "forbidden_scope" });
  });

  it("rejestr nie publikuje żadnej operacji wysyłki lub mutacji Allegro", () => {
    const { registry } = build();
    const allegro = registry.list().filter((capability) => capability.name.includes("allegro"));
    expect(allegro).toHaveLength(4);
    expect(allegro.every((capability) => capability.effectClass === "read")).toBe(true);
    expect(allegro.map((capability) => capability.name).join(" ")).not.toMatch(
      /send|reply|write|post|update|assign|status_set/,
    );
  });
});

describe("klient HTTP TeaBrew — kontrakt tylko do odczytu", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("używa GET, właściwej trasy i trzyma token wyłącznie w Authorization", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          ok: true,
          ts: NOW,
          contractVersion: "v1",
          data: {
            freshness: fixture.customerCasesFreshness,
            cases: [],
            count: 0,
            truncated: false,
            contentIncluded: false,
            contentMode: "none",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reader: TeabrewReader = new HttpTeabrewReader({
      baseUrl: "https://teabrew.example",
      token: "sekretny-token",
    });

    await reader.listCustomerCases({
      state: "open",
      limit: 25,
      includeContent: false,
      contentMode: "model",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://teabrew.example/ai-operator/customer-cases?state=open&limit=25&includeContent=false&contentMode=model",
    );
    expect(String(url)).not.toContain("sekretny-token");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ authorization: "Bearer sekretny-token" });
  });

  it("przekazuje jednoznaczny stan braku scope/reautoryzacji", async () => {
    const reader = new FixtureTeabrewReader({
      data: {
        customerCasesFreshness: {
          ...fixture.customerCasesFreshness,
          status: "missing_scope",
          scopeState: "reconnect_required",
          stale: true,
          message: "Włącz allegro:api:messaging i ponownie połącz konto Allegro.",
        },
      },
    });

    const result = await reader.listCustomerCases({
      state: "all",
      limit: 10,
      includeContent: false,
      contentMode: "model",
    });

    expect(result.freshness).toMatchObject({
      status: "missing_scope",
      scopeState: "reconnect_required",
      stale: true,
    });
    expect(result.freshness.message).toContain("ponownie połącz");
  });

  it("nie ma metody ani ścieżki zapisu", () => {
    const methods = Object.getOwnPropertyNames(HttpTeabrewReader.prototype).join(" ");
    expect(methods).not.toMatch(/send|reply|post|write|update|delete|assign/i);
  });
});

it("błąd uprawnienia ma stabilny typ", () => {
  expect(new CapabilityError("forbidden_scope", "brak")).toBeInstanceOf(CapabilityError);
});
