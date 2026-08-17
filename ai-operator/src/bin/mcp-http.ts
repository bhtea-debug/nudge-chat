#!/usr/bin/env tsx
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createApp } from "../index.js";
import { createMcpCore, PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION, type JsonRpcRequest } from "../mcp/core.js";
import { newCorrelationId } from "../capability/audit.js";
import { renderRun, costLine } from "../state/report.js";
import { appendFileSync } from "node:fs";
import { fromPackageRoot } from "../paths.js";
import { handleUi } from "../ui/server.js";
import { ephemeralSigningKey, MIN_PASSWORD_LENGTH, UiAuth } from "../ui/auth.js";
import type { SyncState } from "../ui/views.js";
import { eventTypeOf, ingestChatMessage, messageFromWebhook, verifySignature } from "../connecteam/ingest.js";

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

if (TOKEN.length < MIN_TOKEN_LENGTH) {
  // Fail-closed przy starcie: serwer bez tokenu nie ma prawa wstać, bo
  // wystawiałby pocztę firmy do internetu bez żadnej bramy.
  process.stderr.write(
    `[${SERVER_NAME}] BRAK albo za krótki MCP_BEARER_TOKEN (wymagane min. ${MIN_TOKEN_LENGTH} znaków).\n` +
      "Wygeneruj: openssl rand -base64 48\n" +
      "Serwer nie wstaje — nie wystawię poczty bez uwierzytelnienia.\n",
  );
  process.exit(1);
}

// ── interfejs właściciela ─────────────────────────────────────────────────────
/**
 * UI jest opcjonalny i sam się włącza, gdy jest hasło. Bez hasła serwer wstaje
 * dalej — Remote MCP działa niezależnie i nie ma powodu, żeby brak jednej
 * zmiennej odbierał Claude dostęp do poczty.
 */
const ui = app.config.ui.enabled
  ? (() => {
      if (app.config.ui.password.length < MIN_PASSWORD_LENGTH) {
        process.stderr.write(
          `[${SERVER_NAME}] COPILOT_UI_PASSWORD jest krótsze niż ${MIN_PASSWORD_LENGTH} znaków — UI NIE wstaje.\n` +
            "To jedyna brama między internetem a pocztą firmy. Wygeneruj: openssl rand -base64 24\n",
        );
        return null;
      }
      const signingKey = app.config.ui.signingKey ?? ephemeralSigningKey();
      if (!app.config.ui.signingKey) {
        process.stdout.write(
          `[${SERVER_NAME}] COPILOT_UI_SIGNING_KEY nie ustawiony — sesje nie przeżyją restartu procesu.\n`,
        );
      }
      return new UiAuth({
        password: app.config.ui.password,
        signingKey,
        secureCookie: app.config.ui.secureCookie,
      });
    })()
  : null;

function syncState(): SyncState {
  try {
    return {
      lastOkScanAt: app.store.lastOkScanAt(),
      checkpoints: app.store.checkpoints(),
      integrityWarning: app.store.integrityWarning(),
    };
  } catch {
    // Awaria stanu nie może zabrać całego ekranu — właściciel ma zobaczyć
    // stronę mówiącą „nie wiem", a nie błąd serwera.
    return { lastOkScanAt: null, checkpoints: [], integrityWarning: null };
  }
}

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

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // Odpowiedzi zawierają dane firmy — żadnego pośredniego cache'owania.
    "cache-control": "no-store",
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
      });
      logAccess(200, "health", null, Date.now() - started);
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

    if (ui && (await handleUi(req, res, url, {
      store: app.store,
      auth: ui,
      sync: syncState,
      claudeUrl: app.config.ui.claudeUrl,
    }))) {
      logAccess(res.statusCode, req.method ?? "?", "ui", Date.now() - started);
      return;
    }

    if (url.pathname !== "/mcp") {
      json(res, 404, { error: "nieznana ścieżka; MCP jest pod /mcp" });
      logAccess(404, req.method ?? "?", null, Date.now() - started);
      return;
    }

    const provided = bearerOf(req);
    if (!provided || !tokenMatches(provided)) {
      // Bez szczegółów w treści: komunikat „zły token" vs „brak tokenu" to
      // darmowa informacja dla kogoś, kto próbuje.
      json(res, 401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="bht-operator"' });
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
  process.stdout.write(
    `[${SERVER_NAME}] nasłuchuję na :${PORT}\n` +
      `[${SERVER_NAME}] narzędzia: ${probe.toolNames().length} (${probe.toolNames().join(", ")})\n` +
      `[${SERVER_NAME}] tryb: ${app.config.mode}, foldery: ${app.config.copilot.monitorFolders.join(", ")}\n` +
      `[${SERVER_NAME}] monitor w procesie: ${MONITOR_IN_PROCESS ? `tak, co ${app.config.copilot.intervalMinutes} min` : "nie"}\n`,
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
