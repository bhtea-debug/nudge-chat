import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  checkAuthorize,
  consentPage,
  exchangeToken,
  issueCode,
  passwordMatches,
  protectedResourceMetadata,
  registerClient,
  verifyAccessToken,
  wwwAuthenticate,
  type OAuthConfig,
} from "../src/mcp/oauth.js";

/**
 * OAuth 2.1 dla konektora Claude.
 *
 * Powstało po sprawdzeniu na ekranie właściciela, że okno „Add custom connector"
 * NIE MA pola na token — tylko adres i opcjonalne OAuth Client ID/Secret.
 * Serwer broniący się statycznym tokenem był więc dla tego klienta nie do
 * połączenia.
 *
 * Te testy pilnują rzeczy, których złamanie otwiera pocztę firmy, a nie tylko
 * psuje flow.
 */

const cfg: OAuthConfig = {
  issuer: "https://bht.example",
  signingKey: "klucz-podpisujacy-do-testow",
  password: "haslo-wlasciciela",
};

/** Rejestruje klienta i zwraca jego client_id. */
const zarejestruj = (redirect = "https://claude.ai/api/mcp/auth_callback"): string => {
  const out = registerClient(cfg, { redirect_uris: [redirect], client_name: "Claude" });
  expect(out.status).toBe(201);
  return (out.body as { client_id: string }).client_id;
};

const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const zadanie = (client_id: string, challenge: string, redirect = "https://claude.ai/api/mcp/auth_callback") => ({
  client_id,
  redirect_uri: redirect,
  state: "abc",
  code_challenge: challenge,
  code_challenge_method: "S256",
  resource: "https://bht.example/mcp",
});

