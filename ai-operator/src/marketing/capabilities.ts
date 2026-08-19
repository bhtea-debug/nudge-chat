import { z } from "zod";
import type { AnyCapability, Capability } from "../capability/types.js";
import type { MarketingPlannerReader } from "./client.js";
import {
  MarketingCampaignsData,
  MarketingCampaignView,
  MarketingScheduleData,
  MarketingTaskView,
  MarketingTasksData,
} from "./contract.js";

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const MyTasksInput = z.object({
  view: MarketingTaskView.default("open").describe(
    "open = wszystkie niezakończone, today = termin dziś, overdue = zaległe, done = zakończone, all = wszystkie",
  ),
  dueFrom: IsoDay.optional().describe(
    "Opcjonalny początek terminu zadania YYYY-MM-DD",
  ),
  dueTo: IsoDay.optional().describe(
    "Opcjonalny koniec terminu zadania YYYY-MM-DD",
  ),
  limit: z.number().int().min(1).max(30).default(20),
});

const ScheduleInput = z.object({
  from: IsoDay.describe("Początek zakresu YYYY-MM-DD w czasie Europe/Warsaw"),
  to: IsoDay.describe("Koniec zakresu YYYY-MM-DD włącznie, maksymalnie 92 dni od from"),
  limit: z.number().int().min(1).max(50).default(30),
});

const CampaignsInput = z.object({
  view: MarketingCampaignView.default("open").describe(
    "open = planowane i aktywne, planned = planowane, active = trwające, done = zakończone, all = wszystkie",
  ),
  limit: z.number().int().min(1).max(50).default(30),
});

export function createMarketingCapabilities(
  getReader: () => Promise<MarketingPlannerReader>,
): AnyCapability[] {
  const getMyTasks: Capability<
    z.infer<typeof MyTasksInput>,
    z.infer<typeof MarketingTasksData>
  > = {
    name: "marketing_get_my_tasks",
    version: "1.0.0",
    description:
      "Czyta zadania właściciela konektora z Planera Marketingowego BHT. " +
      "Użyj przy pytaniach „jakie mam zadania”, „co mam dziś”, „co jest zaległe” lub o zadania z zakresu dat. " +
      "Tożsamość jest przypięta do tokenu po stronie Planera i nie może zostać zmieniona argumentem. " +
      "Narzędzie nie może tworzyć ani zmieniać zadań.",
    scope: "planner:read",
    effectClass: "read",
    input: MyTasksInput,
    output: MarketingTasksData,
    auditRefs: (input, output) => ({
      view: input.view,
      found: output?.found ?? false,
      returned: output?.found ? output.summary.returned : 0,
      truncated: output?.found ? output.truncated : false,
    }),
    handler: async (input, ctx) =>
      (await getReader()).listTasks({
        view: input.view,
        dueFrom: input.dueFrom,
        dueTo: input.dueTo,
        limit: input.limit,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  const getSchedule: Capability<
    z.infer<typeof ScheduleInput>,
    z.infer<typeof MarketingScheduleData>
  > = {
    name: "marketing_get_schedule",
    version: "1.0.0",
    description:
      "Czyta firmowy plan marketingowy z Planera dla konkretnego dnia lub zakresu dat. " +
      "Zwraca zaplanowane publikacje, akcje, kanały, godziny, statusy i kampanie nachodzące na zakres. " +
      "Użyj dla pytań „co planujemy jutro”, „jaki jest plan marketingowy na dzień/tydzień” albo „co publikujemy”. " +
      "Narzędzie jest wyłącznie do odczytu.",
    scope: "planner:read",
    effectClass: "read",
    input: ScheduleInput,
    output: MarketingScheduleData,
    auditRefs: (input, output) => ({
      from: input.from,
      to: input.to,
      entries: output?.summary.entries ?? 0,
      campaigns: output?.summary.campaigns ?? 0,
      truncated: output?.truncated ?? false,
    }),
    handler: async (input, ctx) =>
      (await getReader()).getSchedule({
        from: input.from,
        to: input.to,
        limit: input.limit,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  const listCampaigns: Capability<
    z.infer<typeof CampaignsInput>,
    z.infer<typeof MarketingCampaignsData>
  > = {
    name: "marketing_list_campaigns",
    version: "1.0.0",
    description:
      "Czyta kampanie z Planera Marketingowego: nazwę, brief, cel, status, terminy, właściciela i zagregowany postęp. " +
      "Użyj dla pytań o aktywne, planowane, zakończone lub wszystkie kampanie. Narzędzie jest wyłącznie do odczytu.",
    scope: "planner:read",
    effectClass: "read",
    input: CampaignsInput,
    output: MarketingCampaignsData,
    auditRefs: (input, output) => ({
      view: input.view,
      returned: output?.summary.returned ?? 0,
      truncated: output?.truncated ?? false,
    }),
    handler: async (input, ctx) =>
      (await getReader()).listCampaigns({
        view: input.view,
        limit: input.limit,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  return [getMyTasks, getSchedule, listCampaigns];
}
