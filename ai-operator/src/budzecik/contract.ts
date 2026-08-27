import { z } from "zod";

export const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IsoMonth = z.string().regex(/^\d{4}-\d{2}$/);

export const BudzecikResource = z.enum([
  "overview",
  "sales_progress",
  "budgets",
  "entries",
  "bank",
  "invoices",
  "sales",
  "purchase_orders",
  "p24",
]);
export type BudzecikResource = z.infer<typeof BudzecikResource>;

export const BudzecikRecordResource = z.enum([
  "entries",
  "bank",
  "invoices",
  "sales",
  "purchase_orders",
  "p24",
]);
export type BudzecikRecordResource = z.infer<typeof BudzecikRecordResource>;

export const BudzecikData = z.object({
  found: z.boolean(),
  resource: BudzecikResource.optional(),
  reason: z.string().optional(),
}).catchall(z.unknown());
export type BudzecikData = z.infer<typeof BudzecikData>;

/**
 * Publiczny wynik dla firmowego czatu. Schemat jest celowo ścisły: nawet gdyby
 * upstream omyłkowo dodał kwoty, rejestr capability odrzuci całą odpowiedź.
 */
export const BudzecikSalesProgress = z.object({
  found: z.boolean(),
  resource: z.literal("sales_progress"),
  month: IsoMonth,
  progressPercent: z.number().int().nonnegative().nullable(),
  completePlan: z.boolean(),
  plannedChannels: z.number().int().min(0).max(5),
  totalChannels: z.literal(5),
  definition: z.string().max(240),
}).strict();
export type BudzecikSalesProgress = z.infer<typeof BudzecikSalesProgress>;

export const BudzecikResponse = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  data: BudzecikData,
});
