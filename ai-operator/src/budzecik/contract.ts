import { z } from "zod";

export const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const IsoMonth = z.string().regex(/^\d{4}-\d{2}$/);

export const BudzecikResource = z.enum([
  "overview",
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

export const BudzecikResponse = z.object({
  ok: z.literal(true),
  generatedAt: z.string(),
  data: BudzecikData,
});
