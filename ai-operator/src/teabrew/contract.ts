import { z } from "zod";

/**
 * Kontrakt read-only między agentem a TeaBrew v2.
 *
 * Ten plik jest jedynym źródłem prawdy o kształcie odpowiedzi. Używają go:
 *  - klient HTTP (waliduje odpowiedź, zanim agent ją zobaczy),
 *  - dostawca na fiksturach (musi produkować dokładnie to samo),
 *  - fikstury kontraktowe w `fixtures/teabrew/` (testy zgodności),
 *  - łatka do teabrew-v2 w `teabrew-patch/` (implementuje ten kształt).
 *
 * Wzór wzięty z npd-studio (contracts/npd/v1 + fixtures + manifest): kontrakt
 * i fikstury, w tym negatywne, leżą w repo i są testowane, a nie opisane w mailu.
 */

export const CONTRACT_VERSION = "v1";
export const CONTRACT_ID = "teabrew.ai-operator.read.v1";

/** Ścieżki HTTP. Nazwane po konsumencie, jak wszystkie istniejące trasy w convex/http.ts. */
export const ROUTES = {
  order: "/ai-operator/order",
  salesSummary: "/ai-operator/sales-summary",
  stock: "/ai-operator/stock",
  productSearch: "/ai-operator/product-search",
  production: "/ai-operator/production",
  health: "/ai-operator/health",
} as const;

// ---------- wspólne ----------

const Envelope = <T extends z.ZodType>(data: T) =>
  z.object({
    ok: z.literal(true),
    ts: z.number().int(),
    contractVersion: z.literal(CONTRACT_VERSION),
    data,
  });

export const ErrorEnvelope = z.object({
  ok: z.literal(false),
  error: z.string(),
});

/** Znacznik czasu w ms albo null — nigdy zgadywana data. */
const Ts = z.number().int().nullable();

// ---------- zamówienie ----------

export const OrderItem = z.object({
  skuCode: z.string().nullable(),
  skuName: z.string().nullable(),
  qty: z.number(),
  fulfilledQty: z.number(),
  pricePLN: z.number().nullable(),
});

export const LinkedProductionOrder = z.object({
  number: z.string(),
  status: z.string(),
  targetQty: z.number(),
  batchNumber: z.string().nullable(),
  plannedStartAt: Ts,
  plannedEndAt: Ts,
  deadline: Ts,
});

export const Order = z.object({
  id: z.string(),
  source: z.string(),
  externalOrderId: z.string().nullable(),
  nexoZkNumber: z.string().nullable(),
  customerName: z.string().nullable(),
  placedAt: Ts,
  deadline: Ts,
  priority: z.number().nullable(),
  fulfillmentStatus: z.string(),
  paymentStatus: z.string().nullable(),
  paymentMethod: z.string().nullable(),
  courierType: z.string().nullable(),
  pickupPointName: z.string().nullable(),
  pickupReadyAt: Ts,
  totalPLN: z.number().nullable(),
  notes: z.string().nullable(),
  items: z.array(OrderItem),
  production: z.array(LinkedProductionOrder),
});

export const OrderResponse = Envelope(
  z.object({
    /**
     * Po którym polu udało się dopasować. "none" = nie znaleziono.
     * Agent musi umieć powiedzieć „nie znalazłem", więc puste dopasowanie
     * jest normalną, poprawną odpowiedzią, a nie błędem.
     */
    matchedBy: z.enum([
      "externalOrderId",
      "nexoZkNumber",
      "productionOrderNumber",
      "id",
      "none",
    ]),
    query: z.string(),
    count: z.number().int().nonnegative(),
    orders: z.array(Order),
  }),
);
export type OrderResponse = z.infer<typeof OrderResponse>;

// ---------- sprzedaż detaliczna ----------

export const SalesSource = z.enum(["medusa", "allegro"]);

const SalesBucket = z.object({
  orderCount: z.number().int().nonnegative(),
  grossSalesPLN: z.number(),
  unitsSold: z.number().nonnegative(),
});

