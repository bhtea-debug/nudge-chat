#!/usr/bin/env tsx
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createApp } from "../index.js";
import { createMcpCore, SERVER_NAME, SERVER_VERSION, SUPPORTED_PROTOCOLS, type JsonRpcRequest } from "../mcp/core.js";
import { newCorrelationId } from "../capability/audit.js";
import { renderRun, costLine } from "../state/report.js";
import { appendFileSync, readFileSync } from "node:fs";
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
import { Subskrypcje } from "../push/subskrypcje.js";
import { ikonaPng, manifest, serviceWorker, stronaPush } from "../push/strona.js";
import { konfiguracjaZeSrodowiska, wyslij, type Waga } from "../push/wyslij.js";
import {
  FirmowyChatEvent,
  ingestFirmowyChatEvent,
  verifyFirmowyChatSignature,
} from "../chat/events.js";
import {
  CUSTOMER_CASE_REPLY_BRIDGE_PATH,
  CustomerCaseReplyRequest,
  forwardCustomerCaseReply,
  type ReplyBridgeUpstreamConfig,
} from "../customer-cases/reply-bridge.js";

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

/**
 * Moment startu TEGO procesu.
 *
 * Wygląda błaho, a rozstrzyga pytanie, na które inaczej nie ma odpowiedzi
 * z zewnątrz: „czy odpowiada mi nowy kontener, czy stary jeszcze nie zszedł".
 * Wdrożenie raz już zameldowało „gotowe", bo `/health` odpowiadał — tyle że
 * odpowiadała poprzednia wersja. Skrypt wdrożeniowy czeka teraz na ZMIANĘ tej
 * wartości, a nie na samą odpowiedź.
 */
const STARTED_AT = new Date().toISOString();

/**
 * Który KOD tu stoi.
 *
 * `startedAt` odróżnia procesy, ale nie odróżnia wersji — a to są dwie różne
 * rzeczy i pomyliliśmy je już raz, kosztem całej rundy. Ustawienie zmiennych
 * środowiskowych restartuje kontener ze STARYM obrazem: proces jest nowy,
 * kod ten sam. Sprawdzenie po wdrożeniu zaliczało wtedy sukces po piętnastu
 * sekundach, choć budowanie obrazu tyle nie trwa.
 *
 * Znacznik wjeżdża do obrazu razem ze źródłami (skrypt wdrożeniowy zapisuje go
 * tuż przed wysłaniem), więc stary kontener nie może udawać nowego niezależnie
 * od tego, ile razy go zrestartujemy. Jego brak jest normalny przy uruchomieniu
 * z repozytorium i nie jest błędem.
 */
const WERSJA_KODU: string | null = (() => {
  try {
    const j = JSON.parse(readFileSync(fromPackageRoot("src/wersja.json"), "utf8")) as {
      commit?: unknown;
    };
    return typeof j.commit === "string" ? j.commit : null;
  } catch {
    return null;
  }
})();
const TOKEN = (process.env["MCP_BEARER_TOKEN"] ?? "").trim();
const TRUSTED_FIRMOWY_CHAT_TOKEN = (
  process.env["MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN"] ?? ""
).trim();
const CUSTOMER_CASE_REPLY_BRIDGE_TOKEN = (
  process.env["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN"] ?? ""
).trim();
const TEABREW_AI_OPERATOR_REPLY_TOKEN = (
  process.env["TEABREW_AI_OPERATOR_REPLY_TOKEN"] ?? ""
).trim();
const TEABREW_BASE_URL = (process.env["TEABREW_BASE_URL"] ?? "").trim();
const MODE = (process.env["MODE"] ?? "fixture").trim();
const TEABREW_AI_OPERATOR_READ_TOKEN = (
  process.env["TEABREW_AI_OPERATOR_TOKEN"] ?? ""
).trim();
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

if (
  TRUSTED_FIRMOWY_CHAT_TOKEN.length > 0 &&
  TRUSTED_FIRMOWY_CHAT_TOKEN.length < MIN_TOKEN_LENGTH
) {
  process.stderr.write(
    `[${SERVER_NAME}] MCP_TRUSTED_FIRMOWY_CHAT_BEARER_TOKEN jest za krótki ` +
      `(${TRUSTED_FIRMOWY_CHAT_TOKEN.length} znaków, wymagane min. ${MIN_TOKEN_LENGTH}).\n`,
  );
  process.exit(1);
}

