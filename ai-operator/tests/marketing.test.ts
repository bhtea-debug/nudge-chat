import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMarketingPlannerReader } from "../src/marketing/client.js";

const TOKEN = "p".repeat(48);

afterEach(() => vi.unstubAllGlobals());

describe("Planer Marketingowy — klient tylko do odczytu", () => {
  it("wysyła token wyłącznie w nagłówku i nie pozwala wskazać innej osoby", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/copilot/tasks");
      expect(url.searchParams.has("user")).toBe(false);
      expect(url.searchParams.get("view")).toBe("open");
      expect(String(input)).not.toContain(TOKEN);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      return new Response(
        JSON.stringify({
          ok: true,
          generatedAt: "2026-08-19T10:00:00.000Z",
          data: {
            found: true,
            timezone: "Europe/Warsaw",
            user: { username: "michal", displayName: "Michał Skałba" },
            filter: {
              view: "open",
              today: "2026-08-19",
              dueFrom: null,
              dueTo: null,
            },
            summary: { returned: 1, overdue: 0, dueToday: 1, withoutDueDate: 0 },
            truncated: false,
            tasks: [
              {
                id: "t1",
                title: "Przygotować newsletter",
                description: null,
                status: "todo",
                statusLabel: "Do zrobienia",
                priority: 1,
                startDate: null,
                dueDate: "2026-08-19",
                estimateMinutes: 30,
                campaignName: null,
                entryTitle: null,
                entryChannel: null,
                checklist: { done: 0, total: 0 },
                blockedByOpenTasks: 0,
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const reader = new HttpMarketingPlannerReader({
      baseUrl: "https://marketing.brownhouseandtea.pl",
      token: TOKEN,
    });
    const result = await reader.listTasks({ view: "open", limit: 20 });
    expect(result.found).toBe(true);
    if (result.found) expect(result.tasks[0]?.title).toBe("Przygotować newsletter");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
