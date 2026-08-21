import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CUSTOMER_CASE_REPLY_BRIDGE_PATH,
  CUSTOMER_CASE_REPLY_CONFIRMATION,
  CustomerCaseReplyRequest,
  forwardCustomerCaseReply,
  type CustomerCaseReplyRequest as ReplyRequest,
} from "../src/customer-cases/reply-bridge.js";

const REQUEST: ReplyRequest = {
  requestId: "reply.20260821.0001",
  caseId: "case-123",
  text: "Dziękujemy za wiadomość.",
  expectedLastMessageAt: 1_777_000_000_000,
  confirmation: CUSTOMER_CASE_REPLY_CONFIRMATION,
};

function teaResult(
  status: "sent" | "failed" | "uncertain",
  overrides: Record<string, unknown> = {},
) {
  return {
    ok: true,
    ts: 1_777_000_000_100,
    contractVersion: "v1",
    data: {
      status,
      requestId: REQUEST.requestId,
      idempotent: false,
      externalMessageId: status === "sent" ? "message-456" : null,
      sentAt: status === "sent" ? 1_777_000_000_100 : null,
      code: status === "failed" ? "stale_case" : null,
      message: status === "sent" ? "Wysłano." : "Sprawdź stan sprawy.",
      ...overrides,
    },
  };
}

describe("kontrakt bridge'a odpowiedzi Allegro", () => {
  it("jest strict, nie przyjmuje załączników ani tekstu ponad 2000 znaków", () => {
    expect(CustomerCaseReplyRequest.safeParse(REQUEST).success).toBe(true);
    expect(
      CustomerCaseReplyRequest.safeParse({ ...REQUEST, attachments: [] }).success,
    ).toBe(false);
    expect(
      CustomerCaseReplyRequest.safeParse({ ...REQUEST, text: "x".repeat(2_001) }).success,
    ).toBe(false);
    expect(CustomerCaseReplyRequest.safeParse({ ...REQUEST, text: "   " }).success).toBe(
      false,
    );
    expect(
      CustomerCaseReplyRequest.safeParse({ ...REQUEST, confirmation: "YES" }).success,
    ).toBe(false);
    expect(
      CustomerCaseReplyRequest.safeParse({ ...REQUEST, expectedLastMessageAt: null }).success,
    ).toBe(true);
  });

  it("wykonuje dokładnie jeden POST z osobnym tokenem i nagłówkiem potwierdzenia", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(teaResult("sent")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await forwardCustomerCaseReply(REQUEST, {
      baseUrl: "https://teabrew.example/",
      token: "upstream-reply-token",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://teabrew.example/ai-operator/customer-case-reply",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toMatchObject({
      authorization: "Bearer upstream-reply-token",
      "content-type": "application/json",
      "x-bht-human-confirmation": "confirmed",
    });
    expect(JSON.parse(String(init?.body))).toEqual(REQUEST);
    expect(outcome).toMatchObject({
      status: 200,
      body: { ok: true, data: { status: "sent", requestId: REQUEST.requestId } },
    });
  });

  it.each([
    [202, "uncertain"],
    [409, "failed"],
  ] as const)("zachowuje jednoznaczny kontrakt HTTP %s", async (status, state) => {
    const outcome = await forwardCustomerCaseReply(REQUEST, {
      baseUrl: "https://teabrew.example",
      token: "upstream-reply-token",
      fetchImpl: async () =>
        new Response(JSON.stringify(teaResult(state)), {
          status,
          headers: { "content-type": "application/json" },
        }),
    });

    expect(outcome).toMatchObject({ status, body: { data: { status: state } } });
  });

  it("nie ponawia timeoutu i oznacza wynik jako niejednoznaczny", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });

    const outcome = await forwardCustomerCaseReply(REQUEST, {
      baseUrl: "https://teabrew.example",
      token: "upstream-reply-token",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      status: 504,
      body: { ok: false, error: "upstream_timeout", ambiguous: true },
    });
  });

  it("5xx i niezgodna odpowiedź są bezpieczne, niejednoznaczne i bez retry", async () => {
    const fetch5xx = vi.fn(async () => new Response("sekret upstreamu", { status: 503 }));
    const unavailable = await forwardCustomerCaseReply(REQUEST, {
      baseUrl: "https://teabrew.example",
      token: "upstream-reply-token",
      fetchImpl: fetch5xx,
    });
    expect(fetch5xx).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(unavailable)).not.toContain("sekret upstreamu");
    expect(unavailable).toEqual({
      status: 502,
      body: { ok: false, error: "upstream_server_error", ambiguous: true },
    });

    const invalid = await forwardCustomerCaseReply(REQUEST, {
      baseUrl: "https://teabrew.example",
      token: "upstream-reply-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ...teaResult("sent"), extra: "nie ujawniaj" }), {
          status: 200,
        }),
    });
    expect(invalid).toEqual({
      status: 502,
      body: { ok: false, error: "invalid_upstream_response", ambiguous: true },
    });
  });
});

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const httpEntry = fileURLToPath(new URL("../src/bin/mcp-http.ts", import.meta.url));
const BRIDGE_PORT = 8871;
const UPSTREAM_PORT = 8872;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_TOKEN = "b".repeat(48);
const UPSTREAM_TOKEN = "u".repeat(48);
const MCP_TOKEN = "m".repeat(48);

