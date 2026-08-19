import { z } from "zod";

export const MarketingTaskView = z.enum(["open", "today", "overdue", "done", "all"]);
export type MarketingTaskView = z.infer<typeof MarketingTaskView>;

export const MarketingTask = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  priority: z.number(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  estimateMinutes: z.number().nullable(),
  campaignName: z.string().nullable(),
  entryTitle: z.string().nullable(),
  entryChannel: z.string().nullable(),
  checklist: z.object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  blockedByOpenTasks: z.number().int().nonnegative(),
});

const FoundTasks = z.object({
  found: z.literal(true),
  timezone: z.literal("Europe/Warsaw"),
  user: z.object({ username: z.string(), displayName: z.string() }),
  filter: z.object({
    view: MarketingTaskView,
    today: z.string(),
    dueFrom: z.string().nullable(),
    dueTo: z.string().nullable(),
  }),
  summary: z.object({
    returned: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    dueToday: z.number().int().nonnegative(),
    withoutDueDate: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
  tasks: z.array(MarketingTask),
});

const MissingUser = z.object({
  found: z.literal(false),
  reason: z.enum(["user_not_found", "ambiguous_user"]),
  tasks: z.tuple([]),
});

export const MarketingTasksData = z.discriminatedUnion("found", [
  FoundTasks,
  MissingUser,
]);
export type MarketingTasksData = z.infer<typeof MarketingTasksData>;

export const MarketingTasksResponse = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  data: MarketingTasksData,
});
