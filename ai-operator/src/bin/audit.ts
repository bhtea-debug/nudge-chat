/**
 * Podgląd audytu: co agent NAPRAWDĘ sprawdził.
 *
 *   npm run audit                # ostatnie 5 sesji
 *   npm run audit -- --sesje 20  # więcej
 *   npm run audit -- --dzis      # tylko dzisiejsze
 *
 * Po co to istnieje: w trybie MCP modelem jest Claude po stronie klienta, więc
 * NIE działa nasza kontrola dowodów z `src/agent/evidence.ts` — ona sprawdza
 * odpowiedzi napisane przez `inbox-operator`, a nie odpowiedzi napisane w Claude
 * Desktop. W trybie MCP jedynym twardym zapisem tego, co zostało sprawdzone,
 * jest ten log. To on odpowiada na pytanie „czy on to naprawdę sprawdził, czy
 * tylko dobrze brzmi".
 *
 * Log nie zawiera treści maili, tematów, adresów ani tokenów — wyłącznie
 * identyfikatory i liczniki. Wypisywanie go jest bezpieczne.
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import type { AuditRecord } from "../capability/types.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);

const maxSessions = Number(flag("--sesje") ?? flag("--sessions") ?? 5);
const todayOnly = has("--dzis") || has("--today");

const auditFile = loadConfig().auditFile;
if (!auditFile) {
  console.error(
    "Brak AUDIT_FILE w konfiguracji — trwały log jest wyłączony.\n" +
      "Włącz go w .env:  AUDIT_FILE=./.audit/calls.jsonl\n" +
      "Bez niego po tygodniu nie odpowiesz na pytanie, czego agent naprawdę szukał.",
  );
  process.exit(1);
}

let raw: string;
try {
  raw = readFileSync(auditFile, "utf8");
} catch {
  console.error(
    `Nie ma jeszcze ${auditFile}.\n` +
      "Log powstaje przy pierwszym wywołaniu narzędzia. Zadaj Claude jedno pytanie o pocztę\n" +
      "albo o zamówienie i uruchom to ponownie.",
  );
  process.exit(1);
}

const lines = raw.split("\n").filter((l) => l.trim());
const records: AuditRecord[] = [];
let malformed = 0;
for (const line of lines) {
  try {
    records.push(JSON.parse(line) as AuditRecord);
  } catch {
    // Log dopisywany jest linia po linii; przerwany zapis to jedna zła linia,
    // nie powód, żeby nie pokazać pozostałych.
    malformed += 1;
  }
}

/** Jedna korelacja = jedna sesja MCP albo jedno uruchomienie agenta. */
const sessions = new Map<string, AuditRecord[]>();
for (const r of records) {
  const key = r.correlationId;
  const bucket = sessions.get(key);
  if (bucket) bucket.push(r);
  else sessions.set(key, [r]);
}

const day = (iso: string): string => iso.slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

let ordered = [...sessions.entries()]
  .map(([id, calls]) => ({
    id,
    calls: [...calls].sort((a, b) => a.ts.localeCompare(b.ts)),
  }))
  .sort((a, b) => (b.calls[0]?.ts ?? "").localeCompare(a.calls[0]?.ts ?? ""));

if (todayOnly) ordered = ordered.filter((s) => day(s.calls[0]?.ts ?? "") === today);

const shown = ordered.slice(0, Number.isFinite(maxSessions) ? maxSessions : 5);

const fmtTime = (iso: string): string => iso.slice(11, 19);
const fmtDate = (iso: string): string => {
  const [y, m, d] = day(iso).split("-");
  return `${d}.${m}.${y}`;
};
const fmtRefs = (refs: AuditRecord["refs"]): string =>
  refs
    ? Object.entries(refs)
        .map(([k, v]) => `${k}=${v === true ? "TAK" : v === false ? "nie" : v}`)
        .join(" ")
    : "";

console.log(
  `\nAudyt: ${auditFile}\n` +
    `${records.length} wywołań w ${sessions.size} sesjach` +
    (malformed > 0 ? `, ${malformed} linii nieczytelnych (pominięte)` : "") +
    (todayOnly ? " — filtr: dzisiaj" : ""),
);

if (shown.length === 0) {
  console.log(todayOnly ? "\nDzisiaj nie było żadnego wywołania.\n" : "\nLog jest pusty.\n");
  process.exit(0);
}

for (const s of shown) {
  const first = s.calls[0]!;
  const errors = s.calls.filter((c) => !c.ok);
  const truncated = s.calls.filter((c) => c.refs?.["truncated"] === true);
  const empty = s.calls.filter((c) => c.refs?.["count"] === 0);

  console.log(
    `\n── sesja ${s.id.slice(0, 8)}  ${fmtDate(first.ts)} ${fmtTime(first.ts)}  ` +
      `${first.agent}  (${s.calls.length} wywołań)`,
  );
  for (const c of s.calls) {
    const status = c.ok ? "ok   " : `BŁĄD:${c.error ?? "?"}`;
    console.log(
      `   ${fmtTime(c.ts)}  ${c.capability.padEnd(28)} ${status} ${String(c.latencyMs).padStart(6)}ms  ${fmtRefs(c.refs)}`,
    );
  }

  // Trzy rzeczy, które w odpowiedzi łatwo przeoczyć, a zmieniają jej wartość.
  if (truncated.length > 0) {
    console.log(
      `   ⚠ ${truncated.length} wynik(i) przycięte do limitu — odpowiedź mogła pomijać dane.`,
    );
  }
  if (empty.length > 0) {
    console.log(
      `   • ${empty.length} wywołań bez trafień. „Nie znalazłem" to poprawny wynik, nie usterka.`,
    );
  }
  if (errors.length > 0) {
    const kinds = [...new Set(errors.map((e) => e.error ?? "?"))].join(", ");
    console.log(`   ⚠ ${errors.length} błąd(y): ${kinds} — te dane NIE zostały sprawdzone.`);
  }
}

const hidden = ordered.length - shown.length;
console.log(
  hidden > 0
    ? `\n(${hidden} starszych sesji pominięto — użyj: npm run audit -- --sesje ${ordered.length})\n`
    : "",
);
