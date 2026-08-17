/**
 * Raport dzienny — jedyna komenda, która ma działać BEZ człowieka przy klawiaturze.
 *
 *   npm run raport                  # wczoraj + dzisiaj
 *   npm run raport -- --dni 3
 *   npm run raport -- --otworz      # otwórz panel po wygenerowaniu (macOS)
 *
 * Wynik to gotowy panel HTML w `raporty/`, nie tekst do czytania w terminalu:
 *   raporty/dzisiaj.html       — stały adres, zawsze najnowszy (do zakładki)
 *   raporty/2026-08-18.html    — kopia z datą, do wracania
 *
 * Na standardowe wyjście idzie JEDNO zdanie podsumowania. To ono ma trafić do
 * powiadomienia systemowego, dlatego jest jedną linią i mówi o liczbach, nie
 * o tym, że „raport został wygenerowany".
 *
 * Kod wyjścia: 0 = w porządku, 3 = odpowiedź zawierała twierdzenie bez pokrycia
 * w rzeczywistych wywołaniach (kontrola z evidence.ts), 1 = przebieg się nie udał.
 *
 * UWAGA na zawartość: ten plik zawiera tematy i nadawców z prawdziwej poczty —
 * inaczej byłby bezużyteczny. To NIE jest log audytu, który treści nie zawiera.
 * Katalog `raporty/` jest w .gitignore i nie wolno go nikomu wysyłać.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../index.js";
import { fromPackageRoot } from "../paths.js";
import { renderReportHtml, summarize } from "../agent/report-view.js";

const argv = process.argv.slice(2);
const num = (flag: string, fallback: number): number => {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

async function main(): Promise<number> {
  const app = createApp();
  const dir = fromPackageRoot("raporty");

  try {
    const result = await app.triage.run({
      sinceDays: num("--dni", 1),
      limit: num("--limit", 50),
      // Budżet wywołań ERP wyższy niż w podglądzie interaktywnym: w raporcie
      // dziennym luka poczta ↔ system jest głównym pytaniem, nie dodatkiem.
      maxErpLookups: num("--erp", 15),
      checkAllRefs: true,
    });

    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const html = renderReportHtml(result, now);

    mkdirSync(dir, { recursive: true });
    const latest = join(dir, "dzisiaj.html");
    writeFileSync(latest, html, "utf8");
    writeFileSync(join(dir, `${stamp}.html`), html, "utf8");

    // Jedna linia dla powiadomienia. Reszta jest w panelu.
    process.stdout.write(summarize(result) + "\n");
    process.stderr.write(`panel: ${latest}\n`);

    // Panel sam wchodzi na ekran tylko wtedy, gdy jest po co. Codzienne otwieranie
    // okna „nic się nie stało" uczy zamykać je bez czytania — a wtedy przestaje
    // działać także w dniu, w którym coś się stało.
    const worthOpening =
      result.items.some((i) => i.erp.some((e) => !e.found)) ||
      result.items.some((i) => i.category === "Pilne") ||
      result.evidence.some((e) => !e.ok);

    if (argv.includes("--otworz") || (argv.includes("--otworz-jesli-wazne") && worthOpening)) {
      const { spawn } = await import("node:child_process");
      spawn("open", [latest], { stdio: "ignore", detached: true }).unref();
    }

    // Kontrola dowodów działa w tym trybie — i ma być widoczna.
    return result.evidence.some((e) => e.ok === false) ? 3 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Raport się nie udał: ${msg}\n`);
    return 1;
  } finally {
    await app.close();
  }
}

main().then((code) => process.exit(code));
