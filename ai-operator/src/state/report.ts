import type { MonitorRun } from "./monitor.js";

/**
 * Raport z jednego przebiegu monitora — dla logu, nie dla właściciela.
 *
 * Trzy liczby, które muszą być widoczne, bo bez nich nie da się prowadzić tego
 * systemu odpowiedzialnie:
 *  1. ile wiadomości odsiał filtr DETERMINISTYCZNY (to jest oszczędność),
 *  2. ile poszło do modelu (to jest koszt),
 *  3. co się nie udało (to jest dziura w danych, nie „spokojna skrzynka").
 */
export function renderRun(run: MonitorRun): string {
  const c = run.cost;
  const secs = ((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000).toFixed(1);
  const out: string[] = [];

  out.push(
    `[${run.finishedAt.slice(11, 19)}] przebieg ${run.correlationId.slice(0, 8)} — ${secs}s`,
  );

  for (const f of run.folders) {
    if (f.error) {
      out.push(`  ✗ ${f.folder}: ${f.error}  (checkpoint NIE przesunięty)`);
      continue;
    }
    if (f.considered === 0) {
      out.push(`  · ${f.folder}: nic nowego`);
      continue;
    }
    out.push(
      `  ✓ ${f.folder}: ${f.considered} nowych → ${f.filtered} odsiane, ${f.toModel} do modelu` +
        ` → ${f.created} nowych spraw, ${f.updated} zaktualizowanych`,
    );
  }

  if (c.messagesToModel > 0 || c.erpLookups > 0) {
    out.push(
      `  koszt: ${c.modelCalls} wywołań modelu, ${c.inputTokens} tok. wejścia, ` +
        `${c.outputTokens} tok. wyjścia, ${c.erpLookups} zapytań do TeaBrew`,
    );
  }

  const reasons = Object.entries(run.droppedReasons);
  if (reasons.length > 0) {
    out.push(`  odsiane: ${reasons.map(([why, n]) => `${n}× ${why}`).join("; ")}`);
  }

  if (run.notificationCandidates.length > 0) {
    // Kanał powiadomień jeszcze nie istnieje — i to jest świadome. Ale sytuacje
    // warte powiadomienia muszą być widoczne już teraz, żeby po tygodniu było
    // wiadomo, ile ich realnie jest, zanim ktokolwiek włączy alerty.
    out.push(`  ⚑ warte powiadomienia (kanał jeszcze nieaktywny):`);
    for (const n of run.notificationCandidates) {
      out.push(`     ${n.id} ${n.title} — ${n.reason}`);
    }
  }

  return out.join("\n");
}

/**
 * Rachunek kosztów w formie do zapisania w logu JSONL. Osobno od tekstu, bo po
 * tygodniu chcemy policzyć sumę, a nie czytać dwieście linii.
 */
export function costLine(run: MonitorRun): string {
  return JSON.stringify({
    ts: run.finishedAt,
    correlationId: run.correlationId,
    ...run.cost,
    notificationCandidates: run.notificationCandidates.length,
  });
}
