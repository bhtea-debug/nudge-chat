import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpTeabrewReader } from "../src/teabrew/client.js";

const TOKEN = "t".repeat(48);

afterEach(() => vi.unstubAllGlobals());

describe("TeaBrew — raport sprzedaży tylko do odczytu", () => {
  it("czyta raport z TeaBrew, a token wysyła wyłącznie w nagłówku", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/ai-operator/sales-summary");
      expect(url.searchParams.get("from")).toBe("2026-08-19");
      expect(url.searchParams.get("to")).toBe("2026-08-19");
      expect(url.searchParams.get("sources")).toBe("medusa,allegro");
      expect(String(input)).not.toContain(TOKEN);
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      return Response.json({
        ok: true,
        ts: Date.now(),
        contractVersion: "v1",
        data: {
          from: "2026-08-19",
          to: "2026-08-19",
          timezone: "Europe/Warsaw",
          definition: {
            included: "opłacone zamówienia, według daty złożenia",
            excluded: "anulowane i nieopłacone; zwroty nie są odejmowane",
          },
          orderCount: 5,
          grossSalesPLN: 500,
          unitsSold: 7,
          averageOrderPLN: 100,
          channels: [
            { source: "medusa", orderCount: 2, grossSalesPLN: 200, unitsSold: 3 },
            { source: "allegro", orderCount: 3, grossSalesPLN: 300, unitsSold: 4 },
          ],
          daily: [
            { date: "2026-08-19", orderCount: 5, grossSalesPLN: 500, unitsSold: 7 },
          ],
          topProducts: [],
          productsTruncated: false,
          dataQuality: { unmappedLines: 0, ordersWithoutTotal: 0 },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const reader = new HttpTeabrewReader({
      baseUrl: "https://calm-porpoise-426.eu-west-1.convex.site",
      token: TOKEN,
    });
    const result = await reader.getSalesSummary({
      from: "2026-08-19",
      to: "2026-08-19",
      sources: ["medusa", "allegro"],
      topLimit: 10,
    });

    expect(result.orderCount).toBe(5);
    expect(result.channels.find((row) => row.source === "allegro")?.orderCount).toBe(3);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
