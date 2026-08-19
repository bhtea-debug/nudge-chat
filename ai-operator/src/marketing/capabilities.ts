import { z } from "zod";
import type { AnyCapability, Capability } from "../capability/types.js";
import type { MarketingPlannerReader } from "./client.js";
import { MarketingTaskView, MarketingTasksData } from "./contract.js";

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
  return [getMyTasks];
}
