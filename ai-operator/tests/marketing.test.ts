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

  it("czyta harmonogram i kampanie przez osobne, read-only tryby", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/copilot/marketing");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(init?.method).toBe("GET");
      const common = { ok: true, generatedAt: "2026-08-19T10:00:00.000Z" };
      if (url.searchParams.get("mode") === "schedule") {
        expect(url.searchParams.get("from")).toBe("2026-08-20");
        expect(url.searchParams.get("to")).toBe("2026-08-20");
        return Response.json({
          ...common,
          data: {
            timezone: "Europe/Warsaw",
            filter: { from: "2026-08-20", to: "2026-08-20" },
            summary: { entries: 1, campaigns: 0, byStatus: { approved: 1 } },
            truncated: false,
            entries: [{
              id: "e1",
              title: "Post na jutro",
              brief: null,
              type: "post",
              typeLabel: "Post",
              channel: "instagram",
              startDate: "2026-08-20",
              endDate: null,
              startTime: "10:00",
              status: "approved",
              statusLabel: "Zatwierdzone",
              campaignName: null,
              ownerName: "Michał",
              tasks: { done: 1, total: 1 },
            }],
            campaigns: [],
          },
        });
      }
      expect(url.searchParams.get("mode")).toBe("campaigns");
      expect(url.searchParams.get("view")).toBe("open");
      return Response.json({
        ...common,
        data: {
          timezone: "Europe/Warsaw",
          filter: { view: "open", today: "2026-08-19" },
          summary: { returned: 1, active: 1, planned: 0 },
          truncated: false,
          campaigns: [{
            id: "c1",
            name: "Jesienna herbata",
            brief: null,
            goal: null,
            status: "active",
            statusLabel: "W trakcie",
            startDate: "2026-08-19",
            endDate: "2026-08-25",
            ownerName: "Michał",
            entries: 2,
            tasks: { done: 1, total: 2, overdue: 0 },
          }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reader = new HttpMarketingPlannerReader({
      baseUrl: "https://marketing.brownhouseandtea.pl",
      token: TOKEN,
    });
    const schedule = await reader.getSchedule({
      from: "2026-08-20",
      to: "2026-08-20",
      limit: 20,
    });
    expect(schedule.entries[0]?.title).toBe("Post na jutro");
    const campaigns = await reader.listCampaigns({ view: "open", limit: 20 });
    expect(campaigns.campaigns[0]?.name).toBe("Jesienna herbata");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
