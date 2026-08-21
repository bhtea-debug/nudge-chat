import { z } from "zod";
import {
  CapabilityError,
  type AnyCapability,
  type Capability,
  type CapabilityContext,
} from "../capability/types.js";
import {
  CustomerCaseMessagesResponse,
  CustomerCaseResponse,
  CustomerCasesResponse,
  CustomerCaseSearchResponse,
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

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "oczekiwano daty YYYY-MM-DD");

const SalesSummaryInput = z.object({
  from: IsoDay.describe("Pierwszy dzień raportu w strefie Europe/Warsaw"),
  to: IsoDay.describe("Ostatni dzień raportu włącznie, w strefie Europe/Warsaw"),
  sources: z
    .array(z.enum(["medusa", "allegro"]))
    .min(1)
    .max(2)
    .default(["medusa", "allegro"])
    .describe("medusa = sklep internetowy, allegro = Allegro"),
  topLimit: z.number().int().min(1).max(25).default(10),
});

export const CustomerContentPurpose = z.enum([
  "authorized_chat_view",
  "user_requested_review",
  "user_requested_summary",
  "user_requested_draft",
]);

const ContentRequestFields = {
  includeContent: z.boolean().default(false),
  purpose: CustomerContentPurpose.optional().describe(
    "Wymagane przy includeContent=true. Widok pokazuje treść tylko uprawnionemu użytkownikowi; " +
      "review/summary/draft oznaczają jawne żądanie użytkownika i zwracają tekst zminimalizowany dla modelu.",
  ),
} as const;

const ListCustomerCasesInput = z
  .object({
    state: z.enum(["new", "open", "all"]).default("open"),
    limit: z.number().int().min(1).max(100).default(30),
    cursor: z.string().min(1).max(4_096).optional().describe(
      "Nieprzezroczysty kursor kolejnej strony; tylko dla state=all.",
    ),
    ...ContentRequestFields,
  })
  .superRefine((input, ctx) => {
    requirePurposeForContent(input, ctx);
    if (input.cursor && input.state !== "all") {
      ctx.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "cursor jest obsługiwany tylko dla state=all",
      });
    }
  });

const CustomerCaseDetailInput = z
  .object({
    id: z.string().min(1).max(128),
    ...ContentRequestFields,
  })
  .superRefine(requirePurposeForContent);

const CustomerCaseMessagesInput = z.object({
  id: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(100).default(50),
  purpose: CustomerContentPurpose.describe(
    "Historia zawiera treść klienta, dlatego cel odczytu jest obowiązkowy.",
  ),
});

const SearchCustomerCasesInput = z
  .object({
    query: z.string().min(1).max(128),
    by: z.enum(["order", "buyer"]),
    limit: z.number().int().min(1).max(100).default(30),
    ...ContentRequestFields,
  })
  .superRefine(requirePurposeForContent);

function requirePurposeForContent(
  input: { includeContent: boolean; purpose?: z.infer<typeof CustomerContentPurpose> },
  ctx: z.RefinementCtx,
): void {
  if (input.includeContent && !input.purpose) {
    ctx.addIssue({
      code: "custom",
      path: ["purpose"],
      message: "purpose jest wymagane, gdy includeContent=true",
    });
  }
}

function requireCustomerContent(
  ctx: CapabilityContext,
  purpose?: z.infer<typeof CustomerContentPurpose>,
): void {
  if (!ctx.scopes.includes("customer_cases:content")) {
    throw new CapabilityError(
      "forbidden_scope",
      "odczyt treści klienta wymaga osobnego zakresu customer_cases:content",
    );
  }
  if (
    purpose === "authorized_chat_view" &&
    !ctx.scopes.includes("customer_cases:display")
  ) {
    throw new CapabilityError(
      "forbidden_scope",
      "niezredagowany widok klienta jest dostępny wyłącznie zaufanemu firmowemu czatowi",
    );
  }
}

function contentMode(
  purpose: z.infer<typeof CustomerContentPurpose> | undefined,
): "display" | "model" {
  return purpose === "authorized_chat_view" ? "display" : "model";
}