export const SalesSummaryResponse = Envelope(
  z.object({
    from: z.string(),
    to: z.string(),
    timezone: z.literal("Europe/Warsaw"),
    definition: z.object({ included: z.string(), excluded: z.string() }),
    orderCount: z.number().int().nonnegative(),
    grossSalesPLN: z.number(),
    unitsSold: z.number().nonnegative(),
    averageOrderPLN: z.number(),
    channels: z.array(SalesBucket.extend({ source: SalesSource })),
    daily: z.array(SalesBucket.extend({ date: z.string() })),
    topProducts: z.array(
      z.object({
        skuCode: z.string().nullable(),
        name: z.string(),
        unitsSold: z.number().nonnegative(),
        grossSalesPLN: z.number(),
        orderCount: z.number().int().nonnegative(),
        unmapped: z.boolean(),
      }),
    ),
    productsTruncated: z.boolean(),
    dataQuality: z.object({
      unmappedLines: z.number().int().nonnegative(),
      ordersWithoutTotal: z.number().int().nonnegative(),
    }),
  }),
);
export type SalesSummaryResponse = z.infer<typeof SalesSummaryResponse>;

// ---------- stan magazynowy ----------

export const StockItem = z.object({
  code: z.string(),
  name: z.string().nullable(),
  /** Czy w ogóle istnieje materiał o tym kodzie. false = kodu nie ma w systemie. */
  hasMaterial: z.boolean(),
  onHand: z.number(),
  reservedProduction: z.number(),
  reservedShipment: z.number(),
  available: z.number(),
  /** Rezerwacje niepokryte stanem — sygnał operacyjny, nie szczegół arytmetyki. */
  shipmentReservationUncovered: z.number(),
  minStock: z.number().nullable(),
  uom: z.string().nullable(),
});

export const StockResponse = Envelope(
  z.object({
    profile: z.enum(["finished_goods", "all_locations"]),
    count: z.number().int().nonnegative(),
    items: z.array(StockItem),
    /** Kody, których nie ma w systemie — wypisane wprost, nie pominięte po cichu. */
    unknownCodes: z.array(z.string()),
  }),
);
export type StockResponse = z.infer<typeof StockResponse>;

// ---------- katalog ----------

export const SkuHit = z.object({
  code: z.string(),
  name: z.string(),
  /** Gramatura w GRAMACH, liczbą. W schemacie TeaBrew to `v.number()`, nie tekst. */
  gramaturaG: z.number().nullable(),
  productCategory: z.string().nullable(),
  ean: z.string().nullable(),
  isActive: z.boolean(),
  minStock: z.number().nullable(),
});

export const MaterialHit = z.object({
  code: z.string(),
  name: z.string(),
  type: z.string(),
  baseUom: z.string().nullable(),
  isActive: z.boolean(),
  minStock: z.number().nullable(),
  lotTracked: z.boolean(),
});

export const ProductSearchResponse = Envelope(
  z.object({
    query: z.string(),
    skus: z.array(SkuHit),
    materials: z.array(MaterialHit),
    totalCount: z.number().int().nonnegative(),
    /** true = wynik przycięty limitem, więc „nic więcej nie ma" byłoby nieprawdą. */
    truncated: z.boolean(),
  }),
);
export type ProductSearchResponse = z.infer<typeof ProductSearchResponse>;

// ---------- produkcja ----------

export const ProductionOrderRow = z.object({
  number: z.string(),
  status: z.string(),
  skuCode: z.string().nullable(),
  skuName: z.string().nullable(),
  targetQty: z.number(),
  batchNumber: z.string().nullable(),
  plannedStartAt: Ts,
  plannedEndAt: Ts,
  deadline: Ts,
  priority: z.number().nullable(),
  /** Numer/ID powiązanego zamówienia sprzedaży, jeśli produkcja jest „pod klienta". */
  salesOrderRef: z.string().nullable(),
});

export const ProductionRunRow = z.object({
  type: z.string(),
  status: z.string(),
  productionOrderNumber: z.string().nullable(),
  actualStartAt: Ts,
  actualEndAt: Ts,
  mixerName: z.string().nullable(),
});

export const ProductionResponse = Envelope(
  z.object({
    countByStatus: z.record(z.string(), z.number().int()),
    orders: z.array(ProductionOrderRow),
    activeRuns: z.array(ProductionRunRow),
    truncated: z.boolean(),
  }),
);
export type ProductionResponse = z.infer<typeof ProductionResponse>;

// ---------- health ----------

export const HealthResponse = Envelope(
  z.object({
    contractId: z.literal(CONTRACT_ID),
    readOnly: z.literal(true),
  }),
);
export type HealthResponse = z.infer<typeof HealthResponse>;
