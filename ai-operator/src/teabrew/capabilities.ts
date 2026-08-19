import { z } from "zod";
import type { AnyCapability, Capability } from "../capability/types.js";
import {
  OrderResponse,
  ProductSearchResponse,
  ProductionResponse,
  SalesSummaryResponse,
  StockResponse,
} from "./contract.js";
import type { TeabrewReader } from "./client.js";

/**
 * Cztery capability do danych operacyjnych. Nie wystawiamy „Convexa" —
 * wystawiamy cztery pytania, na które agent musi umieć odpowiedzieć:
 * co z tym zamówieniem, czy mamy ten towar, jak się nazywa to, o czym pisze
 * klient, i co się dzisiaj produkuje.
 *
 * TeaBrew v2 ma ponad sto tabel i kilkaset funkcji. Agent widzi cztery.
 */

const OrderInput = z.object({
  ref: z
    .string()
    .min(1)
    .max(64)
    .describe(
      "Numer zamówienia z maila. Może być numerem z Allegro/Medusy/B2B, numerem ZK z Nexo " +
        "albo numerem zlecenia produkcyjnego — system spróbuje po kolei.",
    ),
  limit: z.number().int().min(1).max(10).default(5),
});

const StockInput = z.object({
  codes: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(20)
    .describe(
      "Kody SKU lub kody materiałów. Jeśli znasz tylko nazwę, najpierw użyj teabrew_find_product.",
    ),
  profile: z
    .enum(["finished_goods", "all_locations"])
    .default("finished_goods")
    .describe(
      "finished_goods = stan sprzedażowy wyrobu gotowego (to, co widzi Allegro i sieci). " +
        "all_locations = wszystkie lokalizacje (to, co widzi sklep i portal B2B).",
    ),
});

const FindProductInput = z.object({
  query: z
    .string()
    .min(2)
    .max(80)
    .describe("Fragment nazwy lub kodu. Szuka jednocześnie w SKU i w materiałach/surowcach."),
  limit: z.number().int().min(1).max(25).default(10),
});

const ProductionInput = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  status: z
    .string()
    .optional()
    .describe("Opcjonalny filtr statusu zlecenia produkcyjnego. Pomiń, żeby zobaczyć wszystkie."),
});

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SalesSummaryInput = z.object({
  from: IsoDay.describe("Pierwszy dzień raportu, YYYY-MM-DD, w czasie Europe/Warsaw"),
  to: IsoDay.describe("Ostatni dzień raportu włącznie, YYYY-MM-DD, w czasie Europe/Warsaw"),
  sources: z
    .array(z.enum(["medusa", "allegro"]))
    .min(1)
    .max(2)
    .default(["medusa", "allegro"])
    .describe("medusa = sklep internetowy, allegro = Allegro"),
  topLimit: z.number().int().min(1).max(25).default(10),
});

