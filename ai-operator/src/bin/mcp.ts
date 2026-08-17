#!/usr/bin/env tsx
import { createInterface } from "node:readline";
import { createMcpCore, type JsonRpcRequest } from "../mcp/core.js";

/**
 * Adapter MCP przez stdio — do Claude Desktop i Claude Code na tej maszynie.
 *
 * CELOWO cienki: cała obsługa protokołu jest w `src/mcp/core.ts`, wspólna
 * z transportem HTTP. Ten plik odpowiada wyłącznie za czytanie linii ze stdin
 * i pisanie linii na stdout — nie zna capability, nie zna poczty, nie zna ERP.
 *
 * Konfiguracja klienta: `npm run mcp:install` (Claude Desktop) albo `.mcp.json`.
 */

const core = createMcpCore();

function send(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let req: JsonRpcRequest;
  try {
    req = JSON.parse(text) as JsonRpcRequest;
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  core
    .handle(req)
    .then((res) => {
      if (res) send(res);
    })
    .catch((err) => {
      send({
        id: req.id ?? null,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    });
});

rl.on("close", () => {
  const failed = core.startupError() !== null;
  void core.close().finally(() => process.exit(failed ? 1 : 0));
});
