#!/usr/bin/env tsx
import {
  CONTRACT_ID,
  CONTRACT_VERSION,
  HealthResponse,
  OrderResponse,
  ProductSearchResponse,
  ProductionResponse,
  ROUTES,
  StockResponse,
} from "../teabrew/contract.js";

/**
 * Sprawdza WDROŻONĄ łatkę po stronie TeaBrew v2 — bez modelu.
 *
 *   TEABREW_BASE_URL=... TEABREW_AI_OPERATOR_TOKEN=... npm run verify:teabrew
 *   npm run verify:teabrew -- --order 12345 --product rooibos
 *
 * Trzy grupy sprawdzeń:
 *
 *  1. BEZPIECZEŃSTWO — brak tokenu, zły token, brak metod zapisu, brak
 *     nieudokumentowanych tras. Te są ważniejsze od pozytywnych: wyłapują
 *     endpoint, który zwraca dane bez autoryzacji, i weryfikują, że agent nie
 *     dostał niczego poza pięcioma trasami.
 *  2. KONTRAKT — kształt każdej odpowiedzi zgodny ze schematem zod.
 *  3. PRAWDZIWE DANE — pozytywne trafienia na realnych rekordach. Wartości do
 *     testu są ODKRYWANE z systemu (endpoint produkcji zwraca prawdziwe numery
 *     zamówień i kody SKU), więc właściciel nie musi niczego podawać.
 *     Nadpisanie: --order / --product.
 */

const baseUrl = process.env["TEABREW_BASE_URL"]?.trim().replace(/\/$/, "");
const token = process.env["TEABREW_AI_OPERATOR_TOKEN"]?.trim();

if (!baseUrl || !token) {
  process.stderr.write(
    "Brak TEABREW_BASE_URL albo TEABREW_AI_OPERATOR_TOKEN.\n" +
      "Ten skrypt sprawdza WDROŻONĄ łatkę, więc wymaga prawdziwego adresu i tokenu.\n",
  );
  process.exit(2);
}

const argv = process.argv.slice(2);
const strArg = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

