import { z } from "zod";
import type { AuditRecord, CapabilityContext, Scope } from "../capability/types.js";
import type { CapabilityRegistry } from "../capability/registry.js";
import { MemoryAuditSink, newCorrelationId } from "../capability/audit.js";
import type { ModelLayer } from "../model/roles.js";
import { AGENT_ID, TRIAGE_CATEGORIES, TRIAGE_SYSTEM_PROMPT, type TriageCategory } from "./prompt.js";
import { buildEvidence, renderEvidenceFooter, type EvidenceItem } from "./evidence.js";
import { MailMessage } from "../mail/types.js";

/**
 * Widok przeglądowy poczty. To jest ta jedna komenda, która odpowiada na trzy
 * pytania właściciela naraz: co ważnego przyszło, co wymaga odpowiedzi i czy
 * ktoś czeka na pilną decyzję.
 *
 * Klasyfikacja idzie modelem szybkim (rola "fast") — jest tania i wykonuje się
 * raz na całą paczkę. Dociąganie danych z TeaBrew dotyczy tylko tych wiadomości,
 * w których model wskazał konkretny numer. Nie odpytujemy ERP „na wszelki wypadek".
 */

const TriageRow = z.object({
  id: z.string(),
  kategoria: z.enum(TRIAGE_CATEGORIES),
  uzasadnienie: z.string().default(""),
  konkrety: z.array(z.string()).default([]),
  czyWymagaOdpowiedzi: z.boolean().default(false),
});

const TriageRows = z.array(TriageRow);

export interface TriageItem {
  readonly category: TriageCategory;
  readonly message: z.infer<typeof MailMessage>;
  readonly reason: string;
  readonly needsReply: boolean;
  readonly refs: readonly string[];
  /** Co TeaBrew powiedział o numerach z tej wiadomości. Puste = nie pytaliśmy. */
  readonly erp: readonly ErpLookup[];
}

export interface ErpLookup {
  readonly ref: string;
  readonly found: boolean;
  readonly summary: string;
}

export interface TriageResult {
  readonly sinceDays: number;
  readonly total: number;
  readonly items: readonly TriageItem[];
  readonly unclassified: readonly z.infer<typeof MailMessage>[];
  readonly evidence: readonly EvidenceItem[];
  readonly audit: readonly AuditRecord[];
  readonly correlationId: string;
}

export interface TriageOptions {
  readonly registry: CapabilityRegistry;
  readonly models: ModelLayer;
  readonly scopes: readonly Scope[];
  readonly auditFile?: string | undefined;
}

/** Numer, który warto sprawdzić w ERP: co najmniej 4 cyfry, ewentualnie z prefiksem. */
const CHECKABLE_REF = /^(?:[A-Za-z]{1,4}[/-])?\d{4,}(?:[/-]\d+)*$/;

export class MailTriage {
  constructor(private readonly opts: TriageOptions) {}

  async run(args: {
    sinceDays: number;
    limit: number;
    unreadOnly?: boolean;
    /** Ile pilnych spraw dociągnąć z TeaBrew. Chroni przed lawiną wywołań. */
    maxErpLookups?: number;
    signal?: AbortSignal;
  }): Promise<TriageResult> {
    const audit = new MemoryAuditSink(this.opts.auditFile);
    const correlationId = newCorrelationId();
    const ctx: CapabilityContext = {
      agent: AGENT_ID,
      correlationId,
      scopes: this.opts.scopes,
      audit,
      ...(args.signal ? { signal: args.signal } : {}),
    };

    const listed = (await this.opts.registry.invoke(
      "mail_list_recent",
      {
        sinceDays: args.sinceDays,
        limit: args.limit,
        unreadOnly: args.unreadOnly ?? false,
      },
      ctx,
    )) as { messages: z.infer<typeof MailMessage>[] };

    const messages = listed.messages;
    if (messages.length === 0) {
      return {
        sinceDays: args.sinceDays,
        total: 0,
        items: [],
        unclassified: [],
        evidence: buildEvidence(audit.records()),
        audit: audit.records(),
        correlationId,
      };
    }

    const rows = await this.classify(messages, args.signal);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const items: TriageItem[] = [];
    const unclassified: z.infer<typeof MailMessage>[] = [];
    let lookupsLeft = args.maxErpLookups ?? 6;

    for (const msg of messages) {
      const row = byId.get(msg.id);
      if (!row) {
        // Model pominął wiadomość albo zmyślił id. Nie przypisujemy kategorii
        // za niego — pokazujemy ją osobno jako nieklasyfikowaną.
        unclassified.push(msg);
        continue;
      }

      const refs = row.konkrety.filter((r) => CHECKABLE_REF.test(r.trim()));
      const erp: ErpLookup[] = [];
      const worthChecking =
        row.kategoria === "Pilne" || row.kategoria === "Wymaga decyzji";

      if (worthChecking) {
        for (const ref of refs) {
          if (lookupsLeft <= 0) break;
          lookupsLeft -= 1;
          erp.push(await this.lookupOrder(ref, ctx));
        }
      }

      items.push({
        category: row.kategoria,
        message: msg,
        reason: row.uzasadnienie,
        needsReply: row.czyWymagaOdpowiedzi,
        refs,
        erp,
      });
    }

    items.sort(
      (a, b) =>
        TRIAGE_CATEGORIES.indexOf(a.category) - TRIAGE_CATEGORIES.indexOf(b.category) ||
        b.message.date.localeCompare(a.message.date),
    );

    return {
      sinceDays: args.sinceDays,
      total: messages.length,
      items,
      unclassified,
      evidence: buildEvidence(audit.records()),
      audit: audit.records(),
      correlationId,
    };
  }

