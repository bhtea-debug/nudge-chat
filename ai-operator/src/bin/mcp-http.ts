#!/usr/bin/env tsx
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createApp } from "../index.js";
import { createMcpCore, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, type JsonRpcRequest } from "../mcp/core.js";
import { newCorrelationId } from "../capability/audit.js";
import { renderRun, costLine } from "../state/report.js";
import { appendFileSync } from "node:fs";
import { fromPackageRoot } from "../paths.js";
import { eventTypeOf, ingestChatMessage, messageFromWebhook, verifySignature } from "../connecteam/ingest.js";
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
} from "../mcp/oauth.js";

/**
 * Remote MCP — ten sam serwer, transport HTTP, dostępny także z telefonu.
 *
 * Architektura celowo płaska: jeden proces trzyma naraz endpoint MCP i monitor
 * poczty w tle. Powody, każdy praktyczny:
 *  - jeden deploy i jedno miejsce awarii zamiast dwóch,
 *  - JEDEN pisarz do stanu spraw (monitor) i jeden czytelnik (MCP) w tym samym
 *    procesie, więc nie ma wyścigu o dziennik,
 *  - Copilot ma być warstwą pomocniczą; im mniej ruchomych części, tym mniejsza
 *    szansa, że jego awaria zabierze uwagę potrzebną gdzie indziej.
 *
 * Czego tu NIE MA:
 *  - definicji capability i schematów — wszystko z rejestru (src/mcp/core.ts),
 *  - logiki poczty i TeaBrew,
 *  - wywołania modelu przy obsłudze żądania: reasoning robi Claude po swojej
 *    stronie, my tylko podajemy dane,
 *  - własnej tożsamości i ról. To jest świadome: ARCHITEKTURA-AI-2026 punkt 15
 *    zabrania budowania autoryzacji wewnątrz MCP, bo przy złym wyborze odtwarza
 *    dzisiejsze rozdrobnienie tożsamości o warstwę wyżej. Jeden token dla
 *    jednego aktora — właściciela.
 */

const app = createApp();
const PORT = Number(process.env["PORT"] ?? 8787);
const TOKEN = (process.env["MCP_BEARER_TOKEN"] ?? "").trim();
const MONITOR_IN_PROCESS = (process.env["MONITOR_IN_PROCESS"] ?? "1") !== "0";
const COST_LOG = fromPackageRoot(process.env["COST_LOG"] ?? "state/koszty.jsonl");

/** Minimalna długość tokenu. Krótszy nie jest sekretem, tylko hasłem do zgadnięcia. */
const MIN_TOKEN_LENGTH = 32;

/**
 * Jedna powierzchnia dla ludzi i jest nią Claude.
 *
 * Przez chwilę stał tu obok interfejs w przeglądarce z własnym hasłem. Został
 * usunięty na wyraźne polecenie właściciela: **całe UI ma być w Claude.** Nie
 * jest to porzucony kod, a decyzja produktowa — dlatego serwer bez tokenu nie
 * wstaje wcale, zamiast wstawać „bez jednej z powierzchni".
 *
 *  - brak tokenu     → nie ma czego uruchomić; monitor zbierałby dane, których
 *                      nikt nie zobaczy,
 *  - token za krótki → NIE wstajemy. Ktoś próbował ustawić uwierzytelnienie
 *                      i zrobił to źle; cicha praca z takim tokenem byłaby
 *                      gorsza niż odmowa.
 *
 * `/webhook/connecteam` jest wyjątkiem i nie łamie tej zasady: uwierzytelnia się
 * podpisem ładunku, bo po drugiej stronie stoi serwer dostawcy, nie człowiek.
 */
const MCP_ENABLED = TOKEN.length >= MIN_TOKEN_LENGTH;

if (TOKEN.length > 0 && !MCP_ENABLED) {
  process.stderr.write(
    `[${SERVER_NAME}] MCP_BEARER_TOKEN jest za krótki (${TOKEN.length} znaków, wymagane min. ${MIN_TOKEN_LENGTH}).\n` +
      "Wygeneruj: openssl rand -base64 48\n" +
      "Serwer NIE wstaje — token ustawiony po części jest gorszy niż brak tokenu,\n" +
      "bo wygląda na zabezpieczenie, którym nie jest.\n",
  );
  process.exit(1);
}

