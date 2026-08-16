#!/usr/bin/env tsx
import { createApp } from "../index.js";
import { renderTriage } from "../agent/triage.js";
import { formatAuditTrail } from "../capability/audit.js";

/**
 * Przegląd poczty w pięciu kategoriach, z dociągnięciem statusów z TeaBrew
 * dla spraw pilnych i decyzyjnych.
 *
 *   npm run triage
 *   npm run triage -- --days 3 --limit 40 --unread --trace
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
  };

  let app: ReturnType<typeof createApp>;
  try {
    app = createApp();
  } catch (err) {
    process.stderr.write(`Konfiguracja: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  try {
    process.stderr.write(
      `[tryb: ${app.config.mode} | poczta: ${app.config.mail.kind} | teabrew: ${app.config.teabrew.kind}]\n\n`,
    );
    const result = await app.triage.run({
      sinceDays: num("--days", 1),
      limit: num("--limit", 25),
      unreadOnly: argv.includes("--unread"),
      maxErpLookups: num("--max-erp", 6),
      signal: controller.signal,
    });
    process.stdout.write(renderTriage(result) + "\n");

    if (argv.includes("--trace")) {
      process.stderr.write(
        `\n--- trace (correlationId=${result.correlationId}) ---\n` +
          formatAuditTrail(result.audit) +
          "\n",
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`Błąd: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    await app.close();
  }
}

main().then((code) => process.exit(code));
