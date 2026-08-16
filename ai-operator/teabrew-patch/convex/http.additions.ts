/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DO WKLEJENIA W convex/http.ts (TeaBrew v2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * To nie jest samodzielny moduł. Wklej bloki `http.route({...})` poniżej do
 * istniejącego `convex/http.ts`, PRZED linią `export default http;`.
 *
 * Ten plik nie wymaga nowych importów: `httpAction`, `internal`, `jsonResponse`
 * i `constantTimeTextEqual` są już w http.ts. Wzorzec autoryzacji jest
 * skopiowany 1:1 z istniejących tras `/budzeciek/*`.
 *
 * Wymagana zmienna środowiskowa Convex:
 *   AI_OPERATOR_API_TOKEN — token WYŁĄCZNIE dla agenta inbox-operator.
 *   Osobny od tokenów pozostałych konsumentów tego API: jeden konsument, jeden
 *   token, minimalne uprawnienia. Odebranie agentowi dostępu ma być usunięciem
 *   jednej zmiennej, a nie rotacją tokenów wszystkich aplikacji.
 *
 * Wszystkie pięć tras to GET i wszystkie wołają wyłącznie `internalQuery`.
 * Nie ma tu ani jednej mutacji — agent nie ma czym nic zmienić w TeaBrew.
 */

// ─── wspólna autoryzacja dla tras agenta ─────────────────────────────────────
// Wklej tę funkcję razem z trasami (obok istniejącego `constantTimeTextEqual`).

function authorizeAiOperator(request: Request): Response | null {
  const token = process.env.AI_OPERATOR_API_TOKEN?.trim();
  if (!token) {
    return jsonResponse({ ok: false, error: "AI_OPERATOR_API_TOKEN not configured" }, 500);
  }
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!provided || !constantTimeTextEqual(provided, token)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  return null;
}

const AI_OPERATOR_CONTRACT_VERSION = "v1";

function aiOperatorOk(data: unknown): Response {
  return jsonResponse({
    ok: true,
    ts: Date.now(),
    contractVersion: AI_OPERATOR_CONTRACT_VERSION,
    data,
  });
}

function intParam(request: Request, name: string, fallback: number): number {
  const raw = new URL(request.url).searchParams.get(name);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// ─── GET /ai-operator/health ─────────────────────────────────────────────────

http.route({
  path: "/ai-operator/health",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const denied = authorizeAiOperator(request);
    if (denied) return denied;
    return aiOperatorOk({ contractId: "teabrew.ai-operator.read.v1", readOnly: true });
  }),
});

// ─── GET /ai-operator/order?ref=12345&limit=5 ────────────────────────────────
//
// `ref` może być numerem zewnętrznym, numerem ZK z Nexo albo numerem zlecenia
// produkcyjnego. Odpowiedź MÓWI, po którym polu udało się dopasować.
// Brak dopasowania to `matchedBy: "none"` i HTTP 200 — „nie znalazłem" jest
// poprawną odpowiedzią, nie błędem.

http.route({
  path: "/ai-operator/order",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const denied = authorizeAiOperator(request);
    if (denied) return denied;

    const ref = new URL(request.url).searchParams.get("ref")?.trim() ?? "";
    if (!ref) return jsonResponse({ ok: false, error: "brak parametru ref" }, 400);

    try {
      const data = await ctx.runQuery(internal.queries.aiOperator.orderByRef, {
        ref,
        limit: intParam(request, "limit", 5),
      });
      return aiOperatorOk(data);
    } catch (e: any) {
      console.error("ai-operator/order error:", e?.message, e?.stack);
      return jsonResponse({ ok: false, error: e?.message ?? String(e) }, 500);
    }
  }),
});

// ─── GET /ai-operator/stock?codes=A,B&profile=finished_goods ─────────────────
//
// Stan liczy ten sam helper, którego używa portal B2B i push do sklepu.
// Kody nieznane w systemie wracają w `unknownCodes` — nigdy jako stan zero.

http.route({
  path: "/ai-operator/stock",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const denied = authorizeAiOperator(request);
    if (denied) return denied;

    const params = new URL(request.url).searchParams;
    const codes = (params.get("codes") ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (codes.length === 0) return jsonResponse({ ok: false, error: "brak parametru codes" }, 400);

    const rawProfile = params.get("profile") ?? "finished_goods";
    if (rawProfile !== "finished_goods" && rawProfile !== "all_locations") {
      return jsonResponse(
        { ok: false, error: 'profile musi być "finished_goods" albo "all_locations"' },
        400,
      );
    }

    try {
      const data = await ctx.runQuery(internal.queries.aiOperator.stockByCodes, {
        codes,
        profile: rawProfile,
      });
      return aiOperatorOk(data);
    } catch (e: any) {
      console.error("ai-operator/stock error:", e?.message, e?.stack);
      return jsonResponse({ ok: false, error: e?.message ?? String(e) }, 500);
    }
  }),
});

// ─── GET /ai-operator/product-search?query=rooibos&limit=10 ──────────────────

http.route({
  path: "/ai-operator/product-search",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const denied = authorizeAiOperator(request);
    if (denied) return denied;

    const query = new URL(request.url).searchParams.get("query")?.trim() ?? "";
    if (query.length < 2) {
      return jsonResponse({ ok: false, error: "parametr query musi mieć min. 2 znaki" }, 400);
    }

    try {
      const data = await ctx.runQuery(internal.queries.aiOperator.findProduct, {
        query,
        limit: intParam(request, "limit", 10),
      });
      return aiOperatorOk(data);
    } catch (e: any) {
      console.error("ai-operator/product-search error:", e?.message, e?.stack);
      return jsonResponse({ ok: false, error: e?.message ?? String(e) }, 500);
    }
  }),
});

// ─── GET /ai-operator/production?limit=20&status=in_progress ─────────────────

http.route({
  path: "/ai-operator/production",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const denied = authorizeAiOperator(request);
    if (denied) return denied;

    const status = new URL(request.url).searchParams.get("status")?.trim();

    try {
      const data = await ctx.runQuery(internal.queries.aiOperator.productionStatus, {
        limit: intParam(request, "limit", 20),
        ...(status ? { status } : {}),
      });
      return aiOperatorOk(data);
    } catch (e: any) {
      console.error("ai-operator/production error:", e?.message, e?.stack);
      return jsonResponse({ ok: false, error: e?.message ?? String(e) }, 500);
    }
  }),
});