if (TRUSTED_FIRMOWY_CHAT_TOKEN && TRUSTED_FIRMOWY_CHAT_TOKEN === TOKEN) {
  process.stderr.write(
    `[${SERVER_NAME}] token firmowego czatu musi być inny niż publiczny MCP_BEARER_TOKEN.\n`,
  );
  process.exit(1);
}

const REPLY_BRIDGE_PARTIALLY_CONFIGURED =
  Boolean(CUSTOMER_CASE_REPLY_BRIDGE_TOKEN) !== Boolean(TEABREW_AI_OPERATOR_REPLY_TOKEN);

if (REPLY_BRIDGE_PARTIALLY_CONFIGURED) {
  process.stderr.write(
    `[${SERVER_NAME}] CUSTOMER_CASE_REPLY_BRIDGE_TOKEN i ` +
      "TEABREW_AI_OPERATOR_REPLY_TOKEN muszą być ustawione razem.\n",
  );
  process.exit(1);
}

for (const [name, value] of [
  ["CUSTOMER_CASE_REPLY_BRIDGE_TOKEN", CUSTOMER_CASE_REPLY_BRIDGE_TOKEN],
  ["TEABREW_AI_OPERATOR_REPLY_TOKEN", TEABREW_AI_OPERATOR_REPLY_TOKEN],
] as const) {
  if (value.length > 0 && value.length < MIN_TOKEN_LENGTH) {
    process.stderr.write(
      `[${SERVER_NAME}] ${name} jest za krótki (${value.length} znaków, ` +
        `wymagane min. ${MIN_TOKEN_LENGTH}).\n`,
    );
    process.exit(1);
  }
}

const REPLY_BRIDGE_ENABLED = CUSTOMER_CASE_REPLY_BRIDGE_TOKEN.length >= MIN_TOKEN_LENGTH;
let REPLY_BRIDGE_UPSTREAM_ORIGIN = "";

if (REPLY_BRIDGE_ENABLED && !TEABREW_BASE_URL) {
  process.stderr.write(
    `[${SERVER_NAME}] Brak TEABREW_BASE_URL wymagany przez bridge odpowiedzi klientom.\n`,
  );
  process.exit(1);
}

if (REPLY_BRIDGE_ENABLED) {
  try {
    const upstream = new URL(TEABREW_BASE_URL);
    const fixtureLoopback =
      MODE !== "live" &&
      upstream.protocol === "http:" &&
      (upstream.hostname === "127.0.0.1" || upstream.hostname === "localhost");
    if (
      (upstream.protocol !== "https:" && !fixtureLoopback) ||
      upstream.username ||
      upstream.password ||
      upstream.pathname !== "/" ||
      upstream.search ||
      upstream.hash
    ) {
      throw new Error("invalid");
    }
    REPLY_BRIDGE_UPSTREAM_ORIGIN = upstream.origin;
  } catch {
    process.stderr.write(
      `[${SERVER_NAME}] TEABREW_BASE_URL dla bridge'a musi być originem HTTPS bez ` +
        "danych logowania, ścieżki, query ani fragmentu (HTTP tylko loopback poza MODE=live).\n",
    );
    process.exit(1);
  }
}

if (REPLY_BRIDGE_ENABLED) {
  const forbiddenReuse = [
    [CUSTOMER_CASE_REPLY_BRIDGE_TOKEN, TOKEN],
    [CUSTOMER_CASE_REPLY_BRIDGE_TOKEN, TRUSTED_FIRMOWY_CHAT_TOKEN],
    [CUSTOMER_CASE_REPLY_BRIDGE_TOKEN, TEABREW_AI_OPERATOR_READ_TOKEN],
    [CUSTOMER_CASE_REPLY_BRIDGE_TOKEN, TEABREW_AI_OPERATOR_REPLY_TOKEN],
    [TEABREW_AI_OPERATOR_REPLY_TOKEN, TOKEN],
    [TEABREW_AI_OPERATOR_REPLY_TOKEN, TRUSTED_FIRMOWY_CHAT_TOKEN],
    [TEABREW_AI_OPERATOR_REPLY_TOKEN, TEABREW_AI_OPERATOR_READ_TOKEN],
  ].some(([left, right]) => Boolean(left) && Boolean(right) && left === right);
  if (forbiddenReuse) {
    process.stderr.write(
      `[${SERVER_NAME}] tokeny bridge'a, MCP i odczytu TeaBrew muszą mieć osobne wartości.\n`,
    );
    process.exit(1);
  }
}