async function call(
  path: string,
  params: Record<string, string> = {},
  opts: { auth?: string | null; method?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  const auth = opts.auth === undefined ? `Bearer ${token}` : opts.auth;
  if (auth) headers["authorization"] = auth;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

interface Check {
  readonly group: string;
  readonly name: string;
  readonly run: () => Promise<string | void>;
  /** Pominięcie zamiast porażki, gdy nie ma na czym pracować. */
  readonly skipIf?: () => string | null;
}

/** Wartości odkryte z systemu w trakcie działania — dla testów pozytywnych. */
const discovered: { orderRef?: string; skuCode?: string } = {};

const checks: Check[] = [
  // ─── 1. BEZPIECZEŃSTWO ──────────────────────────────────────────────────────
  {
    group: "bezpieczeństwo",
    name: "BEZ tokenu → 401 i żadnych danych",
    run: async () => {
      for (const path of Object.values(ROUTES)) {
        const { status, body } = await call(path, { ref: "x", codes: "x", query: "xx" }, { auth: null });
        assert(status === 401, `${path}: oczekiwano 401, jest ${status}`);
        assert(
          !(body as { ok?: boolean })?.ok,
          `${path}: zwrócił ok:true bez autoryzacji — to jest dziura, nie usterka`,
        );
      }
      return `wszystkie ${Object.keys(ROUTES).length} trasy odrzucają brak tokenu`;
    },
  },
  {
    group: "bezpieczeństwo",
    name: "ZŁY token → 401",
    run: async () => {
      const { status } = await call(ROUTES.health, {}, { auth: "Bearer nieprawidlowy-token-testowy" });
      assert(status === 401, `oczekiwano 401, jest ${status}`);
    },
  },
  {
    group: "bezpieczeństwo",
    name: "token w query stringu NIE autoryzuje",
    run: async () => {
      // Gdyby token dawał dostęp przez URL, wyciekałby do logów serwera.
      const { status } = await call(ROUTES.health, { token: token! }, { auth: null });
      assert(status === 401, `URL z tokenem dał ${status} — token w URL musi być bezsilny`);
    },
  },
  {
    group: "bezpieczeństwo",
    name: "brak metod zapisu (POST/PUT/PATCH/DELETE)",
    run: async () => {
      const bad: string[] = [];
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const { status } = await call(ROUTES.order, { ref: "1" }, { method });
        // Convex nie zarejestrował tych metod → 404/405. Cokolwiek z 2xx
        // znaczyłoby, że agent ma czym zmienić stan.
        if (status >= 200 && status < 300) bad.push(`${method}=${status}`);
      }
      assert(bad.length === 0, `metody zapisu odpowiadają sukcesem: ${bad.join(", ")}`);
      return "POST/PUT/PATCH/DELETE nieobsługiwane na trasach agenta";
    },
  },
  {
    group: "bezpieczeństwo",
    name: "brak nieudokumentowanych tras /ai-operator/*",
    run: async () => {
      const probes = ["/ai-operator/query", "/ai-operator/db", "/ai-operator/", "/ai-operator/orders"];
      const leaked: string[] = [];
      for (const p of probes) {
        const { status } = await call(p);
        if (status >= 200 && status < 300) leaked.push(`${p}=${status}`);
      }
      assert(leaked.length === 0, `odpowiadają trasy poza kontraktem: ${leaked.join(", ")}`);
      return "wystawione są tylko pięć zadeklarowanych tras";
    },
  },

  // ─── 2. KONTRAKT ────────────────────────────────────────────────────────────
  {
    group: "kontrakt",
    name: "health — wersja kontraktu i flaga read-only",
    run: async () => {
      const { status, body } = await call(ROUTES.health);
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = HealthResponse.parse(body);
      assert(parsed.contractVersion === CONTRACT_VERSION, "inna wersja kontraktu");
      assert(parsed.data.contractId === CONTRACT_ID, "inny contractId");
      assert(parsed.data.readOnly === true, "endpoint nie deklaruje read-only");
      return `${CONTRACT_ID}, readOnly=true`;
    },
  },
  {
    group: "kontrakt",
    name: "order bez parametru ref → 400",
    run: async () => {
      const { status } = await call(ROUTES.order);
      assert(status === 400, `oczekiwano 400, jest ${status}`);
    },
  },
  {
    group: "kontrakt",
    name: "stock ze złym profilem → 400",
    run: async () => {
      const { status } = await call(ROUTES.stock, { codes: "X", profile: "cokolwiek" });
      assert(status === 400, `oczekiwano 400, jest ${status}`);
    },
  },
  {
    group: "kontrakt",
    name: "product-search z jednym znakiem → 400",
    run: async () => {
      const { status } = await call(ROUTES.productSearch, { query: "a" });
      assert(status === 400, `oczekiwano 400, jest ${status}`);
    },
  },
  {
    group: "kontrakt",
    name: "production — kształt, liczniki statusów, limit",
    run: async () => {
      const { status, body } = await call(ROUTES.production, { limit: "20" });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = ProductionResponse.parse(body);
      assert(parsed.data.orders.length <= 20, "limit nie jest respektowany");

      // Odkrywamy prawdziwe wartości do testów pozytywnych.
      discovered.orderRef =
        strArg("--order") ??
        parsed.data.orders.find((o) => o.salesOrderRef)?.salesOrderRef ??
        undefined;
      discovered.skuCode =
        parsed.data.orders.find((o) => o.skuCode)?.skuCode ?? undefined;

      const statuses = Object.entries(parsed.data.countByStatus)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      return `${parsed.data.orders.length} zleceń, ${parsed.data.activeRuns.length} ruchów otwartych; ${statuses || "brak zleceń"}`;
    },
  },

  // ─── 3. „NIE ZNALEZIONO" MUSI BYĆ JAWNE ─────────────────────────────────────
  {
    group: "brak danych",
    name: "nieistniejące zamówienie → 200 i matchedBy=none",
    run: async () => {
      const { status, body } = await call(ROUTES.order, { ref: "NIE-ISTNIEJE-0000000" });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = OrderResponse.parse(body);
      assert(
        parsed.data.matchedBy === "none",
        `oczekiwano matchedBy=none, jest ${parsed.data.matchedBy}`,
      );
      assert(parsed.data.count === 0, "count powinien być 0");
      assert(parsed.data.orders.length === 0, "orders powinno być puste");
      return "brak danych zwracany jawnie, nie jako 404 ani pusty rekord";
    },
  },
  {
    group: "brak danych",
    name: "nieistniejący kod → unknownCodes, NIE stan zero",
    run: async () => {
      const { status, body } = await call(ROUTES.stock, {
        codes: "KOD-KTORY-NIE-ISTNIEJE",
        profile: "finished_goods",
      });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = StockResponse.parse(body);
      assert(
        parsed.data.unknownCodes.includes("KOD-KTORY-NIE-ISTNIEJE"),
        "nieznany kod musi wrócić w unknownCodes",
      );
      assert(
        parsed.data.items.length === 0,
        "nieznany kod nie może pojawić się jako pozycja stanu (to byłby fałszywy stan 0)",
      );
      return "nieznany kod nie udaje stanu zerowego";
    },
  },
  {
    group: "brak danych",
    name: "nieistniejący produkt → pusty wynik, totalCount 0",
    run: async () => {
      const { status, body } = await call(ROUTES.productSearch, {
        query: "xqzvbnmnieistniejacyprodukt",
      });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = ProductSearchResponse.parse(body);
      assert(parsed.data.totalCount === 0, `totalCount powinien być 0, jest ${parsed.data.totalCount}`);
      assert(parsed.data.skus.length === 0 && parsed.data.materials.length === 0, "wynik nie jest pusty");
      assert(parsed.data.truncated === false, "truncated nie może być true dla pustego wyniku");
    },
  },

  // ─── 4. PRAWDZIWE DANE ──────────────────────────────────────────────────────
  {
    group: "prawdziwe dane",
    name: "istniejące zamówienie → dopasowane po realnym polu",
    skipIf: () =>
      discovered.orderRef
        ? null
        : "żadne zlecenie produkcyjne nie wskazuje zamówienia sprzedaży; podaj --order <numer>",
    run: async () => {
      const ref = discovered.orderRef!;
      const { status, body } = await call(ROUTES.order, { ref, limit: "3" });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = OrderResponse.parse(body);
      assert(
        parsed.data.matchedBy !== "none",
        `numer "${ref}" pochodzi z tego samego systemu, a nie został dopasowany`,
      );
      assert(parsed.data.count > 0, "count powinien być > 0");
      const order = parsed.data.orders[0]!;
      assert(typeof order.fulfillmentStatus === "string" && order.fulfillmentStatus.length > 0,
        "brak statusu realizacji");
      return (
        `ref "${ref}" → matchedBy=${parsed.data.matchedBy}, status=${order.fulfillmentStatus}, ` +
        `pozycji=${order.items.length}, powiązanych zleceń=${order.production.length}`
      );
    },
  },
  {
    group: "prawdziwe dane",
    name: "istniejący produkt → znaleziony w katalogu",
    skipIf: () =>
      discovered.skuCode || strArg("--product")
        ? null
        : "nie odkryto żadnego kodu SKU; podaj --product <fraza>",
    run: async () => {
      const query = strArg("--product") ?? discovered.skuCode!;
      const { status, body } = await call(ROUTES.productSearch, { query, limit: "10" });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = ProductSearchResponse.parse(body);
      assert(
        parsed.data.totalCount > 0,
        `fraza "${query}" pochodzi z tego systemu, a nie dała trafień`,
      );
      // Kod do pozytywnego testu stanu.
      discovered.skuCode = parsed.data.skus[0]?.code ?? parsed.data.materials[0]?.code ?? discovered.skuCode;
      const g = parsed.data.skus[0]?.gramaturaG;
      return (
        `"${query}" → ${parsed.data.skus.length} SKU, ${parsed.data.materials.length} materiałów` +
        (g !== undefined && g !== null ? `; gramatura pierwszego: ${g} g (liczba, nie tekst)` : "")
      );
    },
  },
  {
    group: "prawdziwe dane",
    name: "stan istniejącego kodu → liczby, nie unknownCodes",
    skipIf: () => (discovered.skuCode ? null : "brak kodu do sprawdzenia stanu"),
    run: async () => {
      const code = discovered.skuCode!;
      const { status, body } = await call(ROUTES.stock, {
        codes: code,
        profile: "finished_goods",
      });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = StockResponse.parse(body);
      assert(
        !parsed.data.unknownCodes.includes(code),
        `kod "${code}" pochodzi z katalogu tego systemu, a trafił do unknownCodes — ` +
          "to znaczy, że kod SKU nie ma odpowiadającego materiału i stan jest nieliczalny",
      );
      const item = parsed.data.items[0];
      assert(Boolean(item), "brak pozycji stanu dla istniejącego kodu");
      assert(item!.name !== null, "pozycja stanu bez nazwy materiału — sprawdź buildMaterialIndex");
      return (
        `${code} (${item!.name}): onHand=${item!.onHand} ${item!.uom ?? ""}, ` +
        `rez.prod=${item!.reservedProduction}, rez.wys=${item!.reservedShipment}, ` +
        `dostępne=${item!.available}` +
        (item!.shipmentReservationUncovered > 0
          ? `, ⚠ rezerwacje niepokryte=${item!.shipmentReservationUncovered}`
          : "")
      );
    },
  },
  {
    group: "prawdziwe dane",
    name: "oba profile stanu dają wynik (finished_goods i all_locations)",
    skipIf: () => (discovered.skuCode ? null : "brak kodu do sprawdzenia"),
    run: async () => {
      const code = discovered.skuCode!;
      const out: string[] = [];
      for (const profile of ["finished_goods", "all_locations"] as const) {
        const { status, body } = await call(ROUTES.stock, { codes: code, profile });
        assert(status === 200, `${profile}: oczekiwano 200, jest ${status}`);
        const parsed = StockResponse.parse(body);
        assert(parsed.data.profile === profile, `${profile}: endpoint zwrócił inny profil`);
        out.push(`${profile}=${parsed.data.items[0]?.available ?? "brak"}`);
      }
      return out.join(", ");
    },
  },
];

async function main(): Promise<number> {
  process.stdout.write(
    `Weryfikacja wdrożonej łatki ${CONTRACT_ID}\nBaza: ${baseUrl}\nModel NIE jest wołany.\n`,
  );

  let failed = 0;
  let skipped = 0;
  let group = "";

  for (const check of checks) {
    if (check.group !== group) {
      group = check.group;
      process.stdout.write(`\n[${group}]\n`);
    }
    const reason = check.skipIf?.() ?? null;
    if (reason) {
      skipped += 1;
      process.stdout.write(`  – ${check.name}\n      pominięto: ${reason}\n`);
      continue;
    }
    try {
      const detail = await check.run();
      process.stdout.write(`  ✓ ${check.name}\n`);
      if (detail) process.stdout.write(`      ${detail}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(
        `  ✗ ${check.name}\n      ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const passed = checks.length - failed - skipped;
  process.stdout.write(
    `\n${passed} przeszło, ${failed} nie przeszło, ${skipped} pominięto.\n` +
      (failed === 0
        ? skipped === 0
          ? "Łatka jest zgodna z kontraktem i bezpieczna. Można przełączyć MODE=live.\n"
          : "Sprawdzenia obowiązkowe przeszły. Pominięte wymagają wskazania danych " +
            "(--order / --product) — bez nich pozytywna korelacja nie jest potwierdzona.\n"
        : "Nie przełączaj MODE=live, dopóki wszystkie sprawdzenia nie przechodzą.\n"),
  );
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
