import type Anthropic from "@anthropic-ai/sdk";
import { CapabilityError, type AuditRecord, type CapabilityContext, type Scope } from "../capability/types.js";
import type { CapabilityRegistry } from "../capability/registry.js";
import { toToolDefinitions } from "../capability/projections.js";
import { MemoryAuditSink, newCorrelationId } from "../capability/audit.js";
import type { ModelLayer } from "../model/roles.js";
import { AGENT_ID, SYSTEM_PROMPT } from "./prompt.js";
import {
  buildEvidence,
  checkForFabrication,
  renderEvidenceFooter,
  renderFabricationWarning,
  type EvidenceItem,
  type FabricationFinding,
} from "./evidence.js";

export interface AskResult {
  readonly answer: string;
  /** Odpowiedź z doklejoną stopką dowodową i ewentualnym ostrzeżeniem. */
  readonly answerWithEvidence: string;
  readonly evidence: readonly EvidenceItem[];
  readonly findings: readonly FabricationFinding[];
  readonly audit: readonly AuditRecord[];
  readonly correlationId: string;
  readonly turns: number;
}

export interface OperatorOptions {
  readonly registry: CapabilityRegistry;
  readonly models: ModelLayer;
  readonly scopes: readonly Scope[];
  readonly auditFile?: string | undefined;
  readonly maxTurns?: number;
}

/**
 * Agent inbox-operator.
 *
 * Pętla jest napisana ręcznie, a nie oddana bibliotece, z jednego powodu:
 * to w niej powstaje log dowodowy. Każde narzędzie przechodzi przez
 * registry.invoke, więc nie istnieje ścieżka, w której model dostaje dane,
 * a audyt o tym nie wie. Na tym opiera się cała reszta.
 */
export class InboxOperator {
  private readonly maxTurns: number;

  constructor(private readonly opts: OperatorOptions) {
    this.maxTurns = opts.maxTurns ?? 12;
  }

  async ask(question: string, signal?: AbortSignal): Promise<AskResult> {
    const audit = new MemoryAuditSink(this.opts.auditFile);
    const correlationId = newCorrelationId();
    const ctx: CapabilityContext = {
      agent: AGENT_ID,
      correlationId,
      scopes: this.opts.scopes,
      audit,
      ...(signal ? { signal } : {}),
    };

    const available = this.opts.registry.listForScopes(this.opts.scopes);
    const tools = toToolDefinitions(available) as Anthropic.Tool[];
    const profile = this.opts.models.profile("reason");
    const client = this.opts.models.raw();

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: question },
    ];

    let turns = 0;
    let finalText = "";

    while (turns < this.maxTurns) {
      turns += 1;
      const res = await client.messages.create(
        {
          model: profile.model,
          max_tokens: profile.maxTokens,
          system: SYSTEM_PROMPT,
          tools,
          messages,
          ...(profile.thinking ? { thinking: profile.thinking } : {}),
        },
        signal ? { signal } : {},
      );

      messages.push({ role: "assistant", content: res.content });

      const toolUses = res.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        results.push(await this.runTool(use, ctx));
      }
      messages.push({ role: "user", content: results });
    }

    if (!finalText) {
      finalText =
        turns >= this.maxTurns
          ? `Przerwałem po ${this.maxTurns} krokach bez gotowej odpowiedzi. Poniżej to, co udało mi się faktycznie sprawdzić.`
          : "(model nie zwrócił treści)";
    }

    const records = audit.records();
    const evidence = buildEvidence(records);
    const findings = checkForFabrication(finalText, records);

    const answerWithEvidence = [
      finalText,
      renderFabricationWarning(findings),
      "",
      renderEvidenceFooter(evidence),
    ]
      .filter((p) => p !== "")
      .join("\n");

    return {
      answer: finalText,
      answerWithEvidence,
      evidence,
      findings,
      audit: records,
      correlationId,
      turns,
    };
  }

  /**
   * Wykonanie jednego narzędzia. Błąd capability nie przewraca rozmowy —
   * wraca do modelu jako uczciwy komunikat „nie udało się sprawdzić", żeby
   * agent mógł to napisać właścicielowi zamiast improwizować.
   */
  private async runTool(
    use: Anthropic.ToolUseBlock,
    ctx: CapabilityContext,
  ): Promise<Anthropic.ToolResultBlockParam> {
    try {
      const out = await this.opts.registry.invoke(use.name, use.input, ctx);
      return {
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(out),
      };
    } catch (err) {
      const code = err instanceof CapabilityError ? err.code : "upstream_error";
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "tool_result",
        tool_use_id: use.id,
        is_error: true,
        content: JSON.stringify({
          error: code,
          message,
          wskazowka:
            "To wywołanie się NIE udało. Nie zakładaj żadnego wyniku. " +
            "Jeśli nie możesz sprawdzić inaczej, napisz właścicielowi, czego nie udało się sprawdzić i dlaczego.",
        }),
      };
    }
  }
}