const REPLY_BRIDGE_UPSTREAM: ReplyBridgeUpstreamConfig | null = REPLY_BRIDGE_ENABLED
  ? { baseUrl: REPLY_BRIDGE_UPSTREAM_ORIGIN, token: TEABREW_AI_OPERATOR_REPLY_TOKEN }
  : null;

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

// ── powiadomienia ─────────────────────────────────────────────────────────────
/**
 * Web Push. Jedyna droga z tego serwera na iPhone'a właściciela, która nie
 * wymaga ani aplikacji z App Store, ani cudzej usługi pośredniczącej —
 * i jedyna, w której treść alertu jest szyfrowana end-to-end.
 *
 * Klucze VAPID przychodzą ze środowiska. Ich brak wyłącza POWIERZCHNIĘ, nie
 * produkt: serwer wstaje, Claude działa, powiadomienia po prostu nie ruszą
 * i `/health` mówi o tym wprost.
 */
const PUSH = konfiguracjaZeSrodowiska();
const subskrypcje = new Subskrypcje(app.config.copilot.stateDir);

// ── limit żądań ───────────────────────────────────────────────────────────────
/**
 * Kubełek żetonów per token uwierzytelniający, nie per IP: klient mobilny zmienia
 * adres w trakcie dnia, a chodzi o ograniczenie JEDNEGO klienta, nie sieci.
 * Limit jest hojny dla człowieka i ciasny dla pętli, która się zapętliła.
 */
const RATE_CAPACITY = 60;
const RATE_REFILL_PER_SEC = 1;
const buckets = new Map<string, { tokens: number; at: number }>();
const REPLY_RATE_CAPACITY = 10;
const REPLY_RATE_REFILL_PER_SEC = 1 / 6;
let replyBucket = { tokens: REPLY_RATE_CAPACITY, at: Date.now() };

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

/** Osobny, ciaśniejszy bezpiecznik przed pętlą w konsumencie firmowego czatu. */
function allowCustomerCaseReply(): boolean {
  const now = Date.now();
  const refill = ((now - replyBucket.at) / 1000) * REPLY_RATE_REFILL_PER_SEC;
  const tokens = Math.min(REPLY_RATE_CAPACITY, replyBucket.tokens + refill);
  if (tokens < 1) {
    replyBucket = { tokens, at: now };
    return false;
  }
  replyBucket = { tokens: tokens - 1, at: now };
  return true;
}

// ── uwierzytelnienie ──────────────────────────────────────────────────────────
/** Porównanie w czasie stałym. Zwykłe === wycieka długość wspólnego prefiksu. */
function constantTimeTokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function tokenMatches(provided: string): boolean {
  return constantTimeTokenMatches(provided, TOKEN);
}

function trustedFirmowyChatTokenMatches(provided: string): boolean {
  if (!TRUSTED_FIRMOWY_CHAT_TOKEN) return false;
  return constantTimeTokenMatches(provided, TRUSTED_FIRMOWY_CHAT_TOKEN);
}

