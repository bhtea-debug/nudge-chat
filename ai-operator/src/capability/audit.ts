import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditRecord, AuditSink } from "./types.js";

/**
 * Audyt trzymamy w pamięci (bo z niego budujemy stopkę dowodową odpowiedzi)
 * i opcjonalnie dopisujemy do pliku JSONL.
 *
 * Zasada: w audycie nie ma treści maili. Tylko identyfikatory i liczniki,
 * i tylko te, które capability sama zadeklarowała w auditRefs.
 */
export class MemoryAuditSink implements AuditSink {
  private readonly buf: AuditRecord[] = [];

  constructor(private readonly filePath?: string) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  write(record: AuditRecord): void {
    this.buf.push(record);
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
      } catch {
        // Audyt na dysk jest best-effort; utrata pliku nie może przewrócić odpowiedzi.
        // Kopia w pamięci i tak jest źródłem stopki dowodowej.
      }
    }
  }

  records(): readonly AuditRecord[] {
    return this.buf;
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}

/** Czytelna dla człowieka odpowiedź na pytanie: co agent naprawdę sprawdził. */
export function formatAuditTrail(records: readonly AuditRecord[]): string {
  if (records.length === 0) return "(brak wywołań capability)";
  return records
    .map((r, i) => {
      const refs = r.refs
        ? " " +
          Object.entries(r.refs)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
        : "";
      const status = r.ok ? "ok" : `ERROR:${r.error ?? "unknown"}`;
      return `${i + 1}. ${r.capability}@${r.capabilityVersion} ${status} ${r.latencyMs}ms${refs}`;
    })
    .join("\n");
}
