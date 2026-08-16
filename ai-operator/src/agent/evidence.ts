import type { AuditRecord } from "../capability/types.js";

/**
 * Wymuszenie zasady „agent nie może twierdzić, że coś sprawdził, jeśli tego
 * nie sprawdził" — konstrukcyjnie, nie przez prośbę w promptcie.
 *
 * Mechanizm ma trzy części i wszystkie trzy są tutaj:
 *
 *  1. STOPKA DOWODOWA jest generowana z logu audytu, nie przez model.
 *     Model fizycznie nie ma jak dopisać do niej wywołania, którego nie było.
 *
 *  2. KONTROLA PO FAKCIE. Odpowiedź jest skanowana w poszukiwaniu twierdzeń
 *     o danych operacyjnych (numery zamówień, kody, stany, „sprawdziłem w
 *     TeaBrew"). Każde takie twierdzenie musi mieć odpowiadające mu udane
 *     wywołanie capability.
 *
 *  3. OSTRZEŻENIE JEST WIDOCZNE. Jeśli kontrola coś wyłapie, człowiek to widzi
 *     w odpowiedzi. Cicha korekta byłaby gorsza od problemu.
 */

export interface EvidenceItem {
  readonly capability: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail: string;
}

export type FabricationCode =
  | "claim_without_any_erp_call"
  | "order_ref_never_checked"
  | "stock_claim_without_stock_call"
  | "mail_claim_without_mail_call";

export interface FabricationFinding {
  readonly code: FabricationCode;
  readonly message: string;
  readonly evidenceGap: string;
}

/** Zbudowana wyłącznie z audytu. Nie przyjmuje żadnego wejścia od modelu. */
export function buildEvidence(records: readonly AuditRecord[]): EvidenceItem[] {
  return records.map((r) => ({
    capability: r.capability,
    ok: r.ok,
    latencyMs: r.latencyMs,
    detail: r.ok
      ? formatRefs(r.refs)
      : `NIE UDAŁO SIĘ (${r.error ?? "nieznany błąd"})`,
  }));
}

