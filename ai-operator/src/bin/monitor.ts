/**
 * Background Operator — obserwacja poczty bez człowieka przy klawiaturze.
 *
 *   npm run monitor              # jeden przebieg i koniec
 *   npm run monitor -- --petla   # w pętli, co MONITOR_INTERVAL_MINUTES
 *
 * `--petla` istnieje, bo w usłudze zdalnej monitor żyje w tym samym procesie co
 * serwer MCP: jeden deploy, jeden pisarz do stanu, jedno miejsce awarii.
 * Lokalnie wygodniejszy jest pojedynczy przebieg z harmonogramu systemowego.
 *
 * Kod wyjścia: 0 = przebieg wykonany (także gdy nic nie przyszło),
 * 1 = przebieg się nie udał w całości.
 */
import { createApp } from "../index.js";
import { renderRun } from "../state/report.js";

const argv = process.argv.slice(2);
const loop = argv.includes("--petla") || argv.includes("--loop");
const quiet = argv.includes("--cicho") || argv.includes("--quiet");

async function main(): Promise<number> {
  const app = createApp();
  const minutes = app.config.copilot.intervalMinutes;

  if (app.config.mail.kind !== "imap") {
    console.warn(
      "MODE nie jest live — monitor pracuje na fiksturach. Do prawdziwej poczty ustaw MODE=live.",
    );
  }

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(
    `Monitor: foldery [${app.config.copilot.monitorFolders.join(", ")}]` +
      (loop ? `, co ${minutes} min. Ctrl+C kończy.` : ", jeden przebieg."),
  );

  let failures = 0;
  do {
    try {
      const run = await app.monitor.runOnce();
      if (!quiet) console.log(renderRun(run));
      failures = 0;
    } catch (err) {
      failures += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] przebieg nie udał się: ${msg}`);
      if (!loop) {
        await app.close();
        return 1;
      }
      // W pętli nie przewracamy procesu — poczta bywa chwilowo nieosiągalna.
      // Ale po serii porażek mówimy o tym wyraźnie, zamiast cicho kręcić się dalej.
      if (failures % 4 === 0) {
        console.error(
          `⚠ ${failures} nieudanych przebiegów pod rząd. Stan spraw jest nieaktualny — ` +
            "Claude powie o tym przez staleNote, ale warto sprawdzić `npm run check:mail`.",
        );
      }
    }

    if (!loop || stopping) break;

    // Odczekanie w krokach, żeby Ctrl+C działał od razu, a nie po kwadransie.
    const until = Date.now() + minutes * 60_000;
    while (Date.now() < until && !stopping) {
      await new Promise((r) => setTimeout(r, 1_000));
    }
  } while (!stopping);

  await app.close();
  return 0;
}

main().then((code) => process.exit(code));
