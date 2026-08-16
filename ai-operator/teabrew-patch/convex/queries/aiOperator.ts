import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  buildMaterialIndex,
  salesAvailabilityByCode,
} from "../lib/salesAvailability";

/**
 * READ-ONLY dane operacyjne dla agenta inbox-operator.
 *
 * Wystawiane przez HTTP actions GET /ai-operator/* (http.ts, auth
 * `Authorization: Bearer <AI_OPERATOR_API_TOKEN>` — token WYŁĄCZNIE dla agenta,
 * osobny od tokenów Budżecika, B2B i Medusy).
 *
 * Zasady tego modułu:
 *
 *  1. Wyłącznie `internalQuery`. Ani jednej mutacji. Agent nie ma czym zmienić
 *     statusu, ceny, stanu magazynu ani utworzyć zamówienia.
 *  2. Stan magazynowy liczy WSPÓLNY helper `salesAvailabilityByCode`, ten sam,
 *     którego używa portal B2B i push do sklepu. Osobna arytmetyka dla AI
 *     oznaczałaby, że agent podaje inne liczby niż portal — i że któraś z nich
 *     jest nieprawdziwa.
 *  3. Brak danych jest zwracany JAWNIE (`matchedBy: "none"`, `unknownCodes`),
 *     nigdy jako zero ani jako pusty rekord. Agent musi umieć powiedzieć
 *     „nie znalazłem" i nie może mieć jak tego pomylić z „nie ma".
 *  4. Zwracamy tylko pola potrzebne do odpowiedzi na pytanie z maila.
 *     Nie wystawiamy tabel, wystawiamy odpowiedzi.
 */

const MAX_ORDERS = 10;
const MAX_ROWS = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Zamówienie po numerze z maila
// ─────────────────────────────────────────────────────────────────────────────

/**
 * W TeaBrew nie ma jednego „numeru zamówienia". Klient w mailu może podać
 * numer z Allegro/Medusy/B2B (`externalOrderId`), numer ZK z Nexo
 * (`nexoZkNumber`) albo numer zlecenia produkcyjnego (`productionOrders.number`).
 * Próbujemy po kolei i MÓWIMY, po czym udało się dopasować.
 */
export const orderByRef = internalQuery({
  args: { ref: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const ref = args.ref.trim();
    const limit = Math.min(Math.max(args.limit ?? 5, 1), MAX_ORDERS);
    if (!ref) {
      return { matchedBy: "none" as const, query: args.ref, count: 0, orders: [] };
    }

    let matchedBy:
      | "externalOrderId"
      | "nexoZkNumber"
      | "productionOrderNumber"
      | "id"
      | "none" = "none";
    let found: Doc<"orders">[] = [];

    // 1. externalOrderId — indeks by_external jest złożony (source, externalOrderId),
    //    a źródła nie znamy, więc filtrujemy po pełnym skanie zamówień z tym numerem.
    //    Zbiór zamówień jest na tyle mały, że to jest tańsze niż cztery zapytania po źródłach.
    const all = await ctx.db.query("orders").collect();

    found = all.filter((o) => (o.externalOrderId ?? "").trim() === ref);
    if (found.length > 0) matchedBy = "externalOrderId";

    // 2. numer ZK z Nexo.
    if (found.length === 0) {
      found = all.filter((o) => (o.nexoZkNumber ?? "").trim() === ref);
      if (found.length > 0) matchedBy = "nexoZkNumber";
    }

    // 3. numer zlecenia produkcyjnego — klient czasem cytuje numer z etykiety.
    if (found.length === 0) {
      const po = await ctx.db
        .query("productionOrders")
        .filter((q) => q.eq(q.field("number"), ref))
        .collect();
      const salesOrderIds = po
        .map((p) => p.salesOrderId)
        .filter((id): id is Id<"orders"> => Boolean(id));
      if (salesOrderIds.length > 0) {
        const ids = new Set(salesOrderIds.map(String));
        found = all.filter((o) => ids.has(String(o._id)));
        if (found.length > 0) matchedBy = "productionOrderNumber";
      }
    }

    // 4. wewnętrzne id — na wypadek numeru skopiowanego z panelu.
    if (found.length === 0) {
      const byId = all.filter((o) => String(o._id) === ref);
      if (byId.length > 0) {
        found = byId;
        matchedBy = "id";
      }
    }

    if (found.length === 0) {
      return { matchedBy: "none" as const, query: args.ref, count: 0, orders: [] };
    }

    found.sort((a, b) => (b.placedAt ?? b._creationTime) - (a.placedAt ?? a._creationTime));
    const page = found.slice(0, limit);

    const orders = await Promise.all(page.map((order) => shapeOrder(ctx, order)));
    return { matchedBy, query: args.ref, count: found.length, orders };
  },
});

