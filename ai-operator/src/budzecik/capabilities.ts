import { z } from "zod";
import type { AnyCapability, Capability } from "../capability/types.js";
import type { BudzecikReader } from "./client.js";
import { BudzecikData, BudzecikRecordResource, IsoDay, IsoMonth } from "./contract.js";

const OverviewInput = z.object({
  from: IsoDay.optional().describe("Opcjonalny początek okresu YYYY-MM-DD"),
  to: IsoDay.optional().describe("Opcjonalny koniec okresu YYYY-MM-DD włącznie"),
});

const BudgetsInput = z.object({
  month: IsoMonth.optional().describe("Miesiąc YYYY-MM; domyślnie bieżący"),
  budgetId: z.string().max(80).optional().describe("Opcjonalny identyfikator budżetu"),
  limit: z.number().int().min(1).max(50).default(30),
});

const RecordsInput = z.object({
  resource: BudzecikRecordResource.describe(
    "entries=pozycje księgi/płatności, bank=operacje bankowe, invoices=KSeF, sales=sprzedaż i produkty, purchase_orders=zamówienia zakupowe, p24=wypłaty Przelewy24",
  ),
  from: IsoDay.optional(),
  to: IsoDay.optional(),
  query: z.string().max(160).optional().describe("Nazwa, numer, kontrahent, produkt albo fragment tekstu"),
  status: z.string().max(80).optional(),
  direction: z.enum(["inflow", "outflow"]).optional(),
  budgetId: z.string().max(80).optional(),
  channel: z.string().max(80).optional().describe("Kanał sprzedaży, np. Allegro lub Sklep Internetowy"),
  view: z.enum(["all", "unpaid", "overdue", "paid", "cashflow"]).default("all"),
  limit: z.number().int().min(1).max(50).default(20),
});

export function createBudzecikCapabilities(getReader: () => Promise<BudzecikReader>): AnyCapability[] {
  const overview: Capability<z.infer<typeof OverviewInput>, z.infer<typeof BudzecikData>> = {
    name: "budzecik_get_overview",
    version: "1.0.0",
    description:
      "Czyta zarządczy podgląd Budżecika: ostatnie saldo bankowe, wpływy, wypływy, zaległe płatności, nierozliczone operacje, liczbę faktur, sprzedaży, zakupów i wypłat P24. " +
      "Użyj przy ogólnych pytaniach o sytuację finansową lub stan Budżecika. Narzędzie jest read-only i nie może niczego zmienić.",
    scope: "budget:read",
    effectClass: "read",
    input: OverviewInput,
    output: BudzecikData,
    auditRefs: (input, output) => ({
      from: input.from ?? "all",
      to: input.to ?? "all",
      found: output?.found ?? false,
    }),
    handler: async (input, ctx) => (await getReader()).read({
      resource: "overview",
      from: input.from,
      to: input.to,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  };

  const budgets: Capability<z.infer<typeof BudgetsInput>, z.infer<typeof BudzecikData>> = {
    name: "budzecik_get_budgets",
    version: "1.0.0",
    description:
      "Czyta miesięczne budżety kosztowe z Budżecika: limity, wykonanie, zobowiązania, pozostałą kwotę i właściciela budżetu. " +
      "Użyj przy pytaniach o budżet miesiąca, przekroczenia albo konkretną grupę kosztów. Narzędzie jest read-only.",
    scope: "budget:read",
    effectClass: "read",
    input: BudgetsInput,
    output: BudzecikData,
    auditRefs: (input, output) => ({
      month: input.month ?? "current",
      budgetId: input.budgetId ?? "all",
      found: output?.found ?? false,
    }),
    handler: async (input, ctx) => (await getReader()).read({
      resource: "budgets",
      month: input.month,
      budgetId: input.budgetId,
      limit: input.limit,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  };

  const records: Capability<z.infer<typeof RecordsInput>, z.infer<typeof BudzecikData>> = {
    name: "budzecik_search_records",
    version: "1.0.0",
    description:
      "Przeszukuje dane Budżecika: pozycje cash-flow i płatności, operacje bankowe, faktury KSeF, sprzedaż wraz z produktami, zamówienia zakupowe oraz wypłaty Przelewy24. " +
      "Pozwala filtrować po dacie, nazwie/numerze, statusie, kierunku, budżecie i kanale. Użyj do szczegółowych pytań finansowych. Narzędzie jest read-only; nie zwraca plików dokumentów, pełnych rachunków ani surowych danych bankowych.",
    scope: "budget:read",
    effectClass: "read",
    input: RecordsInput,
    output: BudzecikData,
    auditRefs: (input, output) => ({
      resource: input.resource,
      from: input.from ?? "all",
      to: input.to ?? "all",
      found: output?.found ?? false,
    }),
    handler: async (input, ctx) => (await getReader()).read({
      ...input,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  };

  return [overview, budgets, records];
}
