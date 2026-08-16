#!/usr/bin/env tsx
import { createApp } from "../index.js";
import { formatAuditTrail } from "../capability/audit.js";

/**
 * Zadaj pytanie o pocztę i o dane operacyjne.
 *
 *   npm run ask -- "Co z zamówieniem 12345?"
 *   npm run ask -- --trace "Czy jakiś klient czeka na pilną decyzję?"
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const trace = argv.includes("--trace");
  const question = argv.filter((a) => a !== "--trace").join(" ").trim();

  if (!question) {
    process.stderr.write(
      'Użycie: npm run ask -- [--trace] "pytanie"\n\n' +
        "Przykłady:\n" +
        '  npm run ask -- "Co ważnego przyszło w dzisiejszej poczcie?"\n' +
        '  npm run ask -- "Co z zamówieniem 12345? Klient pisze, że potrzebuje dostawy do środy."\n' +
        '  npm run ask -- "Czy mamy na stanie Rooibos Vanilla?"\n' +
        '  npm run ask -- "Jak wygląda dziś produkcja?"\n',
    );
    return 2;
  }

  let app: ReturnType<typeof createApp>;
  try {
    app = createApp();
  } catch (err) {
    // Brak konfiguracji to nie jest awaria programu — to instrukcja dla człowieka.
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
    const result = await app.operator.ask(question, controller.signal);
    process.stdout.write(result.answerWithEvidence + "\n");

    if (trace) {
      process.stderr.write(
        `\n--- trace (correlationId=${result.correlationId}, tur: ${result.turns}) ---\n` +
          formatAuditTrail(result.audit) +
          "\n",
      );
    }
    // Kod wyjścia mówi, czy kontrola dowodów coś zgłosiła — użyteczne w skryptach.
    return result.findings.length > 0 ? 3 : 0;
  } catch (err) {
    process.stderr.write(`Błąd: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    await app.close();
  }
}

main().then((code) => process.exit(code));
