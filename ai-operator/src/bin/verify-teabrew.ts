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
 * Sprawdza, czy łatka po stronie TeaBrew v2 jest założona poprawnie.
 *
 *   TEABREW_BASE_URL=... TEABREW_AI_OPERATOR_TOKEN=... npm run verify:teabrew
 *
 * Weryfikuje przypadki pozytywne (kształt odpowiedzi zgodny z kontraktem)
 * ORAZ negatywne — brak tokenu, zły token, brak wymaganego parametru,
 * nieistniejący numer. Wzięte z npd-studio: fikstury negatywne wyłapują
 * dokładnie te błędy, których pozytywne nie widzą, np. endpoint, który
 * zwraca dane bez autoryzacji.
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

interface Check {
  readonly name: string;
  readonly run: () => Promise<void>;
}

async function call(
  path: string,
  params: Record<string, string>,
  opts: { auth?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: "application/json" };
  const auth = opts.auth === undefined ? `Bearer ${token}` : opts.auth;
  if (auth) headers["authorization"] = auth;

  const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(20_000) });
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

const checks: Check[] = [
  {
    name: "health — kontrakt i flaga read-only",
    run: async () => {
      const { status, body } = await call(ROUTES.health, {});
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = HealthResponse.parse(body);
      assert(parsed.contractVersion === CONTRACT_VERSION, "inna wersja kontraktu");
      assert(parsed.data.contractId === CONTRACT_ID, "inny contractId");
      assert(parsed.data.readOnly === true, "endpoint nie deklaruje read-only");
    },
  },
  {
    name: "health BEZ tokenu → 401 i brak danych",
    run: async () => {
      const { status, body } = await call(ROUTES.health, {}, { auth: null });
      assert(status === 401, `oczekiwano 401, jest ${status}`);
      assert(
        !(body as { ok?: boolean })?.ok,
        "endpoint zwrócił ok:true bez autoryzacji — to jest dziura, nie usterka",
      );
    },
  },
  {
    name: "health ze ZŁYM tokenem → 401",
    run: async () => {
      const { status } = await call(ROUTES.health, {}, { auth: "Bearer nieprawidlowy-token" });
      assert(status === 401, `oczekiwano 401, jest ${status}`);
    },
  },
  {
    name: "order bez parametru ref → 400",
    run: async () => {
      const { status } = await call(ROUTES.order, {});
      assert(status === 400, `oczekiwano 400, jest ${status}`);
    },
  },
  {
    name: "order z nieistniejącym numerem → 200 i matchedBy=none",
    run: async () => {
      const { status, body } = await call(ROUTES.order, {
        ref: "NIE-ISTNIEJE-0000000",
      });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = OrderResponse.parse(body);
      // Kluczowe: „nie znalazłem" to poprawna odpowiedź, nie błąd 404 i nie
      // pusty rekord. Agent musi umieć to odróżnić.
      assert(parsed.data.matchedBy === "none", `oczekiwano matchedBy=none, jest ${parsed.data.matchedBy}`);
      assert(parsed.data.count === 0, "count powinien być 0");
      assert(parsed.data.orders.length === 0, "orders powinno być puste");
    },
  },
  {
    name: "stock z nieistniejącym kodem → kod w unknownCodes, NIE stan zero",
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
      assert(parsed.data.items.length === 0, "nieznany kod nie może pojawić się jako pozycja stanu");
    },
  },
  {
    name: "stock ze złym profilem → 400",
    run: async () => {
      const { status } = await call(ROUTES.stock, { codes: "X", profile: "cokolwiek" });
      assert(status === 400, `oczekiwano 400, jest ${status}`);
    },
  },
  {
    name: "product-search — kształt odpowiedzi",
    run: async () => {
      const { status, body } = await call(ROUTES.productSearch, { query: "a", limit: "5" });
      // Jednoznakowe query jest odrzucane; to też jest część kontraktu.
      assert(status === 400, `oczekiwano 400 dla query o długości 1, jest ${status}`);

      const ok = await call(ROUTES.productSearch, { query: "he", limit: "5" });
      assert(ok.status === 200, `oczekiwano 200, jest ${ok.status}`);
      const parsed = ProductSearchResponse.parse(ok.body);
      assert(typeof parsed.data.truncated === "boolean", "brak flagi truncated");
    },
  },
  {
    name: "production — kształt odpowiedzi i liczniki statusów",
    run: async () => {
      const { status, body } = await call(ROUTES.production, { limit: "5" });
      assert(status === 200, `oczekiwano 200, jest ${status}`);
      const parsed = ProductionResponse.parse(body);
      assert(
        typeof parsed.data.countByStatus === "object" && parsed.data.countByStatus !== null,
        "brak countByStatus",
      );
      assert(parsed.data.orders.length <= 5, "limit nie jest respektowany");
    },
  },
];

async function main(): Promise<number> {
  process.stdout.write(`Weryfikacja kontraktu ${CONTRACT_ID} pod ${baseUrl}\n\n`);
  let failed = 0;

  for (const check of checks) {
    try {
      await check.run();
      process.stdout.write(`  ✓ ${check.name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`  ✗ ${check.name}\n      ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  process.stdout.write(
    `\n${checks.length - failed}/${checks.length} sprawdzeń przeszło.\n` +
      (failed === 0
        ? "Łatka po stronie TeaBrew jest zgodna z kontraktem — można przełączyć MODE=live.\n"
        : "Nie przełączaj MODE=live, dopóki wszystkie sprawdzenia nie przechodzą.\n"),
  );
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
