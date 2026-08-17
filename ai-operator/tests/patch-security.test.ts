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
 * omawiają rzeczy zakazane („NIE MA statusu running”, „wklej bloki http.route”),
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
    // raportowałby „nic się nie produkuje” przy pracującej hali.
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
    // Brak tokenu w env = 500, nie „przepuść”.
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

describe("MCP jest adapterem, nie drugim systemem", () => {
  const read2 = (rel: string): string =>
    stripComments(readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8"));

  const CORE = read2("mcp/core.ts");
  const STDIO = read2("bin/mcp.ts");
  const HTTP = read2("bin/mcp-http.ts");

  it("oba transporty korzystają z JEDNEGO rdzenia, nie z własnej obsługi protokołu", () => {
    // Dwa transporty z dwiema listami narzędzi rozjechałyby się pierwszego dnia.
    for (const [name, src] of [["stdio", STDIO], ["http", HTTP]] as const) {
      expect(src.includes("createMcpCore"), `${name} nie używa rdzenia`).toBe(true);
      expect(src.includes("toMcpToolList"), `${name} buduje własną listę narzędzi`).toBe(false);
      expect(src.includes("registry.invoke"), `${name} woła rejestr wprost`).toBe(false);
      expect(src.includes("tools/list"), `${name} obsługuje protokół u siebie`).toBe(false);
    }
  });

  it("lista narzędzi pochodzi z rejestru, nie z ręcznej tablicy", () => {
    expect(CORE.includes("app.registry")).toBe(true);
    expect(CORE.includes("toMcpToolList")).toBe(true);
    // Żadnej własnej definicji narzędzia ani schematu w adapterze.
    expect(CORE.includes("inputSchema:")).toBe(false);
    expect(CORE.includes("z.object")).toBe(false);
  });

  it("wywołania idą przez registry.invoke, nie do dostawców wprost", () => {
    expect(CORE.includes("registry.invoke")).toBe(true);
    for (const bypass of ["MailProvider", "ImapMailProvider", "TeabrewReader", "HttpTeabrewReader"]) {
      for (const [name, src] of [["core", CORE], ["stdio", STDIO], ["http", HTTP]] as const) {
        expect(src.includes(bypass), `${name} omija rejestr przez ${bypass}`).toBe(false);
      }
    }
  });

  it("wystawia wyłącznie capability read — jawnie, w adapterze", () => {
    // Nie wystarcza, że rejestr innych nie przyjmuje. Gdyby kiedyś przyjął,
    // capability zapisująca nie może trafić do publicznego MCP automatycznie.
    expect(CORE).toMatch(/effectClass === "read"/);
  });

  it("polityka obowiązuje i przy tools/list, i przy tools/call", () => {
    const listIdx = CORE.indexOf('"tools/list"');
    const callIdx = CORE.indexOf('"tools/call"');
    expect(listIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(callIdx - 1);
    expect(CORE.slice(listIdx, callIdx).includes("publishedTools()")).toBe(true);
    expect(CORE.slice(callIdx).includes("publishedTools()")).toBe(true);
  });

  it("nie woła modelu po naszej stronie", () => {
    // Cały sens trybu MCP: modelem jest Claude po stronie klienta.
    for (const own of ["app.models", "app.operator", "app.triage", "ModelLayer", "Anthropic"]) {
      for (const [name, src] of [["core", CORE], ["stdio", STDIO], ["http", HTTP]] as const) {
        expect(src.includes(own), `${name} woła własny model przez ${own}`).toBe(false);
      }
    }
  });

  it("audyt i korelacja są zachowane", () => {
    expect(CORE.includes("MemoryAuditSink")).toBe(true);
    expect(CORE.includes("correlationId")).toBe(true);
    expect(CORE.includes("scopes: AGENT_SCOPES")).toBe(true);
  });

  it("„to już pokazałem” zapisuje adapter, nie capability", () => {
    // Gdyby capability sama zapisywała, effectClass: "read" przestałoby być
    // prawdą, a testy strzegące tej granicy przestałyby cokolwiek znaczyć.
    expect(CORE.includes("markPresented")).toBe(true);
    const CAPS = stripComments(
      readFileSync(new URL("../src/state/capabilities.ts", import.meta.url), "utf8"),
    );
    // Z KROPKĄ, bo sama nazwa "createIssue" jest podciągiem eksportowanej
    // funkcji createIssueCapabilities — asercja bez kropki dawała fałszywy alarm.
    for (const write of [".markPresented(", ".createIssue(", ".patchIssue(", ".saveCheckpoint(", ".ownerResolve(", ".addSource(", ".markMessageSeen("]) {
      expect(CAPS.includes(write), `capability spraw zapisuje przez ${write}`).toBe(false);
    }
  });
});

describe("Remote MCP — bezpieczeństwo wystawienia do internetu", () => {
  const HTTP = stripComments(
    readFileSync(new URL("../src/bin/mcp-http.ts", import.meta.url), "utf8"),
  );

  it("bez tokenu serwer NIE wstaje", () => {
    // Fail-closed przy starcie. Serwer bez tokenu wystawiałby pocztę firmy
    // do internetu bez żadnej bramy — to nie może być stan domyślny.
    expect(HTTP).toMatch(/MIN_TOKEN_LENGTH/);
    expect(HTTP).toMatch(/process\.exit\(1\)/);
  });

  it("porównuje token w czasie stałym", () => {
    expect(HTTP.includes("timingSafeEqual")).toBe(true);
    // Zwykłe === wycieka długość wspólnego prefiksu.
    expect(HTTP).not.toMatch(/provided === TOKEN/);
  });

  it("ma limit żądań", () => {
    expect(HTTP.includes("429")).toBe(true);
    expect(HTTP.includes("RATE_CAPACITY")).toBe(true);
  });

  it("nie loguje tokenu ani argumentów wywołania", () => {
    const logs = [...HTTP.matchAll(/logAccess\(([^;]*)\)/g)].map((m) => m[1]!);
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      for (const leak of ["TOKEN", "provided", "authorization", "args", "arguments"]) {
        expect(log.includes(leak), `log zawiera "${leak}": ${log}`).toBe(false);
      }
    }
  });

  it("health nie wystawia danych firmy", () => {
    const health = HTTP.slice(HTTP.indexOf('"/health"'), HTTP.indexOf('"/mcp"'));
    for (const leak of ["issues", "messages", "subject", "TOKEN", "pass"]) {
      expect(health.includes(leak), `health wystawia "${leak}"`).toBe(false);
    }
  });

  it("odpowiedzi nie są cache'owane po drodze", () => {
    expect(HTTP.includes("no-store")).toBe(true);
  });

  it("awaria monitora nie przewraca serwera MCP", () => {
    // Wymaganie o awarii: gdy operator w tle nie działa, Claude nadal musi móc
    // ręcznie sprawdzić pocztę i TeaBrew.
    // Wycinek MUSI kończyć się na zamknięciu funkcji. Bez tego łapał też
    // obsługę SIGTERM na końcu pliku, w której process.exit jest poprawny.
    const from = HTTP.indexOf("async function monitorTick");
    const tick = HTTP.slice(from, HTTP.indexOf("\n}", from) + 2);
    expect(tick.includes("catch")).toBe(true);
    expect(tick).not.toMatch(/process\.exit/);
    expect(tick.includes("app.monitor.runOnce")).toBe(true);
  });
});