function formatRefs(refs: AuditRecord["refs"]): string {
  if (!refs) return "";
  return Object.entries(refs)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

export function renderEvidenceFooter(items: readonly EvidenceItem[]): string {
  if (items.length === 0) {
    return [
      "---",
      "Co sprawdziłem: **nic**. Nie wywołałem żadnej funkcji, więc powyższa",
      "odpowiedź nie opiera się na danych z poczty ani z TeaBrew.",
    ].join("\n");
  }
  const lines = items.map((it, i) => {
    const mark = it.ok ? "✓" : "✗";
    const detail = it.detail ? ` — ${it.detail}` : "";
    return `${i + 1}. ${mark} \`${it.capability}\`${detail} (${it.latencyMs} ms)`;
  });
  return ["---", "**Co sprawdziłem, zanim odpowiedziałem:**", ...lines].join("\n");
}

// Numer zamówienia / partii: co najmniej 4 cyfry pod rząd, ewentualnie
// z prefiksem literowym i separatorem (ZK/2026/123, ZP-4412, 12345).
const REF_TOKEN = /\b(?:[A-Z]{1,4}[/-])?\d{4,}(?:[/-]\d+)*\b/g;

const ERP_CLAIM_PHRASES: readonly RegExp[] = [
  /sprawdzi[łl]em\s+w\s+(teabrew|systemie|erp)/i,
  /w\s+(teabrew|systemie)\s+(jest|widać|mamy|figuruje|znajduje)/i,
  /wed[łl]ug\s+(teabrew|systemu)/i,
  /z\s+danych\s+w\s+(teabrew|systemie)/i,
];

const STOCK_CLAIM_PHRASES: readonly RegExp[] = [
  /stan\s+magazynow\w*\s+(wynosi|to|jest)/i,
  /(mamy|jest)\s+na\s+(stanie|magazynie)/i,
  /dost[ęe]pn\w*\s+(ilo[śs][ćc]|szt|kg)/i,
  /\bzosta[łl]o\s+\d+\s*(szt|kg)\b/i,
];

const MAIL_CLAIM_PHRASES: readonly RegExp[] = [
  /w\s+(mailu|wiadomo[śs]ci|korespondencji)\s+(pisze|jest|klient)/i,
  /przysz[łl][ao]\s+\d+\s+(maili|wiadomo[śs]ci)/i,
  /klient\s+(pisze|napisa[łl]|pyta)/i,
];

/**
 * Kontrola po fakcie. Nie ocenia, czy odpowiedź jest mądra — sprawdza tylko,
 * czy każde twierdzenie o danych ma pokrycie w faktycznym wywołaniu.
 */
export function checkForFabrication(
  answer: string,
  records: readonly AuditRecord[],
): FabricationFinding[] {
  const findings: FabricationFinding[] = [];
  const okRecords = records.filter((r) => r.ok);

  const erpCalls = okRecords.filter((r) => r.capability.startsWith("teabrew_"));
  const mailCalls = okRecords.filter((r) => r.capability.startsWith("mail_"));
  const stockCalls = okRecords.filter((r) => r.capability === "teabrew_get_stock");

  const claimsErp = ERP_CLAIM_PHRASES.some((re) => re.test(answer));
  if (claimsErp && erpCalls.length === 0) {
    findings.push({
      code: "claim_without_any_erp_call",
      message:
        "Odpowiedź twierdzi, że dane pochodzą z TeaBrew, ale nie wykonano żadnego udanego wywołania TeaBrew.",
      evidenceGap: "0 udanych wywołań teabrew_*",
    });
  }

  if (STOCK_CLAIM_PHRASES.some((re) => re.test(answer)) && stockCalls.length === 0) {
    findings.push({
      code: "stock_claim_without_stock_call",
      message:
        "Odpowiedź podaje stan magazynowy, ale nie wywołano teabrew_get_stock.",
      evidenceGap: "0 udanych wywołań teabrew_get_stock",
    });
  }

  if (MAIL_CLAIM_PHRASES.some((re) => re.test(answer)) && mailCalls.length === 0) {
    findings.push({
      code: "mail_claim_without_mail_call",
      message:
        "Odpowiedź powołuje się na treść poczty, ale nie wykonano żadnego udanego wywołania mail_*.",
      evidenceGap: "0 udanych wywołań mail_*",
    });
  }

  // Każdy numer wymieniony w odpowiedzi musi był kiedyś przedmiotem zapytania.
  const looked = lookedUpTokens(records);
  const mentioned = new Set(referencedIdentifiers(answer));
  for (const token of mentioned) {
    if (!looked.has(token.toLowerCase())) {
      findings.push({
        code: "order_ref_never_checked",
        message: `Odpowiedź wymienia numer „${token}", którego agent nigdy nie sprawdził ani w poczcie, ani w TeaBrew.`,
        evidenceGap: `brak wywołania z ref/query = ${token}`,
      });
    }
  }

  return findings;
}

/**
 * Wszystkie identyfikatory, o które agent faktycznie zapytał — zarówno w
 * zapytaniu (`ref`, `query`, `codes`), jak i to, co wróciło jako numer.
 */
function lookedUpTokens(records: readonly AuditRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (!r.refs) continue;
    for (const key of ["ref", "query", "codes", "status"]) {
      const v = r.refs[key];
      if (typeof v !== "string") continue;
      for (const part of v.split(",")) {
        const t = part.trim().toLowerCase();
        if (t) out.add(t);
        // Numer podany w zapytaniu razem z prefiksem powinien pokrywać też
        // sam numer w odpowiedzi ("zamówienie 12345" vs "ZK/12345").
        for (const m of part.match(REF_TOKEN) ?? []) out.add(m.toLowerCase());
      }
    }
  }
  return out;
}

/** Słowa, po których następująca liczba jest identyfikatorem, a nie ilością. */
const REF_CONTEXT = /(zam[óo]wieni\w*|zlecen\w*|numer\w*|\bnr\b|partia|partii|batch|ZK|ZP|WZ|FV)[\s:.,-]*$/i;

/**
 * Wyciąga z odpowiedzi te liczby, które faktycznie są POWOŁANIEM SIĘ na
 * konkretny rekord — numer zamówienia, zlecenia, partii.
 *
 * Kontekst zamiast czarnej listy jednostek. Poprzednia wersja odsiewała „1200 kg",
 * ale zgłaszałaby „1200 opakowań" jako zmyślony numer zamówienia. Ostrzeżenie,
 * które krzyczy na każdą liczbę, zostanie zignorowane — a wtedy nie chroni
 * przed niczym. Identyfikator z prefiksem literowym (ZP-2026-0412) liczy się
 * zawsze, bo nie da się go pomylić z ilością.
 */
function referencedIdentifiers(answer: string): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(REF_TOKEN)) {
    const token = m[0];
    if (/^(19|20)\d{2}$/.test(token)) continue; // rok
    const hasLetterPrefix = /^[A-Za-z]/.test(token);
    if (hasLetterPrefix) {
      out.push(token);
      continue;
    }
    const before = answer.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0);
    if (REF_CONTEXT.test(before)) out.push(token);
  }
  return out;
}

export function renderFabricationWarning(findings: readonly FabricationFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map((f) => `- ${f.message} (luka: ${f.evidenceGap})`);
  return [
    "",
    "> ⚠️ **KONTROLA DOWODÓW ZGŁOSIŁA PROBLEM.** Poniższych twierdzeń nie potwierdza",
    "> log wywołań. Traktuj je jako niepotwierdzone, dopóki nie sprawdzisz ręcznie.",
    ...lines.map((l) => `> ${l}`),
  ].join("\n");
}