export function createTeabrewCapabilities(
  getReader: () => Promise<TeabrewReader>,
): AnyCapability[] {
  const getSalesSummary: Capability<
    z.infer<typeof SalesSummaryInput>,
    z.infer<typeof SalesSummaryResponse>["data"]
  > = {
    name: "teabrew_get_sales_summary",
    version: "1.0.0",
    description:
      "Czyta bezpośrednio z TeaBrew raport sprzedaży sklepu internetowego (Medusa) i Allegro " +
      "dla dnia lub zakresu dat: liczbę opłaconych zamówień, wartość sprzedaży, liczbę sztuk, " +
      "kanały i najlepiej sprzedające się produkty. Użyj zawsze przy pytaniach ile było zamówień " +
      "w sklepie/Allegro albo co się sprzedało. Wynik nie zawiera danych klientów i jest read-only.",
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

  const listAllegroCustomerCases: Capability<
    z.infer<typeof ListCustomerCasesInput>,
    z.infer<typeof CustomerCasesResponse>["data"]
  > = {
    name: "teabrew_list_allegro_customer_cases",
    version: "1.0.0",
    description:
      "Czyta z TeaBrew jedną kolejkę nowych lub otwartych zapytań klientów Allegro z Centrum " +
      "Wiadomości i starych Dyskusji. Zwraca źródło, status, priorytet P0/P1/P2, termin odpowiedzi " +
      "stan SLA oraz wersjonowaną klasyfikację potrzeby odpowiedzi. Domyślnie nie zwraca treści. " +
      "Treść wolno pobrać wyłącznie dla uprawnionego " +
      "widoku albo po jawnym żądaniu analizy; nigdy automatycznie. Zawsze pokaż użytkownikowi " +
      "freshness, szczególnie missing_scope/reconnect_required/stale/error. Narzędzie niczego nie " +
      "wysyła do Allegro i nie zmienia spraw.",
    scope: "customer_cases:read",
    effectClass: "read",
    input: ListCustomerCasesInput,
    output: CustomerCasesResponse.shape.data,
    auditRefs: (input, output) => ({
      state: input.state,
      count: output?.count ?? 0,
      contentIncluded: output?.contentIncluded ?? false,
      ...(input.purpose ? { purpose: input.purpose } : {}),
    }),
    handler: async (input, ctx) => {
      if (input.includeContent) requireCustomerContent(ctx, input.purpose);
      return (await getReader()).listCustomerCases({
        state: input.state,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        includeContent: input.includeContent,
        contentMode: contentMode(input.purpose),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
  };

  const getAllegroCustomerCase: Capability<
    z.infer<typeof CustomerCaseDetailInput>,
    z.infer<typeof CustomerCaseResponse>["data"]
  > = {
    name: "teabrew_get_allegro_customer_case",
    version: "1.0.0",
    description:
      "Czyta szczegóły jednej sprawy klienta Allegro z cache TeaBrew. Domyślnie zwraca wyłącznie " +
      "metadane; treść wymaga jawnego purpose i osobnego zakresu. Sprawdź found oraz freshness i " +
      "nie przedstawiaj nieświeżych danych jako bieżących. Nie wysyła odpowiedzi ani komentarzy.",
    scope: "customer_cases:read",
    effectClass: "read",
    input: CustomerCaseDetailInput,
    output: CustomerCaseResponse.shape.data,
    auditRefs: (input, output) => ({
      caseId: input.id,
      found: output?.found ?? false,
      contentIncluded: output?.contentIncluded ?? false,
      ...(input.purpose ? { purpose: input.purpose } : {}),
    }),
    handler: async (input, ctx) => {
      if (input.includeContent) requireCustomerContent(ctx, input.purpose);
      return (await getReader()).getCustomerCase({
        id: input.id,
        includeContent: input.includeContent,
        contentMode: contentMode(input.purpose),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
  };

  const getAllegroCustomerCaseMessages: Capability<
    z.infer<typeof CustomerCaseMessagesInput>,
    z.infer<typeof CustomerCaseMessagesResponse>["data"]
  > = {
    name: "teabrew_get_allegro_customer_case_messages",
    version: "1.0.0",
    description:
      "Czyta historię wiadomości jednej sprawy Allegro wyłącznie na jawne żądanie uprawnionego " +
      "użytkownika. Dla analizy/podsumowania/szkicu TeaBrew zwraca tekst zminimalizowany i " +
      "zredagowany; załączniki nigdy nie trafiają do modelu. attachmentsExcluded=true oznacza, " +
      "że narzędzie nie udostępnia plików. Zawsze pokaż freshness. Brak jakiejkolwiek funkcji wysyłki.",
    scope: "customer_cases:content",
    effectClass: "read",
    input: CustomerCaseMessagesInput,
    output: CustomerCaseMessagesResponse.shape.data,
    auditRefs: (input, output) => ({
      caseId: input.id,
      count: output?.count ?? 0,
      purpose: input.purpose,
      mode: contentMode(input.purpose),
    }),
    handler: async (input, ctx) => {
      requireCustomerContent(ctx, input.purpose);
      return (await getReader()).getCustomerCaseMessages({
        id: input.id,
        limit: input.limit,
        contentMode: contentMode(input.purpose),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
  };

  const searchAllegroCustomerCases: Capability<
    z.infer<typeof SearchCustomerCasesInput>,
    z.infer<typeof CustomerCaseSearchResponse>["data"]
  > = {
    name: "teabrew_search_allegro_customer_cases",
    version: "1.0.0",
    description:
      "Wyszukuje sprawy Allegro po numerze zamówienia albo loginie kupującego w cache TeaBrew. " +
      "Domyślnie ukrywa treść i dane wyświetlane klienta. Treść wymaga osobnego uprawnienia oraz " +
      "jawnego celu. Fraza wyszukiwania nie jest zapisywana w audycie. Zawsze raportuj freshness; " +
      "narzędzie jest wyłącznie do odczytu.",
    scope: "customer_cases:read",
    effectClass: "read",
    input: SearchCustomerCasesInput,
    output: CustomerCaseSearchResponse.shape.data,
    auditRefs: (input, output) => ({
      by: input.by,
      count: output?.count ?? 0,
      contentIncluded: output?.contentIncluded ?? false,
      ...(input.purpose ? { purpose: input.purpose } : {}),
    }),
    handler: async (input, ctx) => {
      // Login kupującego jest danymi klienta również wtedy, gdy wynik zwraca
      // tylko metadane. Samo wyszukanie po loginie wymaga zakresu treści.
      if (input.by === "buyer" || input.includeContent) {
        requireCustomerContent(ctx, input.purpose);
      }
      return (await getReader()).searchCustomerCases({
        query: input.query,
        by: input.by,
        limit: input.limit,
        includeContent: input.includeContent,
        contentMode: contentMode(input.purpose),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    },
  };

  return [
    getOrderStatus,
    getSalesSummary,
    getStock,
    findProduct,
    getProductionStatus,
    listAllegroCustomerCases,
    getAllegroCustomerCase,
    getAllegroCustomerCaseMessages,
    searchAllegroCustomerCases,
  ];
}
