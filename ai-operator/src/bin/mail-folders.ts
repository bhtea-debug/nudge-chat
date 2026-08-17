/**
 * Inwentaryzacja folderów poczty — i propozycja, które monitorować.
 *
 *   MODE=live npm run mail:foldery
 *
 * Powstało, bo w skrzynce jest 21 folderów, a monitor domyślnie czyta jeden.
 * Zamiast rozszerzać go „na wszystko" (skanowanie śmieci i wieloletniego
 * archiwum) albo zostawić na INBOX (agent odpowiada prawdziwie, ale bezużytecznie),
 * najpierw patrzymy, gdzie faktycznie coś się dzieje.
 *
 * Narzędzie NIE zmienia konfiguracji. Wypisuje gotową linię do `.env` i decyzję
 * podejmuje człowiek — bo „które foldery są biznesowe" wie właściciel, nie ja.
 */
import { createApp } from "../index.js";
import { ImapMailProvider } from "../mail/imap.js";
import { judge, type Verdict } from "../mail/folder-verdict.js";
import { CapabilityError } from "../capability/types.js";

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));
const num = (n: number | null, w: number): string => (n === null ? pad("?", w) : String(n).padStart(w));

async function main(): Promise<number> {
  const app = createApp();

  if (app.config.mail.kind !== "imap") {
    console.error(
      "To narzędzie wymaga MODE=live — w trybie fikstur nie ma czego inwentaryzować.\n" +
        "Uruchom: MODE=live npm run mail:foldery",
    );
    return 1;
  }

  const provider = new ImapMailProvider({
    host: app.config.mail.host,
    port: app.config.mail.port,
    user: app.config.mail.user,
    pass: app.config.mail.pass,
    folder: app.config.mail.folder,
    threadFolders: app.config.mail.threadFolders,
  });

  try {
    console.log(`\nSkrzynka ${app.config.mail.user} na ${app.config.mail.host}\n`);
    const stats = await provider.inventory();
    const judged = stats.map(judge);

    // Kolejność: to, co proponuję monitorować, na górze. Człowiek czyta pierwsze
    // wiersze i musi w nich zobaczyć decyzję, nie alfabet.
    const order: Verdict[] = ["monitoruj", "rozważ", "pomiń"];
    judged.sort(
      (a, b) =>
        order.indexOf(a.verdict) - order.indexOf(b.verdict) ||
        (b.newestAt ?? "").localeCompare(a.newestAt ?? ""),
    );

    console.log(
      `${pad("folder", 34)} ${pad("wiad.", 7)} ${pad("nieprz.", 8)} ${pad("ostatnia", 12)} ocena`,
    );
    console.log("─".repeat(96));
    for (const f of judged) {
      const last = f.newestAt ? f.newestAt.slice(0, 10) : "—";
      const mark = f.verdict === "monitoruj" ? "✓" : f.verdict === "rozważ" ? "?" : " ";
      console.log(
        `${mark} ${pad(f.path, 32)} ${num(f.messages, 7)} ${num(f.unseen, 8)} ${pad(last, 12)} ${f.verdict} — ${f.why}`,
      );
    }

    const monitor = judged.filter((f) => f.verdict === "monitoruj").map((f) => f.path);
    const consider = judged.filter((f) => f.verdict === "rozważ").map((f) => f.path);

    console.log(`\n${"═".repeat(96)}\n`);
    console.log("Propozycja do .env — wklej i zmień, jeśli się nie zgadzasz:\n");
    console.log(`  MAIL_MONITOR_FOLDERS=${monitor.join(",")}\n`);

    if (consider.length > 0) {
      console.log(
        `Do rozważenia (${consider.length}): ${consider.join(", ")}\n` +
          "Dopisz je po przecinku, jeśli wiesz, że trafia tam korespondencja z klientami.\n",
      );
    }

    const failed = judged.filter((f) => f.error);
    if (failed.length > 0) {
      console.log(
        `⚠ ${failed.length} folderów nie udało się odczytać — NIE zakładam, że są puste:\n` +
          failed.map((f) => `   ${f.path}: ${f.error}`).join("\n") +
          "\n",
      );
    }

    console.log(
      "Uwaga o koszcie: monitor czyta tylko wiadomości nowe od checkpointu, więc\n" +
        "liczba wiadomości w folderze nie wpływa na koszt bieżącej pracy — wpływa\n" +
        "tylko pierwszy przebieg (MONITOR_FIRST_RUN_DAYS, domyślnie 3 dni).\n",
    );

    return 0;
  } catch (err) {
    const msg =
      err instanceof CapabilityError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`\n✗ Nie udało się: ${msg}\n`);
    return 1;
  } finally {
    await provider.close();
    await app.close();
  }
}

main().then((code) => process.exit(code));
