#!/usr/bin/env tsx
import { createInterface } from "node:readline";
import { createApp } from "../index.js";
import { toMcpToolList } from "../capability/projections.js";
import { MemoryAuditSink, newCorrelationId } from "../capability/audit.js";
import { AGENT_SCOPES } from "../index.js";
import { AGENT_ID } from "../agent/prompt.js";
import type { CapabilityContext } from "../capability/types.js";

/**
 * Adapter MCP (stdio). CELOWO jest to adapter, nie fundament:
 *
 *  - nie ma tu ani jednej definicji capability — wszystkie pochodzą z rejestru,
 *  - nic w systemie nie zależy od tego pliku; skasowanie go nie psuje agenta,
 *  - nie dodaje żadnej zależności (protokół to JSON-RPC po stdin/stdout).
 *
 * Istnieje z jednego praktycznego powodu: pozwala podłączyć te same siedem
 * funkcji jako narzędzia w Claude Desktop bez pisania drugiej integracji.
 * To jedyne uzasadnienie MCP na tym etapie.
 *
 * Konfiguracja w kliencie MCP:
 *   { "command": "npx", "args": ["tsx", "src/bin/mcp.ts"], "cwd": "<ścieżka>/ai-operator" }
 */

const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const app = createApp();
const audit = new MemoryAuditSink(app.config.auditFile);

function send(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...payload }) + "\n");
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const { id, method } = req;

  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "inbox-operator", version: "0.1.0" },
      },
    });
    return;
  }

  // Powiadomienia (bez id) nie dostają odpowiedzi.
  if (id === undefined || id === null) return;

  if (method === "tools/list") {
    send({ id, result: { tools: toMcpToolList(app.registry.listForScopes(AGENT_SCOPES)) } });
    return;
  }

  if (method === "tools/call") {
    const name = String(req.params?.["name"] ?? "");
    const args = (req.params?.["arguments"] as unknown) ?? {};
    const ctx: CapabilityContext = {
      agent: `${AGENT_ID}/mcp`,
      correlationId: newCorrelationId(),
      scopes: AGENT_SCOPES,
      audit,
    };
    try {
      const out = await app.registry.invoke(name, args, ctx);
      send({
        id,
        result: { content: [{ type: "text", text: JSON.stringify(out) }], isError: false },
      });
    } catch (err) {
      send({
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Wywołanie się NIE udało: ${err instanceof Error ? err.message : String(err)}. Nie zakładaj żadnego wyniku.`,
            },
          ],
          isError: true,
        },
      });
    }
    return;
  }

  send({ id, error: { code: -32601, message: `nieobsługiwana metoda: ${method}` } });
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
  handle(req).catch((err) => {
    send({
      id: req.id ?? null,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    });
  });
});
rl.on("close", () => {
  void app.close().finally(() => process.exit(0));
});
