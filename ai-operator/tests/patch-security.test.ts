import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Przegląd bezpieczeństwa łatki dla TeaBrew v2 — jako test, nie jako obietnica
 * w opisie commita.
 *
 * Sens: gdy ktoś kiedyś dopisze do tych plików mutację, endpoint bez
 * autoryzacji albo dowolne zapytanie, ten test się wywali, zamiast żeby agent
 * po cichu zyskał prawo zapisu do ERP.
 */

const read = (rel: string): string =>
  readFileSync(new URL(`../teabrew-patch/${rel}`, import.meta.url), "utf8");

/**
 * Asercje dotyczą KODU, nie komentarzy. Komentarze w tych plikach celowo
 * omawiają rzeczy zakazane („NIE MA statusu running", „wklej bloki http.route"),
 * więc bez usunięcia komentarzy test badałby dokumentację zamiast implementacji.
 *
 * Prosty stripper wystarcza: w obu plikach nie ma literałów z sekwencją "//".
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const QUERIES = stripComments(read("convex/queries/aiOperator.ts"));
const ROUTES = stripComments(read("convex/http.additions.ts"));

describe("łatka TeaBrew — wyłącznie odczyt", () => {
  it("nie deklaruje żadnej mutacji ani akcji", () => {
    for (const forbidden of [
      "internalMutation",
      "mutation(",
      "internalAction",
      "action(",
      "ctx.db.insert",
      "ctx.db.patch",
      "ctx.db.replace",
      "ctx.db.delete",
      "ctx.scheduler",
      "ctx.storage",
    ]) {
      expect(QUERIES.includes(forbidden), `zapytania zawierają "${forbidden}"`).toBe(false);
    }
  });

  it("wystawia tylko internalQuery — nie publiczne query", () => {
    // `query(...)` byłoby wywoływalne przez KAŻDEGO klienta znającego adres
    // wdrożenia, bez naszego tokenu. `internalQuery` jest osiągalne wyłącznie
    // przez ctx.runQuery z wnętrza wdrożenia.
    const exported = [...QUERIES.matchAll(/export const (\w+) = (\w+)\(/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]);
    expect(exported.length).toBeGreaterThan(0);
    for (const [name, kind] of exported) {
      expect(kind, `"${name}" nie jest internalQuery`).toBe("internalQuery");
    }
    expect(exported.map(([n]) => n).sort()).toEqual([
      "findProduct",
      "orderByRef",
      "productionStatus",
      "stockByCodes",
    ]);
  });

  it("nie przyjmuje nazwy tabeli ani zapytania od wywołującego", () => {
    // Brak `v.any()` w args i brak dynamicznego ctx.db.query(zmienna) —
    // inaczej agent mógłby czytać dowolną tabelę.
    expect(QUERIES.includes("v.any()")).toBe(false);
    const dynamicQueries = [...QUERIES.matchAll(/\.query\(([^"')]+)\)/g)];
    expect(dynamicQueries.map((m) => m[0])).toEqual([]);
  });

  it("czyta tylko tabele potrzebne do czterech pytań", () => {
    const tables = [...new Set([...QUERIES.matchAll(/\.query\("(\w+)"\)/g)].map((m) => m[1]!))];
    expect(tables.sort()).toEqual([
      "materials",
      "orderItems",
      "orders",
      "productionOrders",
      "productionRuns",
      "skus",
    ]);
  });

  it("nie odwołuje się do statusu, którego nie ma w schemacie", () => {
    // productionRunStatus = pending|in_progress|paused|partially_done|done|cancelled.
    // Zapytanie o "running" zwracałoby zawsze zero wierszy, więc agent
    // raportowałby „nic się nie produkuje" przy pracującej hali.
    expect(QUERIES.includes('"running"')).toBe(false);
    expect(QUERIES.includes('"in_progress"')).toBe(true);
  });
});

describe("łatka TeaBrew — trasy HTTP", () => {
  it("rejestruje wyłącznie metody GET", () => {
    const methods = [...ROUTES.matchAll(/method:\s*"(\w+)"/g)].map((m) => m[1]!);
    expect(methods.length).toBe(5);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  it("wystawia dokładnie pięć zadeklarowanych tras", () => {
    const paths = [...ROUTES.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(paths.sort()).toEqual([
      "/ai-operator/health",
      "/ai-operator/order",
      "/ai-operator/product-search",
      "/ai-operator/production",
      "/ai-operator/stock",
    ]);
  });

  it("każda trasa autoryzuje przed wykonaniem czegokolwiek", () => {
    const handlers = ROUTES.split("http.route({").slice(1);
    expect(handlers).toHaveLength(5);
    for (const h of handlers) {
      const authIdx = h.indexOf("authorizeAiOperator(request)");
      const workIdx = h.indexOf("ctx.runQuery");
      expect(authIdx, "trasa nie woła authorizeAiOperator").toBeGreaterThan(-1);
      if (workIdx > -1) {
        expect(authIdx, "autoryzacja po wykonaniu zapytania").toBeLessThan(workIdx);
      }
    }
  });

  it("czyta token tylko z nagłówka Authorization, nigdy z URL", () => {
    expect(ROUTES.includes('headers.get("authorization")')).toBe(true);
    // Token nie może być odczytywany z query stringu — URL-e trafiają do logów.
    expect(/searchParams\.get\(\s*["'](token|api_?key|auth|s)["']/i.test(ROUTES)).toBe(false);
  });

  it("porównuje token w czasie stałym i zamyka się przy braku konfiguracji", () => {
    expect(ROUTES.includes("constantTimeTextEqual(provided, token)")).toBe(true);
    // Brak tokenu w env = 500, nie „przepuść".
    expect(/if\s*\(!token\)\s*\{[\s\S]{0,160}?500/.test(ROUTES)).toBe(true);
  });

  it("nie loguje żądania ani tokenu — tylko komunikat błędu", () => {
    const logs = [...ROUTES.matchAll(/console\.\w+\(([^;]*)\)/g)].map((m) => m[1]!);
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      for (const leak of ["token", "request", "authorization", "url", "provided"]) {
        expect(log.toLowerCase().includes(leak), `log zawiera "${leak}": ${log}`).toBe(false);
      }
    }
  });

  it("nie zwraca danych kontaktowych klienta", () => {
    // Do odpowiedzi na pytanie z maila wystarczy nazwa. Adres i telefon
    // klienta nie mają po co przechodzić przez model.
    for (const field of ["email", "phone", "shippingAddress"]) {
      expect(QUERIES.includes(field), `zapytania zwracają "${field}"`).toBe(false);
    }
  });
});