  private async classify(
    messages: readonly z.infer<typeof MailMessage>[],
    signal?: AbortSignal,
  ): Promise<z.infer<typeof TriageRows>> {
    // Model klasyfikujący dostaje wyłącznie podgląd, nie pełne treści.
    const payload = messages.map((m) => ({
      id: m.id,
      od: m.from ? `${m.from.name ?? ""} <${m.from.address}>`.trim() : "(nieznany)",
      data: m.date,
      temat: m.subject,
      przeczytana: m.seen,
      odpowiedziano: m.answered,
      zalaczniki: m.attachments.map((a) => a.filename).filter(Boolean),
      podglad: m.snippet,
    }));

    const raw = await this.opts.models.complete({
      role: "fast",
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: `Zaklasyfikuj ${messages.length} wiadomości:\n\n${JSON.stringify(payload, null, 1)}`,
      ...(signal ? { signal } : {}),
    });

    const parsed = TriageRows.safeParse(extractJsonArray(raw));
    if (!parsed.success) {
      // Nieparsowalna klasyfikacja nie może udawać, że się udała.
      // Wszystkie wiadomości pójdą do „nieklasyfikowane" i właściciel to zobaczy.
      return [];
    }
    return parsed.data;
  }

  private async lookupOrder(ref: string, ctx: CapabilityContext): Promise<ErpLookup> {
    try {
      const res = (await this.opts.registry.invoke(
        "teabrew_get_order_status",
        { ref, limit: 3 },
        ctx,
      )) as {
        matchedBy: string;
        count: number;
        orders: {
          fulfillmentStatus: string;
          paymentStatus: string | null;
          deadline: number | null;
          customerName: string | null;
        }[];
      };

      if (res.matchedBy === "none" || res.count === 0) {
        return { ref, found: false, summary: "nie znaleziono w TeaBrew" };
      }
      const o = res.orders[0]!;
      const deadline = o.deadline ? new Date(o.deadline).toISOString().slice(0, 10) : "brak terminu";
      return {
        ref,
        found: true,
        summary: `${o.fulfillmentStatus}, płatność: ${o.paymentStatus ?? "?"}, termin: ${deadline}${
          res.count > 1 ? ` (+${res.count - 1} inne dopasowania)` : ""
        }`,
      };
    } catch (err) {
      return {
        ref,
        found: false,
        summary: `nie udało się sprawdzić (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }
}

/** Model potrafi otoczyć JSON blokiem kodu albo zdaniem. Wyciągamy tablicę. */
function extractJsonArray(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function renderTriage(result: TriageResult): string {
  const out: string[] = [];
  out.push(
    `# Poczta — ostatnie ${result.sinceDays === 1 ? "24 godziny" : `${result.sinceDays} dni`}`,
    "",
    `Wiadomości: ${result.total}`,
    "",
  );

  for (const category of TRIAGE_CATEGORIES) {
    const inCat = result.items.filter((i) => i.category === category);
    if (inCat.length === 0) continue;
    out.push(`## ${category} (${inCat.length})`, "");
    for (const item of inCat) {
      const from = item.message.from
        ? item.message.from.name || item.message.from.address
        : "(nieznany nadawca)";
      const when = item.message.date.slice(0, 16).replace("T", " ");
      out.push(`- **${item.message.subject}** — ${from}, ${when}`);
      if (item.reason) out.push(`  - ${item.reason}`);
      if (item.needsReply) out.push("  - wymaga odpowiedzi");
      for (const e of item.erp) {
        out.push(`  - TeaBrew ${e.ref}: ${e.found ? e.summary : `**${e.summary}**`}`);
      }
      const unchecked = item.refs.filter((r) => !item.erp.some((e) => e.ref === r));
      if (unchecked.length > 0) {
        out.push(`  - numery niesprawdzone w TeaBrew: ${unchecked.join(", ")}`);
      }
    }
    out.push("");
  }

  if (result.unclassified.length > 0) {
    out.push(
      `## Nieklasyfikowane (${result.unclassified.length})`,
      "",
      "Klasyfikacja nie objęła tych wiadomości — nie przypisuję im kategorii na siłę:",
      "",
    );
    for (const m of result.unclassified) {
      out.push(`- ${m.subject} — ${m.from?.address ?? "(nieznany)"}`);
    }
    out.push("");
  }

  out.push(renderEvidenceFooter(result.evidence));
  return out.join("\n");
}