if (!MCP_ENABLED) {
  // Claude JEST interfejsem tego produktu, więc bez tokenu nie ma czego
  // uruchamiać: monitor sam z siebie nikomu niczego nie pokazuje.
  process.stderr.write(
    `[${SERVER_NAME}] Brak MCP_BEARER_TOKEN — nie mam czego uruchomić.\n` +
      "Claude łączy się z tym serwerem tym tokenem i jest jedynym interfejsem\n" +
      "tego produktu; bez niego monitor zbierałby dane, których nikt nie zobaczy.\n\n" +
      "  MCP_BEARER_TOKEN=$(openssl rand -base64 48)\n",
  );
  process.exit(1);
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
/**
 * Okno „Add custom connector" w Claude nie ma pola na token — tylko adres oraz
 * opcjonalne OAuth Client ID i Secret. Sprawdzone na ekranie właściciela.
 * Statyczny token zostaje dla `curl` i diagnostyki; dla Claude jedyną drogą
 * jest OAuth.
 *
 * Klucz podpisujący wywodzimy z `MCP_BEARER_TOKEN`, więc nie przybywa sekretów,
 * a jego rotacja unieważnia WSZYSTKIE wydane tokeny naraz.
 */
const AUTH_PASSWORD = (process.env["COPILOT_AUTH_PASSWORD"] ?? "").trim();

/**
 * Publiczny adres serwera. Bierzemy z nagłówków żądania, bo Railway nadaje
 * domenę po wdrożeniu i wpisywanie jej ręcznie byłoby kolejną rzeczą do
 * rozjechania się. `PUBLIC_URL` pozwala to nadpisać, gdyby stanął przed tym
 * własny proxy.
 */
function issuerOf(req: IncomingMessage): string {
  const wymuszony = (process.env["PUBLIC_URL"] ?? "").trim().replace(/\/+$/, "");
  if (wymuszony) return wymuszony;
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? "https";
  const host = (req.headers["x-forwarded-host"] as string | undefined) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

const oauthFor = (req: IncomingMessage): OAuthConfig => ({
  issuer: issuerOf(req),
  signingKey: `oauth:${TOKEN}`,
  password: AUTH_PASSWORD,
});

const OAUTH_ENABLED = AUTH_PASSWORD.length >= 8;

// ── limit żądań ───────────────────────────────────────────────────────────────
/**
 * Kubełek żetonów per token uwierzytelniający, nie per IP: klient mobilny zmienia
 * adres w trakcie dnia, a chodzi o ograniczenie JEDNEGO klienta, nie sieci.
 * Limit jest hojny dla człowieka i ciasny dla pętli, która się zapętliła.
 */
const RATE_CAPACITY = 60;
const RATE_REFILL_PER_SEC = 1;
const buckets = new Map<string, { tokens: number; at: number }>();

function allow(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: RATE_CAPACITY, at: now };
  const refill = ((now - b.at) / 1000) * RATE_REFILL_PER_SEC;
  const tokens = Math.min(RATE_CAPACITY, b.tokens + refill);
  if (tokens < 1) {
    buckets.set(key, { tokens, at: now });
    return false;
  }
  buckets.set(key, { tokens: tokens - 1, at: now });
  return true;
}

// ── uwierzytelnienie ──────────────────────────────────────────────────────────
/** Porównanie w czasie stałym. Zwykłe === wycieka długość wspólnego prefiksu. */
function tokenMatches(provided: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() ?? null;
}

// ── sesje ─────────────────────────────────────────────────────────────────────
/**
 * Jedna korelacja audytu na sesję MCP. Klient podaje `Mcp-Session-Id`; gdy go
 * nie ma, traktujemy żądanie jako osobną sesję — lepiej mieć więcej korelacji
 * niż zlepić dwie różne rozmowy w jedną.
 */
const sessions = new Map<string, ReturnType<typeof createMcpCore>>();
const SESSION_LIMIT = 32;

function coreFor(sessionId: string | null): ReturnType<typeof createMcpCore> {
  const key = sessionId ?? newCorrelationId();
  const existing = sessions.get(key);
  if (existing) return existing;
  if (sessions.size >= SESSION_LIMIT) {
    // Najstarsza sesja wypada. Nie trzymamy stanu rozmowy, więc utrata sesji
    // kosztuje wyłącznie wspólny identyfikator korelacji w audycie.
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }
  const core = createMcpCore(key);
  sessions.set(key, core);
  return core;
}

// ── logowanie ─────────────────────────────────────────────────────────────────
/**
 * Log dostępu BEZ sekretów i BEZ treści. Zapisujemy metodę JSON-RPC i nazwę
 * narzędzia, bo to odpowiada na pytanie „czego klient chciał". Nie zapisujemy
 * argumentów: tam bywają frazy wyszukiwania i numery, a te mają swoje miejsce
 * w audycie capability, gdzie adresy są maskowane.
 */
function logAccess(status: number, method: string, tool: string | null, ms: number): void {
  process.stdout.write(
    `${new Date().toISOString()} ${status} ${method}${tool ? ` ${tool}` : ""} ${ms}ms\n`,
  );
}

/**
 * Nagłówki CORS dla powierzchni JSON.
 *
 * Klient Claude wykonuje część odkrywania OAuth z przeglądarki, a przeglądarka
 * wysyła najpierw zapytanie OPTIONS. Bez odpowiedzi na nie właściwe żądanie
 * **nigdy nie wychodzi** i po naszej stronie nie ma nawet wpisu w logu — awaria
 * wygląda wtedy jak cisza i nie da się jej odróżnić od „serwer nie odpowiada".
 *
 * Gwiazdka jest tu bezpieczna, bo w tym serwerze nie ma ciasteczek ani sesji
 * przeglądarkowych: te ścieżki albo są publicznymi metadanymi, albo wymagają
 * nagłówka `Authorization`, którego przeglądarka nie dołoży sama. Cudza strona
 * nie ma więc czego nadużyć — nie dysponuje tokenem właściciela.
 *
 * Ekran zgody (`html()`) CORS-u nie dostaje i zostaje przy `X-Frame-Options`,
 * bo tam człowiek podejmuje decyzję i nie ma być do niej namówiony z ramki.
 */
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
  "access-control-expose-headers": "mcp-session-id, www-authenticate",
  "access-control-max-age": "86400",
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // Odpowiedzi zawierają dane firmy — żadnego pośredniego cache'owania.
    "cache-control": "no-store",
    ...CORS,
    ...headers,
  });
  res.end(payload);
}