let bridge: ChildProcess;
let upstream: Server;
let upstreamStatus = 200;
let upstreamHits = 0;
let lastUpstreamHeaders: IncomingHttpHeaders = {};
let lastUpstreamBody: unknown = null;
let bridgeStdout = "";
let bridgeStderr = "";

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamHits += 1;
      lastUpstreamHeaders = req.headers;
      lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (upstreamStatus >= 500) {
        res.writeHead(upstreamStatus, { "content-type": "text/plain" });
        res.end("wewnętrzny sekret TeaBrew");
        return;
      }
      const requestId = (lastUpstreamBody as { requestId: string }).requestId;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(teaResult("sent", { requestId })));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

  bridge = spawn(process.execPath, [tsxCli, httpEntry], {
    cwd: operatorDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? tmpdir(),
      MODE: "fixture",
      MONITOR_IN_PROCESS: "0",
      COPILOT_STATE_DIR: join(tmpdir(), `bht-reply-bridge-${process.pid}`),
      PORT: String(BRIDGE_PORT),
      MCP_BEARER_TOKEN: MCP_TOKEN,
      CUSTOMER_CASE_REPLY_BRIDGE_TOKEN: BRIDGE_TOKEN,
      TEABREW_AI_OPERATOR_REPLY_TOKEN: UPSTREAM_TOKEN,
      TEABREW_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout?.on("data", (chunk: Buffer) => (bridgeStdout += chunk.toString()));
  bridge.stderr?.on("data", (chunk: Buffer) => (bridgeStderr += chunk.toString()));

  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // Kontener testowy jeszcze wstaje.
    }
    if (Date.now() > deadline) {
      throw new Error(`bridge nie wstał; stderr: ${bridgeStderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  bridge?.kill();
  await new Promise<void>((resolve) => upstream?.close(() => resolve()));
});

async function postBridge(body: unknown, token: string | null = BRIDGE_TOKEN) {
  const response = await fetch(`${BASE}${CUSTOMER_CASE_REPLY_BRIDGE_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("dedykowany endpoint HTTP odpowiedzi Allegro", () => {
  it("health pokazuje bridge, a MCP nadal publikuje tylko 4 odczyty Allegro", async () => {
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health).toMatchObject({ customerCaseReplyBridge: true, tools: 22 });

    const response = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${MCP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const rpc = (await response.json()) as any;
    const allegro = rpc.result.tools.filter((tool: any) => tool.name.includes("allegro"));
    expect(allegro).toHaveLength(4);
    expect(allegro.map((tool: any) => tool.name).join(" ")).not.toMatch(
      /send|reply|write|post|update|assign|status_set/,
    );
  });

  it("fail-closed: osobny token, strict Zod, brak załączników", async () => {
    const before = upstreamHits;
    expect(await postBridge(REQUEST, null)).toMatchObject({ status: 401 });
    expect(await postBridge(REQUEST, "wrong-token")).toMatchObject({ status: 401 });
    expect(await postBridge({ ...REQUEST, attachments: [] })).toMatchObject({ status: 422 });
    expect(await postBridge({ ...REQUEST, confirmation: "YES" })).toMatchObject({ status: 422 });
    expect(await postBridge({ ...REQUEST, text: "x".repeat(2_001) })).toMatchObject({
      status: 422,
    });
    expect(upstreamHits).toBe(before);
  });

  it("przekazuje raz, bez tekstu w logach i bez tokenu bridge'a do TeaBrew", async () => {
    const canary = "TEKST-KLIENTA-NIE-MOZE-TRAFIC-DO-LOGU";
    const before = upstreamHits;
    const result = await postBridge({ ...REQUEST, text: canary });

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, data: { status: "sent", requestId: REQUEST.requestId } },
    });
    expect(upstreamHits).toBe(before + 1);
    expect(lastUpstreamHeaders.authorization).toBe(`Bearer ${UPSTREAM_TOKEN}`);
    expect(lastUpstreamHeaders.authorization).not.toContain(BRIDGE_TOKEN);
    expect(lastUpstreamHeaders["x-bht-human-confirmation"]).toBe("confirmed");
    expect(lastUpstreamBody).toEqual({ ...REQUEST, text: canary });
    expect(bridgeStdout).not.toContain(canary);
    expect(bridgeStderr).not.toContain(canary);
  });

  it("5xx nie robi retry i zwraca stan ambiguous bez surowej odpowiedzi", async () => {
    upstreamStatus = 503;
    const before = upstreamHits;
    const result = await postBridge(REQUEST);
    upstreamStatus = 200;

    expect(upstreamHits).toBe(before + 1);
    expect(result).toEqual({
      status: 502,
      body: { ok: false, error: "upstream_server_error", ambiguous: true },
    });
    expect(JSON.stringify(result)).not.toContain("sekret TeaBrew");
  });
});