function customerCaseReplyBridgeTokenMatches(provided: string): boolean {
  if (!CUSTOMER_CASE_REPLY_BRIDGE_TOKEN) return false;
  return constantTimeTokenMatches(provided, CUSTOMER_CASE_REPLY_BRIDGE_TOKEN);
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

function coreFor(
  sessionId: string | null,
  trustedFirmowyChat: boolean,
): ReturnType<typeof createMcpCore> {
  const key = `${trustedFirmowyChat ? "firmowy-chat" : "model"}:${sessionId ?? newCorrelationId()}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  if (sessions.size >= SESSION_LIMIT) {
    // Najstarsza sesja wypada. Nie trzymamy stanu rozmowy, więc utrata sesji
    // kosztuje wyłącznie wspólny identyfikator korelacji w audycie.
    const oldest = sessions.keys().next().value;
    if (oldest) sessions.delete(oldest);
  }
  const core = createMcpCore(key, { trustedFirmowyChat });
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
const MAX_CUSTOMER_CASE_REPLY_BODY = 16 * 1024;

async function readBody(req: IncomingMessage, maxBytes = MAX_BODY): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error("żądanie za duże");
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
      const probe = coreFor("health", false);
      json(res, 200, {
        ok: probe.startupError() === null,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        // Lista, nie jedna wartość: serwer uzgadnia wersję z klientem, a health
        // ma mówić, co naprawdę jest do wzięcia.
        protocols: SUPPORTED_PROTOCOLS,
        tools: probe.toolNames().length,
        startupError: probe.startupError(),
        monitorInProcess: MONITOR_IN_PROCESS,
        lastMailScanAt: safeLastScan(),
        startedAt: STARTED_AT,
        commit: WERSJA_KODU,
        // Dwie rzeczy, bez których nie da się z zewnątrz odpowiedzieć na pytanie
        // „dlaczego Claude się nie łączy". Żadna z nich nie jest sekretem:
        //  - `oauth` mówi tylko, CZY hasło zgody jest ustawione, nie jakie,
        //  - `issuer` to publiczny adres tego serwera; kto pyta, i tak go zna.
        // Ich brak kosztował już jedną rundę zgadywania.
        oauth: OAUTH_ENABLED,
        issuer: issuerOf(req),
        // Czy powiadomienia mają czym ruszyć i czy ktokolwiek je odbiera.
        // Liczba urządzeń, nie adresy — te są sekretem subskrypcji.
        push: PUSH !== null,
        pushUrzadzenia: safeIleSubskrypcji(),
        firmowyChatEvents: Boolean(app.config.firmowyChat.eventsSecret),
        // Tylko gotowość techniczna. Nie ujawniamy tokenów ani adresu upstreamu.
        customerCaseReplyBridge: REPLY_BRIDGE_UPSTREAM !== null,
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

    // ── powiadomienia ─────────────────────────────────────────────────────
    if (url.pathname === "/push" || url.pathname.startsWith("/push/")) {
      const status = await handlePush(req, res, url);
      logAccess(status, "push", url.pathname.slice(5) || "strona", Date.now() - started);
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

    // Własny Czat Firmowy ma osobny, wersjonowany kontrakt i obowiązkowy HMAC.
    // Nie współdzieli luźnego parsera webhooków z zewnętrznym dostawcą.
    if (url.pathname === "/events/chat") {
      const status = await handleFirmowyChatEvent(req, res);
      logAccess(status, "event", "firmowy-chat", Date.now() - started);
      return;
    }

    // Dedykowany bridge serwisowy: NIE jest MCP, capability ani narzędziem AI.
    // Wyłącznie firmowy czat może wejść osobnym tokenem po potwierdzeniu człowieka.
    if (url.pathname === CUSTOMER_CASE_REPLY_BRIDGE_PATH) {
      const status = await handleCustomerCaseReplyBridge(req, res);
      logAccess(status, "customer-case-reply", "allegro", Date.now() - started);
      return;
    }

    if (url.pathname !== "/mcp") {
      json(res, 404, { error: "nieznana ścieżka; MCP jest pod /mcp" });
      logAccess(404, req.method ?? "?", null, Date.now() - started);
      return;
    }

    const provided = bearerOf(req);
    // Publiczny statyczny token i OAuth prowadzą do zredagowanego profilu
    // modelowego. Osobny token serwisowy firmowego czatu daje dodatkowy zakres
    // display; nigdy nie może być współdzielony z Claude ani diagnostyką.
    const trustedFirmowyChat =
      provided !== null && trustedFirmowyChatTokenMatches(provided);
    const standardMcp =
      provided !== null && (tokenMatches(provided) || verifyAccessToken(oauthFor(req), provided));
    const wpuszczony = trustedFirmowyChat || standardMcp;

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
    const core = coreFor(sessionId, trustedFirmowyChat);
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
 * Firmowy czat -> BHT Copilot bridge -> TeaBrew.
 *
 * Handler nie zapisuje tekstu, nie przekazuje go do rejestru capability i nie
 * ponawia wywołania. Po timeout/5xx odpowiedź mówi wprost, że wynik jest
 * niejednoznaczny i operator ma najpierw odświeżyć wątek.
 */
async function handleCustomerCaseReplyBridge(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number> {
  if (!REPLY_BRIDGE_UPSTREAM) {
    json(res, 503, { ok: false, error: "reply_bridge_not_configured" });
    return 503;
  }

  const provided = bearerOf(req);
  if (provided === null || !customerCaseReplyBridgeTokenMatches(provided)) {
    json(res, 401, { ok: false, error: "unauthorized" });
    return 401;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "use_post" });
    return 405;
  }

  const contentType = singleHeader(req.headers["content-type"])
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    json(res, 415, { ok: false, error: "content_type_must_be_application_json" });
    return 415;
  }

  if (!allowCustomerCaseReply()) {
    json(
      res,
      429,
      { ok: false, error: "reply_rate_limited" },
      { "retry-after": "6" },
    );
    return 429;
  }

  let raw: string;
  try {
    raw = await readBody(req, MAX_CUSTOMER_CASE_REPLY_BODY);
  } catch {
    json(res, 413, { ok: false, error: "request_too_large" });
    return 413;
  }

  let unknownRequest: unknown;
  try {
    unknownRequest = JSON.parse(raw);
  } catch {
    json(res, 400, { ok: false, error: "invalid_json" });
    return 400;
  }

  const parsed = CustomerCaseReplyRequest.safeParse(unknownRequest);
  if (!parsed.success) {
    // Nie zwracamy szczegółów Zod: mogłyby zawierać fragment tekstu klienta.
    json(res, 422, { ok: false, error: "invalid_reply_request" });
    return 422;
  }

  const outcome = await forwardCustomerCaseReply(parsed.data, REPLY_BRIDGE_UPSTREAM);
  json(res, outcome.status, outcome.body);
  return outcome.status;
}

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
 * Zdarzenie z własnego Czatu Firmowego. W odróżnieniu od webhooka zewnętrznego
 * błąd zapisu zwraca 500: nadawca ma trwały outbox i bezpiecznie ponowi request.
 */
async function handleFirmowyChatEvent(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number> {
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

  const timestamp = singleHeader(req.headers["x-bht-timestamp"]);
  const signature = singleHeader(req.headers["x-bht-signature"]);
  const verdict = verifyFirmowyChatSignature({
    rawBody: raw,
    timestampHeader: timestamp,
    signatureHeader: signature,
    secret: app.config.firmowyChat.eventsSecret,
  });
  if (!verdict.ok) {
    const status = verdict.reason === "not_configured" ? 503 : 401;
    json(res, status, {
      error: verdict.reason === "not_configured" ? "integracja nie jest skonfigurowana" : "unauthorized",
    });
    process.stderr.write(`[firmowy-chat] odrzucone zdarzenie: ${verdict.reason}\n`);
    return status;
  }

  let unknownPayload: unknown;
  try {
    unknownPayload = JSON.parse(raw);
  } catch {
    json(res, 400, { error: "niepoprawny JSON" });
    return 400;
  }
  const parsed = FirmowyChatEvent.safeParse(unknownPayload);
  if (!parsed.success) {
    json(res, 422, { error: "niezgodny kontrakt zdarzenia" });
    process.stderr.write("[firmowy-chat] odrzucone zdarzenie niezgodne z kontraktem\n");
    return 422;
  }
  const headerEventId = singleHeader(req.headers["x-bht-event-id"]);
  if (headerEventId !== parsed.data.eventId) {
    json(res, 400, { error: "identyfikator zdarzenia nie zgadza się z ładunkiem" });
    return 400;
  }

  try {
    const out = ingestFirmowyChatEvent(app.store, parsed.data);
    let notification: { attempted: boolean; sent: number; errors: number } = {
      attempted: false,
      sent: 0,
      errors: 0,
    };
    const issue = out.issueId ? app.store.get(out.issueId) : null;
    if (
      issue?.notificationCandidate &&
      out.outcome !== "duplicate" &&
      PUSH &&
      subskrypcje.ile() > 0
    ) {
      const result = await wyslij(PUSH, subskrypcje, {
        tytul: `BHT Copilot · ${issue.title}`,
        tresc: `${issue.id} · ${issue.notificationReason ?? issue.whyListed}`,
        waga: "pilne",
        tag: `issue:${issue.id}`,
      });
      notification = {
        attempted: true,
        sent: result.wyslane,
        errors: result.bledy.length,
      };
    }
    json(res, 200, {
      accepted: out.accepted,
      outcome: out.outcome,
      issueId: out.issueId,
      notification,
    });
    process.stdout.write(
      `[firmowy-chat] ${out.outcome} zdarzenie=${parsed.data.eventId} sprawa=${out.issueId ?? "-"}\n`,
    );
    return 200;
  } catch (error) {
    process.stderr.write(
      `[firmowy-chat] błąd ingestu: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    json(res, 500, { error: "nie udało się zapisać zdarzenia" });
    return 500;
  }
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Odbiornik powiadomień: strona, service worker, manifest, ikona i trzy
 * końcówki do zarządzania subskrypcją.
 *
 * ── Dlaczego to jest chronione hasłem ─────────────────────────────────────────
 * Subskrypcja to zgoda na otrzymywanie alertów o sprawach firmy. Gdyby
 * `/push/subscribe` stało otworem, każdy, kto zna adres, zapisałby SWOJE
 * urządzenie i od tej chwili dostawał nazwy klientów i numery zamówień —
 * i nie byłoby tego widać, bo alerty docierałyby też do właściciela.
 *
 * Używamy tego samego hasła co ekran zgody OAuth. Świadomie nie dokładamy
 * kolejnego sekretu: dwa hasła do jednego produktu to jedno hasło zapisane
 * na kartce.
 */
async function handlePush(req: IncomingMessage, res: ServerResponse, url: URL): Promise<number> {
  const sciezka = url.pathname.replace(/\/+$/, "") || "/push";

  // Zasoby statyczne — bez uwierzytelnienia, bo nie ma w nich ani jednej danej
  // firmy. Klucz publiczny VAPID jest z definicji publiczny: służy do
  // zaszyfrowania ładunku DLA nas, nie do odszyfrowania czegokolwiek.
  if (req.method === "GET") {
    if (sciezka === "/push") {
      if (!PUSH) {
        plik(res, 503, "text/html; charset=utf-8", Buffer.from(
          "<!doctype html><meta charset=utf-8><p>Powiadomienia nie są skonfigurowane na tym serwerze (brak kluczy VAPID).</p>",
        ));
        return 503;
      }
      plik(res, 200, "text/html; charset=utf-8", Buffer.from(stronaPush(PUSH.publiczny), "utf8"));
      return 200;
    }
    if (sciezka === "/push/manifest.webmanifest") {
      plik(res, 200, "application/manifest+json; charset=utf-8", Buffer.from(manifest(), "utf8"));
      return 200;
    }
    if (sciezka === "/push/sw.js") {
      plik(res, 200, "text/javascript; charset=utf-8", Buffer.from(serviceWorker(), "utf8"));
      return 200;
    }
    if (sciezka === "/push/ikona.png") {
      plik(res, 200, "image/png", ikonaPng(), "public, max-age=86400");
      return 200;
    }
  }

  if (req.method !== "POST") {
    json(res, 404, { error: "nieznana ścieżka powiadomień" });
    return 404;
  }

  if (!OAUTH_ENABLED) {
    json(res, 503, { error: "brak COPILOT_AUTH_PASSWORD — nie ma czym chronić subskrypcji" });
    return 503;
  }

  let ciało: Record<string, unknown> = {};
  try {
    ciało = JSON.parse(await readBody(req)) as Record<string, unknown>;
  } catch {
    json(res, 400, { error: "ładunek nie jest poprawnym JSON-em" });
    return 400;
  }

  // Limit prób hasła per adres — inaczej ta końcówka jest wygodniejsza do
  // zgadywania niż ekran zgody, bo odpowiada JSON-em i da się ją zapętlić.
  if (!allow(`push:${req.socket.remoteAddress ?? "?"}`)) {
    json(res, 429, { error: "za dużo prób" }, { "retry-after": "5" });
    return 429;
  }

  const cfg = oauthFor(req);
  if (!passwordMatches(cfg, typeof ciało["haslo"] === "string" ? ciało["haslo"] : "")) {
    process.stderr.write("[push] odrzucone: złe hasło\n");
    json(res, 401, { error: "nieprawidłowe hasło" });
    return 401;
  }

  if (sciezka === "/push/subscribe") {
    const s = ciało["subskrypcja"] as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    if (typeof s?.endpoint !== "string" || typeof s.keys?.p256dh !== "string" || typeof s.keys?.auth !== "string") {
      json(res, 400, { error: "niekompletna subskrypcja" });
      return 400;
    }
    subskrypcje.dodaj({
      endpoint: s.endpoint,
      keys: { p256dh: s.keys.p256dh, auth: s.keys.auth },
      dodanaO: new Date().toISOString(),
      opis: typeof ciało["opis"] === "string" ? ciało["opis"].slice(0, 60) : "urządzenie",
    });
    // Adresu bramki NIE logujemy — jest sekretem urządzenia.
    process.stdout.write(`[push] zapisano urządzenie, razem: ${subskrypcje.ile()}\n`);
    json(res, 200, { ok: true, urzadzenia: subskrypcje.ile() });
    return 200;
  }

  if (sciezka === "/push/unsubscribe") {
    const endpoint = typeof ciało["endpoint"] === "string" ? ciało["endpoint"] : "";
    const usuniete = endpoint ? subskrypcje.usun(endpoint) : false;
    json(res, 200, { ok: true, usuniete, urzadzenia: subskrypcje.ile() });
    return 200;
  }

  if (sciezka === "/push/test") {
    if (!PUSH) {
      json(res, 503, { error: "brak kluczy VAPID" });
      return 503;
    }
    if (subskrypcje.ile() === 0) {
      json(res, 409, { error: "żadne urządzenie nie ma włączonych powiadomień" });
      return 409;
    }
    const waga = ciało["waga"] === "pilne" || ciało["waga"] === "informacja" ? (ciało["waga"] as Waga) : "zwykle";
    const wynik = await wyslij(PUSH, subskrypcje, {
      tytul: typeof ciało["tytul"] === "string" ? ciało["tytul"] : "BHT Copilot",
      tresc: typeof ciało["tresc"] === "string" ? ciało["tresc"] : "Powiadomienie testowe.",
      waga,
      tag: typeof ciało["tag"] === "string" ? ciało["tag"] : undefined,
    });
    process.stdout.write(
      `[push] wysłane=${wynik.wyslane} usunięte=${wynik.usuniete} błędy=${wynik.bledy.length}\n`,
    );
    json(res, wynik.wyslane > 0 ? 200 : 502, wynik);
    return wynik.wyslane > 0 ? 200 : 502;
  }

  json(res, 404, { error: "nieznana ścieżka powiadomień" });
  return 404;
}

function plik(
  res: ServerResponse,
  status: number,
  typ: string,
  body: Buffer,
  cache = "no-store",
): void {
  res.writeHead(status, {
    "content-type": typ,
    "content-length": body.length,
    "cache-control": cache,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function safeIleSubskrypcji(): number {
  try {
    return subskrypcje.ile();
  } catch {
    // Uszkodzony plik subskrypcji nie może przewrócić health-checku.
    return 0;
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
  const probe = coreFor("boot", false);
  // Pierwsze linie muszą odpowiadać na „co właściwie wstało i gdzie mam wejść",
  // bo to jedyne, co właściciel widzi po uruchomieniu.
  process.stdout.write(
    `[${SERVER_NAME}] nasłuchuję na :${PORT}\n` +
      `[${SERVER_NAME}] narzędzia dla Claude: ${probe.toolNames().length}\n` +
      `[${SERVER_NAME}] OAuth dla konektora: ${OAUTH_ENABLED ? "włączony" : "WYŁĄCZONY (brak COPILOT_AUTH_PASSWORD) — Claude się nie połączy"}\n` +
      `[${SERVER_NAME}] powiadomienia: ${PUSH ? `włączone, urządzeń: ${safeIleSubskrypcji()}` : "WYŁĄCZONE (brak kluczy VAPID)"}\n` +
      `[${SERVER_NAME}] bridge odpowiedzi Allegro: ${REPLY_BRIDGE_UPSTREAM ? "włączony (po potwierdzeniu człowieka)" : "wyłączony"}\n` +
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
