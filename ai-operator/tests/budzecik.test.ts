import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpBudzecikReader } from "../src/budzecik/client.js";
import { createBudzecikCapabilities } from "../src/budzecik/capabilities.js";
import { CapabilityRegistry } from "../src/capability/registry.js";

const TOKEN = "b".repeat(48);

afterEach(() => vi.unstubAllGlobals());

describe("Budżecik — klient tylko do odczytu", () => {
  it("wysyła token wyłącznie w nagłówku i nie pozwala wskazać użytkownika", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/copilot/read");
      expect(url.searchParams.get("resource")).toBe("entries");
      expect(url.searchParams.get("query")).toBe("Meta");
      expect(url.searchParams.has("user")).toBe(false);
      expect(String(input)).not.toContain(TOKEN);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      return Response.json({
        ok: true,
        generatedAt: "2026-08-19T10:00:00.000Z",
        data: { found: true, resource: "entries", totalMatched: 1, entries: [] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reader = new HttpBudzecikReader({
      baseUrl: "https://dependable-pigeon-19.eu-west-1.convex.site",
      token: TOKEN,
    });
    const result = await reader.read({ resource: "entries", query: "Meta", limit: 20 });
    expect(result).toMatchObject({ found: true, resource: "entries", totalMatched: 1 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("wystawia firmowemu czatowi tylko procent i odrzuca każdą kwotę", async () => {
    const safeProgress = {
      found: true,
      resource: "sales_progress" as const,
      month: "2026-08",
      progressPercent: 62,
      completePlan: true,
      plannedChannels: 5,
      totalChannels: 5 as const,
      definition: "Potwierdzona sprzedaż względem planu",
    };
    const reader = { read: vi.fn(async () => safeProgress) };
    const registry = new CapabilityRegistry().registerAll(
      createBudzecikCapabilities(async () => reader),
    );
    const context = {
      agent: "test",
      correlationId: "sales-progress-test",
      scopes: ["budget:read"] as const,
      audit: { write: vi.fn(), records: () => [] },
    };

    await expect(registry.invoke("budzecik_get_sales_progress", {}, context))
      .resolves.toEqual(safeProgress);

    reader.read.mockResolvedValueOnce({ ...safeProgress, planNetCents: 1_000_000 } as never);
    await expect(registry.invoke("budzecik_get_sales_progress", {}, context))
      .rejects.toMatchObject({ code: "invalid_output" });
  });

  it("odrzuca adres bez HTTPS i zbyt krótki token", () => {
    expect(() => new HttpBudzecikReader({ baseUrl: "http://budzecik.local", token: TOKEN }))
      .toThrow(/HTTPS/);
    expect(() => new HttpBudzecikReader({ baseUrl: "https://budzecik.example", token: "short" }))
      .toThrow(/32/);
  });
});
