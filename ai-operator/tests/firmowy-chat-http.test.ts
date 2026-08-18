import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const operatorDir = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const httpEntry = fileURLToPath(new URL("../src/bin/mcp-http.ts", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("../fixtures/contracts/firmowy-chat-message-created-v1.json", import.meta.url),
);
const PORT = 8861;
const BASE = `http://127.0.0.1:${PORT}`;
const EVENT_SECRET = "e".repeat(48);
let server: ChildProcess;

beforeAll(async () => {
  server = spawn(process.execPath, [tsxCli, httpEntry], {
    cwd: operatorDir,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      MODE: "fixture",
      MONITOR_IN_PROCESS: "0",
      COPILOT_STATE_DIR: mkdtempSync(join(tmpdir(), "bht-chat-http-")),
      PORT: String(PORT),
      MCP_BEARER_TOKEN: "m".repeat(48),
      FIRMOWY_CHAT_EVENTS_SECRET: EVENT_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // Proces jeszcze startuje.
    }
    if (Date.now() > deadline) throw new Error("serwer HTTP nie wstał w 25 s");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}, 30_000);

afterAll(() => {
  server?.kill();
});

async function send(raw: string, signed: boolean) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", EVENT_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  const event = JSON.parse(raw) as { eventId: string };
  const response = await fetch(`${BASE}/events/chat`, {
    method: "POST",
    headers: signed
      ? {
          "content-type": "application/json",
          "x-bht-event-id": event.eventId,
          "x-bht-timestamp": timestamp,
          "x-bht-signature": `sha256=${signature}`,
        }
      : { "content-type": "application/json" },
    body: raw,
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("HTTP Czat Firmowy -> BHT Copilot", () => {
  it("health pokazuje gotowość wejścia zdarzeń", async () => {
    const response = await fetch(`${BASE}/health`);
    expect(await response.json()).toMatchObject({ firmowyChatEvents: true });
  });

  it("odrzuca brak podpisu", async () => {
    const raw = readFileSync(fixturePath, "utf8");
    expect(await send(raw, false)).toMatchObject({ status: 401 });
  });

  it("zapisuje sprawę i przy retry zwraca to samo issueId", async () => {
    const raw = readFileSync(fixturePath, "utf8");
    const first = await send(raw, true);
    expect(first).toMatchObject({
      status: 200,
      body: { accepted: true, outcome: "created" },
    });
    expect(typeof first.body.issueId).toBe("string");

    const repeated = await send(raw, true);
    expect(repeated).toMatchObject({
      status: 200,
      body: {
        accepted: true,
        outcome: "duplicate",
        issueId: first.body.issueId,
      },
    });
  });
});
