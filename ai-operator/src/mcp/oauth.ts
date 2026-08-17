import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * OAuth 2.1 dla Remote MCP — minimalny, ale zgodny.
 *
 * ── Dlaczego to w ogóle powstało ──────────────────────────────────────────────
 * Okno „Add custom connector" w Claude ma trzy pola: nazwę, adres oraz — w
 * ustawieniach zaawansowanych — OAuth Client ID i Client Secret. **Nie ma pola
 * na token ani na nagłówek Authorization.** Sprawdzone na ekranie właściciela,
 * nie założone. Serwer broniący się statycznym tokenem jest więc dla tego
 * konektora nie do połączenia: albo stoi otworem, albo mówi OAuth.
 *
 * Otworem stać nie może — wystawia pocztę firmy.
 *
 * ── Dlaczego serwer jest tu też serwerem autoryzacji ──────────────────────────
 * Bo alternatywą jest zewnętrzny dostawca tożsamości, czyli PIERWSZA nowa usługa
 * w tym projekcie i nowe konto do utrzymania. Przy jednym użytkowniku to koszt
 * bez pokrycia. ARCHITEKTURA-AI-2026 §15 ostrzega przed budowaniem autoryzacji
 * wewnątrz MCP i ma rację w swoim kontekście — tam chodziło o role i tożsamości
 * wielu aktorów. Tutaj jest jeden aktor i jedna bramka, więc zostaje bramką,
 * a nie systemem tożsamości. Gdy pojawi się druga osoba, to się zmienia.
 *
 * ── Co czyni to bezpiecznym mimo prostoty ─────────────────────────────────────
 *  - **PKCE S256 wymagane** — bez `code_verifier` kod jest bezużyteczny,
 *  - **tokeny są podpisane, nie przechowywane** — przeżywają restart kontenera,
 *    a unieważnia je zmiana `MCP_BEARER_TOKEN`, z którego wywodzi się klucz,
 *  - **ekran zgody wymaga hasła właściciela** — bez tego każdy, kto zna adres,
 *    przeszedłby flow i dostał dostęp do poczty,
 *  - **kod autoryzacyjny żyje 60 sekund i jest jednorazowy**,
 *  - **`redirect_uri` jest wpisany w podpisany `client_id`**, więc nie da się go
 *    podmienić po rejestracji.
 */

/** Ile żyje token dostępu. Tydzień: właściciel nie ma logować się codziennie. */
const ACCESS_TTL_SEC = 7 * 24 * 3600;
/** Kod autoryzacyjny ma żyć tyle, ile trwa przekierowanie, i ani chwili dłużej. */
const CODE_TTL_SEC = 60;
const SCOPE = "mail:read erp:read issues:read";

export interface OAuthConfig {
  /** Publiczny adres serwera, bez końcowego ukośnika. Np. https://x.up.railway.app */
  readonly issuer: string;
  /** Klucz podpisujący. Wywodzimy z MCP_BEARER_TOKEN — bez nowego sekretu. */
  readonly signingKey: string;
  /** Hasło na ekranie zgody. Puste = OAuth WYŁĄCZONY (fail-closed). */
  readonly password: string;
}

// ── podpisywanie ──────────────────────────────────────────────────────────────

const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