describe("metadane, po których klient znajduje drogę", () => {
  it("zasób wskazuje serwer autoryzacji", () => {
    const m = protectedResourceMetadata(cfg) as Record<string, unknown>;
    expect(m["resource"]).toBe("https://bht.example/mcp");
    expect(m["authorization_servers"]).toEqual(["https://bht.example"]);
  });

  it("serwer autoryzacji wymaga PKCE S256 i NIE dopuszcza plain", () => {
    const m = authorizationServerMetadata(cfg) as Record<string, unknown>;
    expect(m["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(m["registration_endpoint"]).toBe("https://bht.example/oauth/register");
  });

  it("nagłówek 401 mówi, GDZIE szukać opisu autoryzacji", () => {
    // Bez tego klient dostaje samo 401 i nie ma jak zacząć — to był brakujący
    // element poprzedniej wersji serwera.
    expect(wwwAuthenticate(cfg)).toContain("resource_metadata=");
    expect(wwwAuthenticate(cfg)).toContain("/.well-known/oauth-protected-resource");
  });
});

describe("rejestracja klienta", () => {
  it("bez redirect_uris odmawia", () => {
    expect(registerClient(cfg, {}).status).toBe(400);
  });

  it("wydaje klienta publicznego, bez sekretu", () => {
    const body = registerClient(cfg, { redirect_uris: ["https://x.example/cb"] }).body as Record<string, unknown>;
    expect(body["token_endpoint_auth_method"]).toBe("none");
    expect(body["client_secret"]).toBeUndefined();
  });
});

describe("autoryzacja", () => {
  it("PODMIENIONY redirect_uri jest odrzucany bez przekierowania", () => {
    // Gdyby przekierował, mielibyśmy otwarte przekierowanie — gotowe narzędzie
    // dla kogoś, kto podszywa się pod nasz adres.
    const id = zarejestruj();
    const w = checkAuthorize(cfg, zadanie(id, pkce().challenge, "https://zly.example/przechwyc"));
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.kind).toBe("fatal");
  });

  it("podrobiony client_id nie przechodzi", () => {
    const w = checkAuthorize(cfg, zadanie("wymyslony.podpis", pkce().challenge));
    expect(w.ok).toBe(false);
  });

  it("brak PKCE albo metoda plain są odrzucane", () => {
    const id = zarejestruj();
    const bez = checkAuthorize(cfg, { ...zadanie(id, ""), code_challenge_method: "S256" });
    expect(bez.ok).toBe(false);
    const plain = checkAuthorize(cfg, { ...zadanie(id, "x"), code_challenge_method: "plain" });
    expect(plain.ok).toBe(false);
  });

  it("hasło właściciela jest jedyną bramą do wydania kodu", () => {
    expect(passwordMatches(cfg, "haslo-wlasciciela")).toBe(true);
    expect(passwordMatches(cfg, "haslo-wlasciciel")).toBe(false);
    expect(passwordMatches(cfg, "")).toBe(false);
  });

  it("ekran zgody mówi, o jakie uprawnienia chodzi, i nie wstawia nazwy klienta bez ucieczki", () => {
    const s = consentPage({ clientName: '<img src=x onerror="zle()">', query: "a=1" });
    expect(s).toContain("tylko do odczytu");
    expect(s).not.toContain("<img src=x");
    expect(s).toContain("&lt;img");
  });
});

describe("wymiana kodu na token", () => {
  it("pełna ścieżka: rejestracja → kod → token → token działa", () => {
    const id = zarejestruj();
    const { verifier, challenge } = pkce();
    const code = issueCode(cfg, zadanie(id, challenge));

    const out = exchangeToken(cfg, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    });
    expect(out.status).toBe(200);

    const body = out.body as { access_token: string; refresh_token: string; token_type: string };
    expect(body["token_type"]).toBe("Bearer");
    expect(verifyAccessToken(cfg, body.access_token)).toBe(true);
  });

  it("ZŁY code_verifier nie wymienia kodu — to jest cały sens PKCE", () => {
    const id = zarejestruj();
    const { challenge } = pkce();
    const code = issueCode(cfg, zadanie(id, challenge));
    const out = exchangeToken(cfg, {
      grant_type: "authorization_code",
      code,
      code_verifier: randomBytes(32).toString("base64url"),
    });
    expect(out.status).toBe(400);
  });

  it("kod jest JEDNORAZOWY — przechwycony i odtworzony nie zadziała", () => {
    const id = zarejestruj();
    const { verifier, challenge } = pkce();
    const code = issueCode(cfg, zadanie(id, challenge));
    const args = { grant_type: "authorization_code", code, code_verifier: verifier };

    expect(exchangeToken(cfg, args).status).toBe(200);
    expect(exchangeToken(cfg, args).status).toBe(400);
  });

  it("token podpisany INNYM kluczem nie przechodzi", () => {
    // Rotacja MCP_BEARER_TOKEN ma unieważniać wszystkie wydane tokeny naraz.
    const id = zarejestruj();
    const { verifier, challenge } = pkce();
    const code = issueCode(cfg, zadanie(id, challenge));
    const body = exchangeToken(cfg, { grant_type: "authorization_code", code, code_verifier: verifier })
      .body as { access_token: string };

    const poRotacji: OAuthConfig = { ...cfg, signingKey: "zupelnie-inny-klucz" };
    expect(verifyAccessToken(poRotacji, body.access_token)).toBe(false);
  });

  it("refresh_token odnawia dostęp, ale token odświeżający NIE jest tokenem dostępu", () => {
    const id = zarejestruj();
    const { verifier, challenge } = pkce();
    const code = issueCode(cfg, zadanie(id, challenge));
    const first = exchangeToken(cfg, { grant_type: "authorization_code", code, code_verifier: verifier })
      .body as { refresh_token: string };

    // Rozdzielenie ról jest istotne: gdyby refresh działał jako dostęp,
    // wyciek długożyjącego tokenu dawałby natychmiastowy wgląd w pocztę.
    expect(verifyAccessToken(cfg, first.refresh_token)).toBe(false);

    const odnowiony = exchangeToken(cfg, { grant_type: "refresh_token", refresh_token: first.refresh_token });
    expect(odnowiony.status).toBe(200);
    expect(verifyAccessToken(cfg, (odnowiony.body as { access_token: string }).access_token)).toBe(true);
  });

  it("nieznany grant_type jest odrzucany", () => {
    expect(exchangeToken(cfg, { grant_type: "password" }).status).toBe(400);
  });

  it("wymyślony token nie przechodzi walidacji", () => {
    expect(verifyAccessToken(cfg, "cokolwiek.podpisane")).toBe(false);
    expect(verifyAccessToken(cfg, "")).toBe(false);
  });
});
