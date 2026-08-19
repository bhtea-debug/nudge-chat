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

export const MarketingCampaignView = z.enum([
  "open",
  "planned",
  "active",
  "done",
  "all",
]);
export type MarketingCampaignView = z.infer<typeof MarketingCampaignView>;

export const MarketingCampaign = z.object({
  id: z.string(),
  name: z.string(),
  brief: z.string().nullable(),
  goal: z.string().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  ownerName: z.string().nullable(),
  entries: z.number().int().nonnegative(),
  tasks: z.object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
  }),
});

export const MarketingScheduleEntry = z.object({
  id: z.string(),
  title: z.string(),
  brief: z.string().nullable(),
  type: z.string(),
  typeLabel: z.string(),
  channel: z.string(),
  startDate: z.string(),
  endDate: z.string().nullable(),
  startTime: z.string().nullable(),
  status: z.string(),
  statusLabel: z.string(),
  campaignName: z.string().nullable(),
  ownerName: z.string().nullable(),
  tasks: z.object({
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export const MarketingScheduleData = z.object({
  timezone: z.literal("Europe/Warsaw"),
  filter: z.object({ from: z.string(), to: z.string() }),
  summary: z.object({
    entries: z.number().int().nonnegative(),
    campaigns: z.number().int().nonnegative(),
    byStatus: z.record(z.string(), z.number().int().nonnegative()),
  }),
  truncated: z.boolean(),
  entries: z.array(MarketingScheduleEntry),
  campaigns: z.array(MarketingCampaign),
});
export type MarketingScheduleData = z.infer<typeof MarketingScheduleData>;

export const MarketingCampaignsData = z.object({
  timezone: z.literal("Europe/Warsaw"),
  filter: z.object({ view: MarketingCampaignView, today: z.string() }),
  summary: z.object({
    returned: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    planned: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
  campaigns: z.array(MarketingCampaign),
});
export type MarketingCampaignsData = z.infer<typeof MarketingCampaignsData>;

export const MarketingScheduleResponse = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  data: MarketingScheduleData,
});

export const MarketingCampaignsResponse = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  data: MarketingCampaignsData,
});