function sign(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

/**
 * Wartość podpisana: `<ładunek>.<podpis>`. Używamy do tokenów i do client_id,
 * dzięki czemu serwer nie musi niczego pamiętać między restartami.
 */
function seal(key: string, obj: unknown): string {
  const payload = b64(JSON.stringify(obj));
  return `${payload}.${sign(key, payload)}`;
}

function unseal<T>(key: string, value: string): T | null {
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const provided = Buffer.from(value.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(key, payload), "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

// ── metadane ──────────────────────────────────────────────────────────────────

export function protectedResourceMetadata(cfg: OAuthConfig): unknown {
  return {
    resource: `${cfg.issuer}/mcp`,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPE.split(" "),
  };
}

export function authorizationServerMetadata(cfg: OAuthConfig): unknown {
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${cfg.issuer}/oauth/authorize`,
    token_endpoint: `${cfg.issuer}/oauth/token`,
    registration_endpoint: `${cfg.issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Wyłącznie S256. `plain` jest w OAuth 2.1 zabronione i nie ma powodu,
    // żeby je dopuszczać „dla zgodności".
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: SCOPE.split(" "),
  };
}

/**
 * Nagłówek, który mówi klientowi, GDZIE szukać opisu autoryzacji. Bez niego
 * Claude dostaje samo 401 i nie ma jak zacząć — to jest dokładnie ten element,
 * którego brakowało poprzedniej wersji serwera.
 */
export function wwwAuthenticate(cfg: OAuthConfig): string {
  return `Bearer resource_metadata="${cfg.issuer}/.well-known/oauth-protected-resource"`;
}

// ── rejestracja klienta ───────────────────────────────────────────────────────

interface ClientMeta {
  readonly redirect_uris: string[];
  readonly name: string;
}

/**
 * Dynamiczna rejestracja (RFC 7591). Klient przysyła swoje `redirect_uris`,
 * a my oddajemy `client_id`, w którym te adresy są **zapieczętowane podpisem**.
 * Dzięki temu nie trzymamy rejestru klientów, a mimo to nikt nie podmieni
 * adresu przekierowania po rejestracji — próba zmiany unieważnia podpis.
 */
export function registerClient(cfg: OAuthConfig, body: unknown): { status: number; body: unknown } {
  const rec = (body ?? {}) as Record<string, unknown>;
  const uris = Array.isArray(rec["redirect_uris"]) ? (rec["redirect_uris"] as unknown[]) : [];
  const redirect_uris = uris.filter((u): u is string => typeof u === "string" && u.length > 0);

  if (redirect_uris.length === 0) {
    return {
      status: 400,
      body: { error: "invalid_client_metadata", error_description: "redirect_uris jest wymagane" },
    };
  }

  const name = typeof rec["client_name"] === "string" ? rec["client_name"] : "klient MCP";
  const client_id = seal(cfg.signingKey, { redirect_uris, name } satisfies ClientMeta);

  return {
    status: 201,
    body: {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris,
      client_name: name,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Klient publiczny: bez sekretu, bezpieczeństwo stoi na PKCE.
      token_endpoint_auth_method: "none",
    },
  };
}

// ── autoryzacja ───────────────────────────────────────────────────────────────

export interface AuthorizeRequest {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly state: string | null;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly resource: string | null;
}

export type AuthorizeCheck =
  | { ok: true; client: ClientMeta }
  /** Błąd, którego NIE WOLNO przekierować — bo nie ufamy adresowi. */
  | { ok: false; kind: "fatal"; message: string }
  /** Błąd, który wolno oddać klientowi przez redirect. */
  | { ok: false; kind: "redirect"; error: string; description: string };

/**
 * Sprawdzenie żądania autoryzacji.
 *
 * Rozróżnienie „fatal" i „redirect" nie jest kosmetyczne: dopóki nie wiemy, że
 * `redirect_uri` należy do zarejestrowanego klienta, przekierowanie tam
 * czegokolwiek byłoby otwartym przekierowaniem. Błąd pokazujemy wtedy na
 * naszej stronie.
 */
export function checkAuthorize(cfg: OAuthConfig, req: AuthorizeRequest): AuthorizeCheck {
  const client = unseal<ClientMeta>(cfg.signingKey, req.client_id);
  if (!client) return { ok: false, kind: "fatal", message: "Nieznany client_id." };

  if (!client.redirect_uris.includes(req.redirect_uri)) {
    return { ok: false, kind: "fatal", message: "redirect_uri nie pasuje do rejestracji klienta." };
  }
  if (req.code_challenge_method !== "S256" || !req.code_challenge) {
    return {
      ok: false,
      kind: "redirect",
      error: "invalid_request",
      description: "wymagane PKCE z metodą S256",
    };
  }
  return { ok: true, client };
}

interface CodePayload {
  readonly c: string; // code_challenge
  readonly u: string; // redirect_uri
  readonly r: string | null; // resource
  readonly exp: number;
  readonly n: string; // nonce — czyni kod niepowtarzalnym
}

export function issueCode(cfg: OAuthConfig, req: AuthorizeRequest): string {
  return seal(cfg.signingKey, {
    c: req.code_challenge,
    u: req.redirect_uri,
    r: req.resource,
    exp: Math.floor(Date.now() / 1000) + CODE_TTL_SEC,
    n: randomBytes(9).toString("base64url"),
  } satisfies CodePayload);
}

// ── wymiana kodu na token ─────────────────────────────────────────────────────

interface TokenPayload {
  readonly sub: string;
  readonly scope: string;
  readonly aud: string;
  readonly exp: number;
  readonly typ: "access" | "refresh";
  readonly n: string;
}

export interface TokenRequest {
  readonly grant_type: string;
  readonly code?: string | undefined;
  readonly code_verifier?: string | undefined;
  readonly redirect_uri?: string | undefined;
  readonly refresh_token?: string | undefined;
}

/** Zbiór zużytych kodów. Kod żyje 60 s, więc zbiór jest z natury malutki. */
const usedCodes = new Set<string>();

export function exchangeToken(
  cfg: OAuthConfig,
  req: TokenRequest,
): { status: number; body: unknown } {
  const teraz = Math.floor(Date.now() / 1000);

  if (req.grant_type === "refresh_token") {
    const p = unseal<TokenPayload>(cfg.signingKey, req.refresh_token ?? "");
    if (!p || p.typ !== "refresh" || p.exp < teraz) {
      return { status: 400, body: { error: "invalid_grant" } };
    }
    return { status: 200, body: tokens(cfg, p.aud) };
  }

  if (req.grant_type !== "authorization_code") {
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }

  const code = req.code ?? "";
  const p = unseal<CodePayload>(cfg.signingKey, code);
  if (!p || p.exp < teraz) return { status: 400, body: { error: "invalid_grant" } };

  // Jednorazowość: kod przechwycony i odtworzony nie zadziała drugi raz.
  if (usedCodes.has(code)) return { status: 400, body: { error: "invalid_grant" } };

  if (req.redirect_uri && req.redirect_uri !== p.u) {
    return { status: 400, body: { error: "invalid_grant" } };
  }

  // PKCE: S256(code_verifier) musi dać zapisane wyzwanie.
  const verifier = req.code_verifier ?? "";
  const wyliczone = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(wyliczone, "utf8");
  const b = Buffer.from(p.c, "utf8");
  if (!verifier || a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 400, body: { error: "invalid_grant", error_description: "PKCE się nie zgadza" } };
  }

  usedCodes.add(code);
  // Sprzątanie: po dwóch minutach kod i tak jest przeterminowany.
  setTimeout(() => usedCodes.delete(code), 2 * CODE_TTL_SEC * 1000).unref?.();

  return { status: 200, body: tokens(cfg, p.r ?? `${cfg.issuer}/mcp`) };
}

function tokens(cfg: OAuthConfig, aud: string): unknown {
  const teraz = Math.floor(Date.now() / 1000);
  const mk = (typ: "access" | "refresh", ttl: number): string =>
    seal(cfg.signingKey, {
      sub: "wlasciciel",
      scope: SCOPE,
      aud,
      exp: teraz + ttl,
      typ,
      n: randomBytes(9).toString("base64url"),
    } satisfies TokenPayload);

  return {
    access_token: mk("access", ACCESS_TTL_SEC),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token: mk("refresh", 30 * 24 * 3600),
    scope: SCOPE,
  };
}

/** Czy ten token dostępu jest nasz, ważny i właściwego rodzaju. */
export function verifyAccessToken(cfg: OAuthConfig, token: string): boolean {
  const p = unseal<TokenPayload>(cfg.signingKey, token);
  return p !== null && p.typ === "access" && p.exp >= Math.floor(Date.now() / 1000);
}

// ── ekran zgody ───────────────────────────────────────────────────────────────

/** Porównanie hasła w czasie stałym. */
export function passwordMatches(cfg: OAuthConfig, provided: string): boolean {
  const a = Buffer.from(createHash("sha256").update(provided).digest());
  const b = Buffer.from(createHash("sha256").update(cfg.password).digest());
  return timingSafeEqual(a, b);
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Strona zgody. Celowo brzydka i celowo mówiąca wprost, co się stanie —
 * to jedyny moment, w którym człowiek decyduje o dostępie do poczty firmy.
 */
export function consentPage(params: {
  readonly clientName: string;
  readonly query: string;
  readonly error?: string | undefined;
}): string {
  return `<!doctype html><html lang="pl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>BHT Copilot — dostęp</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
 margin:0;padding:32px 20px;max-width:460px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}
p{color:#666;margin:0 0 18px}
ul{color:#666;font-size:14.5px;padding-left:20px;margin:0 0 20px}
input{font:inherit;width:100%;min-height:48px;padding:0 14px;margin-bottom:12px;
 border:1px solid #ccc;border-radius:11px;box-sizing:border-box}
button{font:inherit;font-weight:600;width:100%;min-height:48px;border:0;border-radius:11px;
 background:#1f4fd8;color:#fff}
.zle{color:#c0392b;font-size:14px;margin-bottom:12px}
.stopka{color:#888;font-size:13px;margin-top:22px}
</style></head><body>
<h1>Dać dostęp aplikacji ${esc(params.clientName)}?</h1>
<p>Poprosi o odczyt Twoich danych operacyjnych.</p>
<ul>
  <li>skrzynka pocztowa — tylko do odczytu,</li>
  <li>dane TeaBrew — tylko do odczytu,</li>
  <li>lista Twoich spraw.</li>
</ul>
${params.error ? `<div class="zle">${esc(params.error)}</div>` : ""}
<form method="post" action="/oauth/authorize?${esc(params.query)}">
  <input type="password" name="haslo" placeholder="Hasło BHT Copilota" autocomplete="current-password" required autofocus>
  <button type="submit">Zezwól</button>
</form>
<p class="stopka">Nic nie zostanie wysłane ani zmienione — te uprawnienia pozwalają wyłącznie czytać.</p>
</body></html>`;
}
