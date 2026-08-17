import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * CAŁA droga, którą przechodzi Claude, zanim wywoła pierwsze narzędzie.
 *
 * Testy jednostkowe w `oauth.test.ts` sprawdzają funkcje. Ten plik sprawdza
 * **okablowanie**: ścieżki, metody, nagłówki i kolejność. Powstał, bo konektor
 * w Claude odmówił połączenia komunikatem „Couldn't register with BHT Copilot's
 * sign-in service", a wszystkie testy jednostkowe były wtedy zielone — usterka
 * mogła siedzieć wyłącznie w miejscu, którego żaden z nich nie dotykał.
 *
 * Łańcuch odtworzony tu wiernie:
 *   1. POST /mcp bez tokenu           → 401 + `WWW-Authenticate` ze wskazaniem,
 *   2. adres z tego nagłówka          → metadane zasobu (RFC 9728),
 *   3. `authorization_servers[0]`     → metadane serwera autoryzacji (RFC 8414),
 *   4. `registration_endpoint`        → rejestracja klienta (RFC 7591),
 *   5. `authorization_endpoint`       → ekran zgody i kod,
 *   6. `token_endpoint`               → token,
 *   7. POST /mcp z tym tokenem        → lista narzędzi.
 *
 * Zerwanie łańcucha w KTÓRYMKOLWIEK ogniwie wygląda dla właściciela tak samo:
 * konektor się nie łączy i nie mówi dlaczego. Dlatego każde ogniwo ma tu własne
 * twierdzenie — żeby następnym razem test wskazał palcem, a nie tylko zaświecił
 * na czerwono.
 */

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const httpEntry = fileURLToPath(new URL("../src/bin/mcp-http.ts", import.meta.url));

const PORT = 8851;
const BAZA = `http://127.0.0.1:${PORT}`;
const TOKEN = "t".repeat(48);
const HASLO = "haslo-wlasciciela-do-testu";
const PRZEKIEROWANIE = "https://claude.ai/api/mcp/auth_callback";

let serwer: ChildProcess;

