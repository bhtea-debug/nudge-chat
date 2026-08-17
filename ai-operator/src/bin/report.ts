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
import { renderRun } from "../state/report.js";
import { OPEN_STATUSES } from "../state/types.js";
import { formatModelError } from "../model/errors.js";

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
    // Raport = przebieg monitora (bez modelu, bez kosztu) plus widok pamięci
    // spraw. Nie osobna analiza: dzięki temu raport i odpowiedzi Claude pokazują
    // DOKŁADNIE ten sam stan i nie mogą się rozjechać w liczbach.
    if (!argv.includes("--bez-skanu")) {
      const run = await app.monitor.runOnce();
      process.stderr.write(renderRun(run) + "\n");
    }

    const input = {
      issues: app.store.all(),
      checkpoints: app.store.checkpoints(),
      integrityWarning: app.store.integrityWarning(),
    };

    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const html = renderReportHtml(input, now);

    mkdirSync(dir, { recursive: true });
    const latest = join(dir, "dzisiaj.html");
    writeFileSync(latest, html, "utf8");
    writeFileSync(join(dir, `${stamp}.html`), html, "utf8");

    // Jedna linia dla powiadomienia. Reszta jest w panelu.
    process.stdout.write(summarize(input) + "\n");
    process.stderr.write(`panel: ${latest}\n`);

    // Panel sam wchodzi na ekran tylko wtedy, gdy jest po co. Codzienne otwieranie
    // okna „nic się nie stało" uczy zamykać je bez czytania — a wtedy przestaje
    // działać także w dniu, w którym coś się stało.
    const worthOpening =
      input.issues.some((i) => (i.lastErpSummary ?? "").includes("NIE MA")) ||
      input.issues.some((i) => i.priority === "high" && OPEN_STATUSES.includes(i.status)) ||
      input.checkpoints.some((c) => c.lastError !== null) ||
      input.issues.some((i) => i.lastPresentedAt === null && OPEN_STATUSES.includes(i.status));

    if (argv.includes("--otworz") || (argv.includes("--otworz-jesli-wazne") && worthOpening)) {
      const { spawn } = await import("node:child_process");
      spawn("open", [latest], { stdio: "ignore", detached: true }).unref();
    }

    // Nieudany skan folderu to dziura w danych, nie „spokojna skrzynka" —
    // kod wyjścia to odzwierciedla, żeby harmonogram mógł o tym powiedzieć.
    return input.checkpoints.some((c) => c.lastError !== null) ? 3 : 0;
  } catch (err) {
    // Ten sam komunikat co w monitorze — właściciel widzi go w powiadomieniu
    // macOS, więc surowy JSON z API byłby tam całkowicie bezużyteczny.
    process.stdout.write(`Raport się nie udał: ${formatModelError(err)}\n`);
    return 1;
  } finally {
    await app.close();
  }
}

main().then((code) => process.exit(code));
