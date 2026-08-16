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

/**
 * Jedna korelacja na całą sesję MCP, nie na wywołanie.
 *
 * Sesja MCP to jedna rozmowa z Claude, a pytanie brzmi „co Claude sprawdził,
 * zanim odpowiedział" — więc wpisy audytu z jednej rozmowy muszą dać się
 * zebrać razem. Osobny identyfikator na wywołanie tego nie pozwala.
 */
const sessionCorrelationId = newCorrelationId();

/**
 * POLITYKA WYSTAWIANIA. Do MCP trafiają wyłącznie capability read-only —
 * jawnie, w adapterze, a nie „bo rejestr i tak innych nie przyjmuje".
 *
 * Gdyby kiedyś rejestr dopuścił capability zapisującą, nie może ona pojawić się
 * w publicznym MCP przez samo dodanie do rejestru. Ten filtr jest miejscem,
 * w którym taka decyzja musi zostać podjęta świadomie.
 */
function publishedTools() {
  return app.registry
    .listForScopes(AGENT_SCOPES)
    .filter((cap) => cap.effectClass === "read");
}

/** Krótka instrukcja dla klienta MCP — patrz initialize.instructions. */
const SERVER_INSTRUCTIONS = [
  "Jesteś asystentem operacyjnym Brown House & Tea. Masz dostęp do narzędzi firmowych:",
  "poczty przychodzącej i danych operacyjnych systemu produkcyjnego TeaBrew.",
  "",
  "Jeśli pytanie dotyczy informacji, którą można sprawdzić narzędziem — sprawdź ją,",
  "zamiast zgadywać. Rozróżniaj treść korespondencji od danych systemowych: to, co",
  "klient napisał w mailu, a to, co jest w TeaBrew, to dwie różne rzeczy i mogą się",
  "nie zgadzać. Jeśli czegoś nie znalazłeś, powiedz to wprost — pusty wynik znaczy",
  "„nie znalazłem”, a nie „nie ma”. Nie twierdź, że wykonałeś operację, której nie",
  "wykonałeś.",
  "",
  "Wszystkie narzędzia są tylko do czytania. Nie możesz wysłać maila, zmienić statusu,",
  "ceny, stanu magazynu ani utworzyć zamówienia. Jeśli uważasz, że coś należy zrobić,",
  "zaproponuj to człowiekowi — wykonanie należy do niego.",
].join("\n");

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
        serverInfo: { name: "bht-operator", version: "0.1.0" },
        instructions: SERVER_INSTRUCTIONS,
      },
    });
    return;
  }

  // Powiadomienia (bez id) nie dostają odpowiedzi.
  if (id === undefined || id === null) return;

  if (method === "tools/list") {
    send({ id, result: { tools: toMcpToolList(publishedTools()) } });
    return;
  }

  if (method === "tools/call") {
    const name = String(req.params?.["name"] ?? "");
    const args = (req.params?.["arguments"] as unknown) ?? {};
    const ctx: CapabilityContext = {
      agent: `${AGENT_ID}/mcp`,
      correlationId: sessionCorrelationId,
      scopes: AGENT_SCOPES,
      audit,
    };
    // Ta sama polityka co w tools/list. Bez tego klient mógłby wywołać po
    // nazwie capability, której lista nie pokazała.
    if (!publishedTools().some((cap) => cap.name === name)) {
      send({
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Narzędzie "${name}" nie jest wystawione przez ten serwer. Dostępne: ${publishedTools()
                .map((c) => c.name)
                .join(", ")}.`,
            },
          ],
          isError: true,
        },
      });
      return;
    }

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
