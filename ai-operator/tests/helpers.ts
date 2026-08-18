import type Anthropic from "@anthropic-ai/sdk";
import { CapabilityRegistry } from "../src/capability/registry.js";
import type { AnyCapability, Scope } from "../src/capability/types.js";
import { createMailCapabilities } from "../src/mail/capabilities.js";
import { FixtureMailProvider } from "../src/mail/fixture.js";
import { createTeabrewCapabilities } from "../src/teabrew/capabilities.js";
import { FixtureTeabrewReader } from "../src/teabrew/client.js";
import { InboxOperator } from "../src/agent/operator.js";
import { MailTriage } from "../src/agent/triage.js";
import type { ModelLayer, ModelRole, RoleProfile } from "../src/model/roles.js";

export const SCOPES: readonly Scope[] = ["mail:read", "erp:read"];

export const MAIL_FIXTURE = new URL("../fixtures/mail/inbox.json", import.meta.url).pathname;
export const ERP_FIXTURE = new URL("../fixtures/teabrew/erp.json", import.meta.url).pathname;

export function buildRegistry(): CapabilityRegistry {
  const mail = new FixtureMailProvider({ filePath: MAIL_FIXTURE });
  const erp = new FixtureTeabrewReader({ filePath: ERP_FIXTURE });
  const caps: AnyCapability[] = [
    ...createMailCapabilities(async () => mail),
    ...createTeabrewCapabilities(async () => erp),
  ];
  return new CapabilityRegistry().registerAll(caps);
}

/**
 * Jeden zaplanowany krok modelu: albo wywołania narzędzi, albo tekst końcowy.
 * Testy scenariuszy sterują modelem, żeby sprawdzać zachowanie systemu
 * (audyt, dowody, kolejność wywołań), a nie zgadywać, co model wymyśli.
 */
export type ScriptedStep =
  | { readonly tools: readonly { name: string; input: unknown }[] }
  | { readonly text: string };

export interface ScriptedModel {
  readonly layer: ModelLayer;
  /** Treści `tool_result`, które model faktycznie dostał — w kolejności. */
  readonly observed: { name: string; result: string; isError: boolean }[];
  readonly requests: Anthropic.MessageCreateParams[];
}

/**
 * Model-atrapa. Odgrywa zaplanowane kroki i zapisuje, co dostał z narzędzi.
 * Nie wykonuje żadnego zapytania sieciowego, więc testy działają bez klucza API.
 */
export function scriptedModel(
  steps: readonly ScriptedStep[],
  opts: { completeWith?: string } = {},
): ScriptedModel {
  const observed: ScriptedModel["observed"] = [];
  const requests: Anthropic.MessageCreateParams[] = [];
  let step = 0;
  // tool_use_id -> nazwa narzędzia, żeby dopasować wynik do wywołania.
  const pending = new Map<string, string>();

  const create = async (body: Anthropic.MessageCreateParams): Promise<Anthropic.Message> => {
    requests.push(body);

    // Zbierz wyniki narzędzi z ostatniej wiadomości użytkownika.
    const last = body.messages[body.messages.length - 1];
    if (last && last.role === "user" && Array.isArray(last.content)) {
      for (const block of last.content) {
        if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
          const tr = block as Anthropic.ToolResultBlockParam;
          observed.push({
            name: pending.get(tr.tool_use_id) ?? "?",
            result: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
            isError: tr.is_error === true,
          });
        }
      }
    }

    const current = steps[step];
    step += 1;

    if (!current || "text" in current) {
      const text = current && "text" in current ? current.text : "";
      return message([{ type: "text", text, citations: null }], "end_turn");
    }

    const blocks = current.tools.map((t, i) => {
      const id = `toolu_${step}_${i}`;
      pending.set(id, t.name);
      return {
        type: "tool_use" as const,
        id,
        name: t.name,
        input: t.input,
        caller: { type: "direct" as const },
      };
    });
    return message(blocks, "tool_use");
  };

  const layer = {
    raw: () => ({ messages: { create } }) as unknown as Anthropic,
    profile: (role: ModelRole): RoleProfile =>
      role === "reason"
        ? { model: "test-reason", maxTokens: 1024, thinking: { type: "adaptive" } }
        : { model: role === "chat" ? "test-chat" : "test-classify", maxTokens: 512 },
    complete: async () => opts.completeWith ?? "[]",
  } as unknown as ModelLayer;

  return { layer, observed, requests };
}

function message(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.Message["stop_reason"],
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-reason",
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

export function buildOperator(steps: readonly ScriptedStep[]): {
  operator: InboxOperator;
  model: ScriptedModel;
  registry: CapabilityRegistry;
} {
  const registry = buildRegistry();
  const model = scriptedModel(steps);
  return {
    registry,
    model,
    operator: new InboxOperator({ registry, models: model.layer, scopes: SCOPES }),
  };
}

export function buildTriage(classification: unknown): {
  triage: MailTriage;
  registry: CapabilityRegistry;
} {
  const registry = buildRegistry();
  const model = scriptedModel([], { completeWith: JSON.stringify(classification) });
  return { registry, triage: new MailTriage({ registry, models: model.layer, scopes: SCOPES }) };
}