async function shapeOrder(ctx: QueryCtx, order: Doc<"orders">) {
  const items = await ctx.db
    .query("orderItems")
    .withIndex("by_order", (q) => q.eq("orderId", order._id))
    .collect();

  const shapedItems = await Promise.all(
    items.map(async (item) => {
      const sku = item.skuId ? await ctx.db.get(item.skuId) : null;
      return {
        skuCode: sku?.code ?? null,
        skuName: sku?.name ?? null,
        qty: item.qty,
        fulfilledQty: item.fulfilledQty ?? 0,
        pricePLN: item.pricePLN ?? null,
      };
    }),
  );

  const production = await ctx.db
    .query("productionOrders")
    .withIndex("by_sales_order", (q) => q.eq("salesOrderId", order._id))
    .collect();

  let customerName: string | null = order.customerSnapshot?.name ?? null;
  if (!customerName && order.customerId) {
    const customer = await ctx.db.get(order.customerId);
    customerName = customer?.name ?? null;
  }
  if (!customerName && order.endCustomerId) {
    const endCustomer = await ctx.db.get(order.endCustomerId);
    customerName = endCustomer?.name ?? null;
  }

  return {
    id: String(order._id),
    source: order.source,
    externalOrderId: order.externalOrderId ?? null,
    nexoZkNumber: order.nexoZkNumber ?? null,
    customerName,
    placedAt: order.placedAt ?? order._creationTime ?? null,
    deadline: order.deadline ?? null,
    priority: order.priority ?? null,
    fulfillmentStatus: order.fulfillmentStatus,
    paymentStatus: order.paymentStatus ?? null,
    paymentMethod: order.paymentMethod ?? null,
    courierType: order.courierType ?? null,
    pickupPointName: order.pickupPointName ?? null,
    pickupReadyAt: order.pickupReadyAt ?? null,
    totalPLN: order.totalPLN ?? null,
    notes: order.notes ?? null,
    items: shapedItems,
    production: production.map((p) => ({
      number: p.number,
      status: p.status,
      targetQty: p.targetQty,
      batchNumber: p.batchNumber ?? null,
      plannedStartAt: p.plannedStartAt ?? null,
      plannedEndAt: p.plannedEndAt ?? null,
      deadline: p.deadline ?? null,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stan magazynowy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stan liczony WSPÓLNYM helperem, nie własną arytmetyką. Profil wybiera
 * semantykę: `finished_goods` = to, co widzi Allegro i sieci,
 * `all_locations` = to, co widzi sklep i portal B2B.
 */
export const stockByCodes = internalQuery({
  args: {
    codes: v.array(v.string()),
    profile: v.union(v.literal("finished_goods"), v.literal("all_locations")),
  },
  handler: async (ctx, args) => {
    const codes = [...new Set(args.codes.map((c) => c.trim()).filter(Boolean))].slice(0, 20);
    if (codes.length === 0) {
      return { profile: args.profile, count: 0, items: [], unknownCodes: [] };
    }

    const availability = await salesAvailabilityByCode(ctx, { codes, profile: args.profile });

    // MUSI to być ten sam indeks, którego użył kalkulator dostępności.
    // Dwa materiały mogą mieć ten sam `code` (herbata z tagiem "sku" oraz
    // akcesorium z woocommerce); kalkulator preferuje ten z tagiem "sku".
    // Naiwne „pierwszy o tym kodzie" opisałoby ilość jednego materiału nazwą
    // i jednostką drugiego — czyli podałoby liczbę o czymś innym, niż mówi nazwa.
    const materialFor = buildMaterialIndex(await ctx.db.query("materials").collect());

    const items: Array<Record<string, unknown>> = [];
    const unknownCodes: string[] = [];

    for (const code of codes) {
      const a = availability.get(code);
      const material = materialFor(code);
      // Brak materiału to NIE stan zero. Kod, którego nie ma w systemie,
      // wraca osobno — inaczej agent zaraportowałby „nie mamy" o czymś,
      // co po prostu nazywa się inaczej.
      if (!a || a.hasMaterial === false) {
        unknownCodes.push(code);
        continue;
      }
      items.push({
        code,
        name: material?.name ?? null,
        hasMaterial: true,
        onHand: a.onHand,
        reservedProduction: a.reservedProduction,
        reservedShipment: a.reservedShipment,
        available: a.available,
        shipmentReservationUncovered: a.shipmentReservationUncovered,
        minStock: material?.minStock ?? null,
        uom: material?.baseUom ?? null,
      });
    }

    return { profile: args.profile, count: items.length, items, unknownCodes };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Katalog: SKU i materiały po fragmencie nazwy lub kodu
// ─────────────────────────────────────────────────────────────────────────────

export const findProduct = internalQuery({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const needle = normalize(args.query);
    const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
    if (needle.length < 2) {
      return { query: args.query, skus: [], materials: [], totalCount: 0, truncated: false };
    }

    const hit = (code: string, name: string): boolean =>
      normalize(code).includes(needle) || normalize(name).includes(needle);

    const allSkus = (await ctx.db.query("skus").collect()).filter((s) => hit(s.code, s.name));
    const allMaterials = (await ctx.db.query("materials").collect()).filter((m) =>
      hit(m.code, m.name),
    );

    return {
      query: args.query,
      skus: allSkus.slice(0, limit).map((s) => ({
        code: s.code,
        name: s.name,
        // W schemacie to `v.optional(v.number())` — gramy liczbą, nie tekst.
        gramaturaG: s.gramatura ?? null,
        productCategory: s.productCategory ?? null,
        ean: s.ean ?? null,
        isActive: s.isActive !== false,
        minStock: s.minStock ?? null,
      })),
      materials: allMaterials.slice(0, limit).map((m) => ({
        code: m.code,
        name: m.name,
        type: m.type,
        baseUom: m.baseUom ?? null,
        isActive: m.isActive !== false,
        minStock: m.minStock ?? null,
        lotTracked: m.lotTracked === true,
      })),
      totalCount: allSkus.length + allMaterials.length,
      // Jawnie mówimy, że wynik jest przycięty — inaczej „nic więcej nie ma"
      // byłoby nieprawdą.
      truncated: allSkus.length > limit || allMaterials.length > limit,
    };
  },
});

/** Dopasowanie odporne na polskie znaki i wielkość liter. */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pl-PL")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Produkcja
// ─────────────────────────────────────────────────────────────────────────────

export const productionStatus = internalQuery({
  args: { limit: v.optional(v.number()), status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), MAX_ROWS);
    const all = await ctx.db.query("productionOrders").collect();

    const countByStatus: Record<string, number> = {};
    for (const p of all) countByStatus[p.status] = (countByStatus[p.status] ?? 0) + 1;

    const filtered = args.status ? all.filter((p) => p.status === args.status) : all;
    // Najpilniejsze najpierw: priorytet rosnąco, potem najbliższy termin.
    filtered.sort(
      (a, b) =>
        (a.priority ?? 99) - (b.priority ?? 99) ||
        (a.deadline ?? Number.MAX_SAFE_INTEGER) - (b.deadline ?? Number.MAX_SAFE_INTEGER),
    );
    const page = filtered.slice(0, limit);

    const orders = await Promise.all(
      page.map(async (p) => {
        const sku = p.skuId ? await ctx.db.get(p.skuId) : null;
        let salesOrderRef: string | null = null;
        if (p.salesOrderId) {
          const order = await ctx.db.get(p.salesOrderId);
          salesOrderRef = order?.externalOrderId ?? order?.nexoZkNumber ?? null;
        }
        return {
          number: p.number,
          status: p.status,
          skuCode: sku?.code ?? null,
          skuName: sku?.name ?? null,
          targetQty: p.targetQty,
          batchNumber: p.batchNumber ?? null,
          plannedStartAt: p.plannedStartAt ?? null,
          plannedEndAt: p.plannedEndAt ?? null,
          deadline: p.deadline ?? null,
          priority: p.priority ?? null,
          salesOrderRef,
        };
      }),
    );

    // Ruchy otwarte — „co się teraz dzieje na hali".
    //
    // UWAGA: `productionRunStatus` w schemacie to
    // pending | in_progress | paused | partially_done | done | cancelled.
    // NIE MA statusu "running". Zapytanie o "running" zwracałoby zawsze zero
    // wierszy, więc agent raportowałby „nic się nie produkuje" przy pracującej
    // hali — czyli cicho fałszywą odpowiedź, najgorszy możliwy błąd tutaj.
    //
    // Otwarte = `in_progress` (idzie teraz) oraz `paused` (zaczęte i stoi;
    // dla właściciela to sygnał, nie szum). `pending` to jeszcze nie start,
    // `partially_done` jest domykane przez zlecenie, więc oba pomijamy.
    const OPEN_RUN_STATUSES = ["in_progress", "paused"] as const;
    const openRuns = (
      await Promise.all(
        OPEN_RUN_STATUSES.map((status) =>
          ctx.db
            .query("productionRuns")
            .withIndex("by_status", (q) => q.eq("status", status))
            .take(MAX_ROWS),
        ),
      )
    )
      .flat()
      .slice(0, MAX_ROWS);

    const activeRuns = await Promise.all(
      openRuns.map(async (run) => {
        const po = run.productionOrderId ? await ctx.db.get(run.productionOrderId) : null;
        const mixer = run.mixerId ? await ctx.db.get(run.mixerId) : null;
        return {
          type: run.type,
          status: run.status,
          productionOrderNumber: po?.number ?? null,
          actualStartAt: run.actualStartAt ?? null,
          actualEndAt: run.actualEndAt ?? null,
          mixerName: mixer?.name ?? null,
        };
      }),
    );

    return { countByStatus, orders, activeRuns, truncated: filtered.length > limit };
  },
});