const MAX_BODY = 256 * 1024;

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error("żądanie za duże");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── serwer ────────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  void (async () => {
    // Preflight przeglądarki. Musi być obsłużony PRZED czymkolwiek innym, bo
    // dotyczy każdej ścieżki i przychodzi zawsze przed właściwym żądaniem.
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      logAccess(204, "OPTIONS", null, Date.now() - started);
      return;
    }

    // Health BEZ uwierzytelnienia i BEZ danych: mówi tylko, że proces żyje
    // i ile narzędzi wystawia. Platformy hostingowe wymagają takiego endpointu,
    // a brak w nim danych firmy jest warunkiem jego istnienia.
    if (url.pathname === "/health") {
      const probe = coreFor("health");
      json(res, 200, {
        ok: probe.startupError() === null,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: PROTOCOL_VERSION,
        tools: probe.toolNames().length,
        startupError: probe.startupError(),
        monitorInProcess: MONITOR_IN_PROCESS,
        lastMailScanAt: safeLastScan(),
        // Dwie rzeczy, bez których nie da się z zewnątrz odpowiedzieć na pytanie
        // „dlaczego Claude się nie łączy". Żadna z nich nie jest sekretem:
        //  - `oauth` mówi tylko, CZY hasło zgody jest ustawione, nie jakie,
        //  - `issuer` to publiczny adres tego serwera; kto pyta, i tak go zna.
        // Ich brak kosztował już jedną rundę zgadywania.
        oauth: OAUTH_ENABLED,
        issuer: issuerOf(req),
      });
      logAccess(200, "health", null, Date.now() - started);
      return;
    }

    // ── OAuth: metadane i flow ────────────────────────────────────────────
    // Ścieżki `.well-known` odpowiadamy w OBU wariantach — z sufiksem ścieżki
    // zasobu i bez niego. RFC 9728 opisuje wariant z sufiksem, ale klienci
    // pytają różnie, a niedopasowanie kończy się cichym „nie znalazłem".
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(res, 200, protectedResourceMetadata(oauthFor(req)));
      logAccess(200, "oauth", "prm", Date.now() - started);
      return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      json(res, 200, authorizationServerMetadata(oauthFor(req)));
      logAccess(200, "oauth", "asm", Date.now() - started);
      return;
    }

    if (url.pathname === "/oauth/register" && req.method === "POST") {
      if (!OAUTH_ENABLED) {
        json(res, 503, { error: "oauth_disabled" });
        logAccess(503, "oauth", "register", Date.now() - started);
        return;
      }
      let ciało: unknown = {};
      try {
        ciało = JSON.parse(await readBody(req));
      } catch {
        /* pusty ładunek obsłuży walidacja niżej */
      }
      const out = registerClient(oauthFor(req), ciało);
      json(res, out.status, out.body);
      logAccess(out.status, "oauth", "register", Date.now() - started);
      return;
    }

    if (url.pathname === "/oauth/authorize") {
      const status = await handleAuthorize(req, res, url);
      logAccess(status, "oauth", "authorize", Date.now() - started);
      return;
    }

    if (url.pathname === "/oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const out = exchangeToken(oauthFor(req), {
        grant_type: form.get("grant_type") ?? "",
        code: form.get("code") ?? undefined,
        code_verifier: form.get("code_verifier") ?? undefined,
        redirect_uri: form.get("redirect_uri") ?? undefined,
        refresh_token: form.get("refresh_token") ?? undefined,
      });
      json(res, out.status, out.body);
      logAccess(out.status, "oauth", "token", Date.now() - started);
      return;
    }

    // Webhook Connecteam. Uwierzytelnia się PODPISEM ładunku, nie tokenem MCP
    // i nie ciasteczkiem sesji — po drugiej stronie stoi serwer dostawcy, który
    // nie ma ani jednego, ani drugiego.
    if (url.pathname === "/webhook/connecteam") {
      const status = await handleConnecteamWebhook(req, res);
      logAccess(status, "webhook", "connecteam", Date.now() - started);
      return;
    }

    if (url.pathname !== "/mcp") {
      json(res, 404, { error: "nieznana ścieżka; MCP jest pod /mcp" });
      logAccess(404, req.method ?? "?", null, Date.now() - started);
      return;
    }

    const provided = bearerOf(req);
    // Dwie drogi: statyczny token (curl, diagnostyka, klienci umiejące nagłówek)
    // oraz token wydany przez nasz OAuth (Claude — bo jego okno konektora nie
    // ma pola na token). Obie prowadzą do tych samych, wyłącznie odczytowych
    // narzędzi; różni je tylko sposób, w jaki klient udowadnia, że to on.
    const wpuszczony =
      provided !== null && (tokenMatches(provided) || verifyAccessToken(oauthFor(req), provided));

    if (!wpuszczony) {
      // Nagłówek MUSI wskazać metadane zasobu — bez tego klient dostaje samo
      // 401 i nie ma jak zacząć rozmowy o autoryzacji. To był brakujący element
      // poprzedniej wersji: brama działała, ale nie mówiła, jak przez nią przejść.
      json(res, 401, { error: "unauthorized" }, { "www-authenticate": wwwAuthenticate(oauthFor(req)) });
      logAccess(401, req.method ?? "?", null, Date.now() - started);
      return;
    }

    if (!allow(provided.slice(0, 16))) {
      json(res, 429, { error: "za dużo żądań — spróbuj po chwili" }, { "retry-after": "5" });
      logAccess(429, req.method ?? "?", null, Date.now() - started);
      return;
    }

    if (req.method === "GET") {
      // Streamable HTTP dopuszcza GET dla strumienia zdarzeń serwera. Nie mamy
      // czego wysyłać z własnej inicjatywy, więc mówimy to wprost zamiast
      // trzymać otwarte połączenie, które nigdy nic nie przyśle.
      json(res, 405, { error: "ten serwer nie wysyła zdarzeń; użyj POST /mcp" });
      logAccess(405, "GET", null, Date.now() - started);
      return;
    }

    if (req.method !== "POST") {
      json(res, 405, { error: "użyj POST /mcp" });
      logAccess(405, req.method ?? "?", null, Date.now() - started);
      return;
    }

    let parsed: JsonRpcRequest | JsonRpcRequest[];
    try {
      parsed = JSON.parse(await readBody(req)) as JsonRpcRequest | JsonRpcRequest[];
    } catch (err) {
      json(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : "parse error" },
      });
      logAccess(400, "POST", null, Date.now() - started);
      return;
    }

    const sessionId = (req.headers["mcp-session-id"] as string | undefined) ?? null;
    const core = coreFor(sessionId);
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const firstTool =
      batch.find((r) => r.method === "tools/call")?.params?.["name"];

    const results: Record<string, unknown>[] = [];
    for (const one of batch) {
      const out = await core.handle(one);
      if (out) results.push({ jsonrpc: "2.0", ...out });
    }

    const headers: Record<string, string> = {};
    // Klient używa tego nagłówka do wiązania kolejnych żądań w jedną sesję —
    // czyli w jedną korelację audytu.
    if (batch.some((r) => r.method === "initialize")) {
      headers["mcp-session-id"] = sessionId ?? newCorrelationId();
    }

    if (results.length === 0) {
      // Same powiadomienia — nie ma czego odsyłać.
      res.writeHead(202, headers);
      res.end();
      logAccess(202, "POST", null, Date.now() - started);
      return;
    }

    json(res, 200, Array.isArray(parsed) ? results : results[0], headers);
    logAccess(200, "POST", typeof firstTool === "string" ? firstTool : null, Date.now() - started);
  })().catch((err) => {
    if (!res.headersSent) json(res, 500, { error: "błąd serwera" });
    process.stderr.write(`[${SERVER_NAME}] ${err instanceof Error ? err.stack : String(err)}\n`);
  });
});