export function createTeabrewCapabilities(
  getReader: () => Promise<TeabrewReader>,
): AnyCapability[] {
  const getOrderStatus: Capability<
    z.infer<typeof OrderInput>,
    z.infer<typeof OrderResponse>["data"]
  > = {
    name: "teabrew_get_order_status",
    version: "1.0.0",
    description:
      "Sprawdza w TeaBrew status zamówienia po numerze z maila: status realizacji, płatność, " +
      "termin, pozycje i powiązane zlecenia produkcyjne. " +
      "Jeśli matchedBy = \"none\", zamówienia o tym numerze NIE MA w TeaBrew — powiedz to wprost, " +
      "nie zgaduj statusu i nie podawaj danych z maila jako danych z systemu.",
    scope: "erp:read",
    effectClass: "read",
    input: OrderInput,
    output: OrderResponse.shape.data,
    auditRefs: (input, output) => ({
      ref: input.ref,
      matchedBy: output?.matchedBy ?? "error",
      count: output?.count ?? 0,
    }),
    handler: async (input, ctx) =>
      (await getReader()).getOrder({
        query: input.ref,
        limit: input.limit,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  const getStock: Capability<
    z.infer<typeof StockInput>,
    z.infer<typeof StockResponse>["data"]
  > = {
    name: "teabrew_get_stock",
    version: "1.0.0",
    description:
      "Zwraca stan magazynowy dla podanych kodów: stan fizyczny, rezerwacje produkcyjne " +
      "i wysyłkowe oraz ilość faktycznie dostępną do sprzedaży. " +
      "Kody wypisane w unknownCodes nie istnieją w systemie — nie interpretuj ich jako stanu zero. " +
      "Liczby pochodzą z tego samego wyliczenia, którego używa portal B2B i push do sklepu.",
    scope: "erp:read",
    effectClass: "read",
    input: StockInput,
    output: StockResponse.shape.data,
    auditRefs: (input, output) => ({
      codes: input.codes.join(","),
      profile: input.profile,
      found: output?.count ?? 0,
      unknown: output?.unknownCodes.length ?? 0,
    }),
    handler: async (input, ctx) =>
      (await getReader()).getStock({
        codes: input.codes,
        profile: input.profile,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  const findProduct: Capability<
    z.infer<typeof FindProductInput>,
    z.infer<typeof ProductSearchResponse>["data"]
  > = {
    name: "teabrew_find_product",
    version: "1.0.0",
    description:
      "Szuka produktu (SKU) albo surowca/materiału po fragmencie nazwy lub kodu. " +
      "Użyj, gdy klient pisze nazwą handlową, a Ty potrzebujesz kodu do teabrew_get_stock. " +
      "Gdy wynik ma więcej niż jedno trafienie, wypisz je i nie wybieraj za człowieka. " +
      "Pusty wynik znaczy, że w katalogu nie ma nic pasującego do tej frazy.",
    scope: "erp:read",
    effectClass: "read",
    input: FindProductInput,
    output: ProductSearchResponse.shape.data,
    auditRefs: (input, output) => ({
      query: input.query,
      skus: output?.skus.length ?? 0,
      materials: output?.materials.length ?? 0,
    }),
    handler: async (input, ctx) =>
      (await getReader()).searchProducts({
        query: input.query,
        limit: input.limit,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  const getProductionStatus: Capability<
    z.infer<typeof ProductionInput>,
    z.infer<typeof ProductionResponse>["data"]
  > = {
    name: "teabrew_get_production_status",
    version: "1.0.0",
    description:
      "Pokazuje bieżącą produkcję: zlecenia produkcyjne ze statusami, planowanymi terminami " +
      "i numerami partii, oraz uruchomione ruchy produkcyjne. Użyj przy pytaniu „jak wygląda " +
      "produkcja” i przy sprawdzaniu, czy zamówienie klienta ma pokrycie w planie.",
    scope: "erp:read",
    effectClass: "read",
    input: ProductionInput,
    output: ProductionResponse.shape.data,
    auditRefs: (input, output) => ({
      ...(input.status ? { status: input.status } : {}),
      orders: output?.orders.length ?? 0,
      activeRuns: output?.activeRuns.length ?? 0,
    }),
    handler: async (input, ctx) =>
      (await getReader()).getProduction({
        limit: input.limit,
        ...(input.status ? { status: input.status } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  const getSalesSummary: Capability<
    z.infer<typeof SalesSummaryInput>,
    z.infer<typeof SalesSummaryResponse>["data"]
  > = {
    name: "teabrew_get_sales_summary",
    version: "1.0.0",
    description:
      "Raportuje opłaconą sprzedaż detaliczną z TeaBrew dla zakresu dni: liczbę zamówień, " +
      "wartość brutto, sprzedane sztuki, średnią, rozbicie sklep internetowy/Allegro, " +
      "sprzedaż dzienną i najlepiej sprzedające się produkty. Nie zwraca danych klientów. " +
      "Nie liczy anulowanych ani nieopłaconych zamówień i nie odejmuje zwrotów.",
    scope: "erp:read",
    effectClass: "read",
    input: SalesSummaryInput,
    output: SalesSummaryResponse.shape.data,
    auditRefs: (input, output) => ({
      from: input.from,
      to: input.to,
      sources: input.sources.join(","),
      orders: output?.orderCount ?? 0,
    }),
    handler: async (input, ctx) =>
      (await getReader()).getSalesSummary({
        from: input.from,
        to: input.to,
        sources: input.sources,
        topLimit: input.topLimit,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
  };

  return [getOrderStatus, getStock, findProduct, getProductionStatus, getSalesSummary];
}