beforeAll(async () => {
  serwer = spawn(process.execPath, [tsxCli, httpEntry], {
    cwd: operatorDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      MODE: "fixture",
      MONITOR_IN_PROCESS: "0",
      COPILOT_STATE_DIR: join(tmpdir(), `bht-oauth-${PORT}`),
      PORT: String(PORT),
      MCP_BEARER_TOKEN: TOKEN,
      COPILOT_AUTH_PASSWORD: HASLO,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const koniec = Date.now() + 25_000;
  for (;;) {
    try {
      await fetch(`${BAZA}/health`);
      return;
    } catch {
      if (Date.now() > koniec) throw new Error("serwer HTTP nie wstał w 25 s");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}, 30_000);

afterAll(() => {
  serwer?.kill();
});

/** Pobiera JSON i przy okazji zwraca status — obie rzeczy są tu istotne. */
async function pobierz(adres: string): Promise<{ status: number; body: any }> {
  const res = await fetch(adres);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("łańcuch odkrywania OAuth — dokładnie to, co robi Claude", () => {
  it("1. /health mówi, czy OAuth jest w ogóle włączony", async () => {
    // To jedno pole zamienia „konektor się nie łączy, nie wiadomo czemu"
    // w jedno curl-owe pytanie z jednoznaczną odpowiedzią.
    const { body } = await pobierz(`${BAZA}/health`);
    expect(body.oauth).toBe(true);
    expect(body.issuer).toBe(`https://127.0.0.1:${PORT}`);
  });

  it("2. odmowa na /mcp WSKAZUJE, gdzie szukać opisu autoryzacji", async () => {
    const res = await fetch(`${BAZA}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const naglowek = res.headers.get("www-authenticate") ?? "";
    expect(naglowek).toContain("resource_metadata=");
    // Bez tego wskazania klient ma samo 401 i nie ma jak zacząć rozmowy.
    expect(naglowek).toContain("/.well-known/oauth-protected-resource");
  });

  it("3. metadane zasobu odpowiadają w OBU wariantach ścieżki", async () => {
    // RFC 9728 wstawia ścieżkę zasobu do adresu `.well-known`, ale klienci
    // pytają różnie i niedopasowanie kończy się cichym „nie znalazłem".
    for (const sciezka of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const { status, body } = await pobierz(BAZA + sciezka);
      expect(status, sciezka).toBe(200);
      expect(body.authorization_servers, sciezka).toHaveLength(1);
    }
  });

  it("4. metadane serwera autoryzacji wskazują wszystkie trzy końcówki", async () => {
    const { status, body } = await pobierz(`${BAZA}/.well-known/oauth-authorization-server`);
    expect(status).toBe(200);
    for (const klucz of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      expect(typeof body[klucz], klucz).toBe("string");
    }
    // OAuth 2.1 zabrania `plain`; dopuszczenie go „dla zgodności" byłoby
    // osłabieniem PKCE, czyli jedynego zabezpieczenia klienta publicznego.
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("5. rejestracja przyjmuje ładunek w kształcie, jaki wysyła Claude", async () => {
    const res = await fetch(`${BAZA}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [PRZEKIEROWANIE],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["client_id"]).toBe("string");
    expect(body["client_secret"]).toBeUndefined();
  });

  it("6. preflight przeglądarki dostaje odpowiedź, a nie 404", async () => {
    // Bez tego przeglądarka blokuje właściwe żądanie ZANIM wyjdzie, więc po
    // naszej stronie nie ma nawet wpisu w logu i awaria wygląda jak cisza.
    const res = await fetch(`${BAZA}/oauth/register`, {
      method: "OPTIONS",
      headers: { origin: "https://claude.ai", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("7. pełne przejście: zgoda hasłem → kod → token → narzędzia", async () => {
    const rejestracja = await fetch(`${BAZA}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [PRZEKIEROWANIE] }),
    });
    const { client_id } = (await rejestracja.json()) as { client_id: string };

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const zapytanie = new URLSearchParams({
      client_id,
      redirect_uri: PRZEKIEROWANIE,
      response_type: "code",
      state: "stan-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${BAZA}/mcp`,
    });

    // Ekran zgody musi się pokazać człowiekowi, nie oddać kodu od razu.
    const ekran = await fetch(`${BAZA}/oauth/authorize?${zapytanie}`);
    expect(ekran.status).toBe(200);
    expect(await ekran.text()).toContain("tylko do odczytu");

    const zgoda = await fetch(`${BAZA}/oauth/authorize?${zapytanie}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ haslo: HASLO }).toString(),
      redirect: "manual",
    });
    expect(zgoda.status).toBe(302);
    const cel = new URL(zgoda.headers.get("location") ?? "");
    // `state` musi wrócić nietknięty — na nim klient wiąże odpowiedź z żądaniem.
    expect(cel.searchParams.get("state")).toBe("stan-123");
    const code = cel.searchParams.get("code") ?? "";
    expect(code.length).toBeGreaterThan(0);

    const wymiana = await fetch(`${BAZA}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: PRZEKIEROWANIE,
        client_id,
      }).toString(),
    });
    expect(wymiana.status).toBe(200);
    const { access_token } = (await wymiana.json()) as { access_token: string };

    // Ostatnie ogniwo: token z OAuth otwiera te same narzędzia co token statyczny.
    const narzedzia = await fetch(`${BAZA}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(narzedzia.status).toBe(200);
    const odp = (await narzedzia.json()) as { result: { tools: unknown[] } };
    expect(odp.result.tools.length).toBeGreaterThan(0);
  }, 20_000);

  it("8. złe hasło nie wydaje kodu — to jedyna bramka do poczty firmy", async () => {
    const rejestracja = await fetch(`${BAZA}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [PRZEKIEROWANIE] }),
    });
    const { client_id } = (await rejestracja.json()) as { client_id: string };
    const zapytanie = new URLSearchParams({
      client_id,
      redirect_uri: PRZEKIEROWANIE,
      code_challenge: createHash("sha256").update("x").digest("base64url"),
      code_challenge_method: "S256",
    });

    const zgoda = await fetch(`${BAZA}/oauth/authorize?${zapytanie}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ haslo: "nie-to-haslo" }).toString(),
      redirect: "manual",
    });
    expect(zgoda.status).toBe(401);
    expect(zgoda.headers.get("location")).toBeNull();
  });
});