/**
 * Webhook Connecteam (§11).
 *
 * Trzy rzeczy, które ta funkcja musi robić dobrze:
 *
 *  1. **Odpowiedzieć szybko i zawsze 200 przy poprawnym podpisie.** Dostawca
 *     webhooków traktuje kod błędu jako sygnał do ponowienia; zwrócenie 500 na
 *     ładunek, którego po prostu nie rozumiemy, wywołałoby retry w pętli.
 *     Dlatego „nie rozumiem tego ładunku" to 200 z wyjaśnieniem, a nie 4xx.
 *  2. **Nie przyjąć niczego bez weryfikacji, gdy sekret JEST ustawiony.**
 *  3. **Nie logować treści.** W logu ląduje wynik i identyfikator konwersacji,
 *     nigdy tekst wiadomości pracownika.
 */
async function handleConnecteamWebhook(req: IncomingMessage, res: ServerResponse): Promise<number> {
  if (req.method !== "POST") {
    json(res, 405, { error: "użyj POST" });
    return 405;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    json(res, 413, { error: "ładunek za duży" });
    return 413;
  }

  const secret = app.config.connecteam.webhookSecret;
  const header =
    (req.headers["x-connecteam-signature"] as string | undefined) ??
    (req.headers["x-signature"] as string | undefined) ??
    null;
  const verdict = verifySignature(raw, header ?? null, secret);

  if (verdict === false) {
    json(res, 401, { error: "unauthorized" });
    process.stderr.write("[connecteam] odrzucony webhook: podpis się nie zgadza\n");
    return 401;
  }
  if (verdict === null) {
    // Brak sekretu to świadomy wybór właściciela, ale musi być widoczny za
    // każdym razem — inaczej „tymczasowo bez podpisu" zostaje na zawsze.
    process.stderr.write(
      "[connecteam] UWAGA: przyjmuję webhook BEZ weryfikacji podpisu (CONNECTEAM_WEBHOOK_SECRET nie ustawiony)\n",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    json(res, 200, { accepted: false, why: "ładunek nie jest poprawnym JSON-em" });
    return 200;
  }

  const parsed = messageFromWebhook(payload);
  if ("error" in parsed) {
    json(res, 200, { accepted: false, why: parsed.error });
    process.stdout.write(`[connecteam] pominięty ładunek: ${parsed.error}\n`);
    return 200;
  }

  try {
    const out = ingestChatMessage(app.store, parsed, eventTypeOf(payload) ?? "message_created");
    json(res, 200, { accepted: out.accepted, outcome: out.outcome, issueId: out.issueId });
    process.stdout.write(
      `[connecteam] ${out.outcome} konwersacja=${parsed.conversationId} sprawa=${out.issueId ?? "-"}\n`,
    );
    return 200;
  } catch (err) {
    // Awaria naszego stanu przy pojedynczej wiadomości nie może wyglądać dla
    // dostawcy jak awaria trwała — inaczej wyłączy webhooka.
    process.stderr.write(
      `[connecteam] błąd wchłaniania: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    json(res, 200, { accepted: false, why: "błąd po naszej stronie — zapisany w logu" });
    return 200;
  }
}

/**
 * Ekran zgody i wydanie kodu autoryzacyjnego.
 *
 * GET  → pokazuje pytanie o hasło,
 * POST → sprawdza hasło i przekierowuje z kodem.
 *
 * Rozdzielenie błędów na „pokaż u nas" i „przekieruj" jest istotne: dopóki nie
 * wiemy, że `redirect_uri` należy do zarejestrowanego klienta, przekierowanie
 * tam czegokolwiek byłoby otwartym przekierowaniem — czyli gotowym narzędziem
 * dla kogoś, kto podszywa się pod nasz adres.
 */
async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> {
  if (!OAUTH_ENABLED) {
    html(res, 503, "<p>OAuth nie jest włączony na tym serwerze (brak COPILOT_AUTH_PASSWORD).</p>");
    return 503;
  }

  const cfg = oauthFor(req);
  const q = url.searchParams;
  const zadanie = {
    client_id: q.get("client_id") ?? "",
    redirect_uri: q.get("redirect_uri") ?? "",
    state: q.get("state"),
    code_challenge: q.get("code_challenge") ?? "",
    code_challenge_method: q.get("code_challenge_method") ?? "",
    resource: q.get("resource"),
  };

  const sprawdzenie = checkAuthorize(cfg, zadanie);
  if (!sprawdzenie.ok) {
    if (sprawdzenie.kind === "fatal") {
      html(res, 400, `<p>${sprawdzenie.message}</p>`);
      return 400;
    }
    const cel = new URL(zadanie.redirect_uri);
    cel.searchParams.set("error", sprawdzenie.error);
    cel.searchParams.set("error_description", sprawdzenie.description);
    if (zadanie.state) cel.searchParams.set("state", zadanie.state);
    res.writeHead(302, { location: cel.toString(), "cache-control": "no-store" });
    res.end();
    return 302;
  }

  if (req.method === "GET") {
    html(res, 200, consentPage({ clientName: sprawdzenie.client.name, query: url.searchParams.toString() }));
    return 200;
  }

  if (req.method !== "POST") {
    html(res, 405, "<p>Użyj GET albo POST.</p>");
    return 405;
  }

  // Limit prób per adres z warstwy transportu. Nie ufamy X-Forwarded-For:
  // klient podaje go dowolnie, więc oparcie limitu na nim to brak limitu.
  const klucz = `oauth:${req.socket.remoteAddress ?? "?"}`;
  if (!allow(klucz)) {
    html(res, 429, "<p>Za dużo prób. Odczekaj chwilę.</p>");
    return 429;
  }

  const haslo = new URLSearchParams(await readBody(req)).get("haslo") ?? "";
  if (!passwordMatches(cfg, haslo)) {
    process.stderr.write("[oauth] nieudana próba zgody: złe hasło\n");
    html(
      res,
      401,
      consentPage({
        clientName: sprawdzenie.client.name,
        query: url.searchParams.toString(),
        error: "Nieprawidłowe hasło.",
      }),
    );
    return 401;
  }

  const cel = new URL(zadanie.redirect_uri);
  cel.searchParams.set("code", issueCode(cfg, zadanie));
  if (zadanie.state) cel.searchParams.set("state", zadanie.state);
  res.writeHead(302, { location: cel.toString(), "cache-control": "no-store" });
  res.end();
  process.stdout.write(`[oauth] zgoda udzielona klientowi „${sprawdzenie.client.name}"\n`);
  return 302;
}

function html(res: ServerResponse, status: number, body: string): void {
  const payload = body.startsWith("<!doctype")
    ? body
    : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="font:16px/1.5 -apple-system,sans-serif;max-width:460px;margin:40px auto;padding:0 20px">${body}</body>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(payload);
}

function safeLastScan(): string | null {
  try {
    return app.store.lastOkScanAt();
  } catch {
    // Awaria stanu Copilota nie może przewrócić health-checku — inaczej platforma
    // uznałaby cały serwer za martwy z powodu warstwy pomocniczej.
    return null;
  }
}

// ── monitor w tym samym procesie ──────────────────────────────────────────────

let monitorTimer: NodeJS.Timeout | null = null;

async function monitorTick(): Promise<void> {
  try {
    const run = await app.monitor.runOnce();
    process.stdout.write(renderRun(run) + "\n");
    try {
      appendFileSync(COST_LOG, costLine(run) + "\n", "utf8");
    } catch {
      // Log kosztów jest best-effort; jego utrata nie może zatrzymać monitora.
    }
  } catch (err) {
    // Nieudany przebieg NIE przewraca serwera: endpoint MCP musi dalej działać,
    // żeby właściciel mógł ręcznie sprawdzić pocztę i TeaBrew. To jest wprost
    // wymaganie o awarii — Copilot nie jest zależnością krytyczną.
    process.stderr.write(
      `[monitor] przebieg nie udał się: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

server.listen(PORT, () => {
  const probe = coreFor("boot");
  // Pierwsze linie muszą odpowiadać na „co właściwie wstało i gdzie mam wejść",
  // bo to jedyne, co właściciel widzi po uruchomieniu.
  process.stdout.write(
    `[${SERVER_NAME}] nasłuchuję na :${PORT}\n` +
      `[${SERVER_NAME}] narzędzia dla Claude: ${probe.toolNames().length}\n` +
      `[${SERVER_NAME}] OAuth dla konektora: ${OAUTH_ENABLED ? "włączony" : "WYŁĄCZONY (brak COPILOT_AUTH_PASSWORD) — Claude się nie połączy"}\n` +
      `[${SERVER_NAME}] tryb: ${app.config.mode}, foldery: ${app.config.copilot.monitorFolders.join(", ")}\n` +
      `[${SERVER_NAME}] monitor w procesie: ${MONITOR_IN_PROCESS ? `tak, pierwszy przebieg za 20 s, potem co ${app.config.copilot.intervalMinutes} min` : "nie"}\n`,
  );
  if (probe.startupError()) {
    process.stderr.write(
      `[${SERVER_NAME}] UWAGA: konfiguracja niepełna — narzędzia zwrócą błąd: ${probe.startupError()}\n`,
    );
  }

  if (MONITOR_IN_PROCESS) {
    // Pierwszy przebieg z opóźnieniem: platforma hostingowa woła /health zaraz
    // po starcie i nie chcemy, żeby czekał na połączenie IMAP.
    setTimeout(() => void monitorTick(), 20_000);
    monitorTimer = setInterval(
      () => void monitorTick(),
      app.config.copilot.intervalMinutes * 60_000,
    );
  }
});

const shutdown = (signal: string): void => {
  process.stdout.write(`[${SERVER_NAME}] ${signal} — zamykam\n`);
  if (monitorTimer) clearInterval(monitorTimer);
  server.close(() => {
    void app.close().finally(() => process.exit(0));
  });
  // Twardy limit: platformy dają zwykle kilkanaście sekund na zamknięcie.
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
