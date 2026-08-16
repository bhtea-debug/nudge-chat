#!/usr/bin/env tsx
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { loadConfig } from "../config.js";
import { normalizeReferences } from "../mail/thread.js";
import { planFolders, type MailboxInfo } from "../mail/folders.js";

/**
 * Sonda diagnostyczna dla rekonstrukcji wątku. Narzędzie jednorazowe, nie
 * część agenta — nie wywołuje żadnej capability i nie woła modelu.
 *
 *   MODE=live npm run probe:thread
 *   MODE=live npm run probe:thread -- --days 7
 *
 * Powstała, bo `check:mail` zgłosiło realną usterkę („rodzic jest w oknie, a
 * wątek ma 1 wiadomość"), a adapter połyka błędy wyszukiwania i zwraca null.
 * Sonda robi to samo co adapter, ale KROK PO KROKU i bez połykania błędów.
 *
 * Wypisuje nagłówki Message-ID i References w surowej postaci — to jest cały
 * sens, bo najbardziej prawdopodobną przyczyną jest niezgodność formatu.
 * Nie wypisuje treści wiadomości. Tematy przycięte.
 */

const argv = process.argv.slice(2);
const days = (() => {
  const i = argv.indexOf("--days");
  const v = i === -1 ? NaN : Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : 7;
})();

const clip = (s: string, n = 44): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
};

async function main(): Promise<number> {
  const config = loadConfig();
  if (config.mail.kind !== "imap") {
    process.stderr.write("Sonda ma sens tylko przy MODE=live.\n");
    return 2;
  }

  const client = new ImapFlow({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.port === 993,
    auth: { user: config.mail.user, pass: config.mail.pass },
    logger: false,
    emitLogs: false,
    connectionTimeout: 20_000,
    socketTimeout: 90_000,
  });
  client.on("error", () => {});
  await client.connect();

  const boxes: MailboxInfo[] = (await client.list()).map((b) => ({
    path: b.path,
    name: b.name,
    specialUse: b.specialUse,
    specialUseSource: b.specialUseSource,
    subscribed: b.subscribed,
  }));
  const plan = planFolders(boxes, config.mail.threadFolders, config.mail.folder);
  process.stdout.write(`Foldery wątku: ${plan.threadFolders.join(", ")}\n\n`);

  // ── 1. Wczytaj okno z INBOX-a i pokaż surowe nagłówki wątkowe ───────────────
  const since = new Date(Date.now() - days * 86_400_000);
  const rows: {
    uid: number;
    id: string;
    inReplyTo: string | null;
    refs: string[];
    subject: string;
  }[] = [];

  const lock = await client.getMailboxLock(plan.inbox, { readOnly: true });
  try {
    const found = await client.search({ since }, { uid: true });
    const uids = found === false ? [] : found.slice(-25);
    if (uids.length > 0) {
      for await (const msg of client.fetch(
        uids.join(","),
        { uid: true, envelope: true, source: true },
        { uid: true },
      )) {
        const parsed = await simpleParser(msg.source as Buffer);
        rows.push({
          uid: msg.uid,
          id: (parsed.messageId ?? msg.envelope?.messageId ?? "").trim(),
          inReplyTo: parsed.inReplyTo?.trim() || null,
          refs: normalizeReferences(parsed.references, parsed.inReplyTo),
          subject: parsed.subject ?? "",
        });
      }
    }
  } finally {
    lock.release();
  }

  process.stdout.write(`W oknie ${days} dni: ${rows.length} wiadomości\n\n`);

  const idsInWindow = new Set(rows.map((r) => r.id).filter(Boolean));

  // ── 2. Znajdź odpowiedź, której rodzic jest w oknie ─────────────────────────
  const linked = rows.find((r) => r.refs.some((ref) => idsInWindow.has(ref)));
  if (!linked) {
    process.stdout.write("Nie ma w oknie odpowiedzi, której rodzic też jest w oknie.\n");
    await client.logout();
    return 1;
  }

  const parentRef = linked.refs.find((ref) => idsInWindow.has(ref))!;
  const parentRow = rows.find((r) => r.id === parentRef)!;

  process.stdout.write("ODPOWIEDŹ (ziarno wątku)\n");
  process.stdout.write(`  temat:      ${clip(linked.subject)}\n`);
  process.stdout.write(`  uid:        ${linked.uid}\n`);
  process.stdout.write(`  Message-ID: ${JSON.stringify(linked.id)}\n`);
  process.stdout.write(`  In-Reply-To:${JSON.stringify(linked.inReplyTo)}\n`);
  process.stdout.write(`  References: ${JSON.stringify(linked.refs)}\n\n`);

  process.stdout.write("RODZIC (jest w tym samym oknie)\n");
  process.stdout.write(`  temat:      ${clip(parentRow.subject)}\n`);
  process.stdout.write(`  uid:        ${parentRow.uid}\n`);
  process.stdout.write(`  Message-ID: ${JSON.stringify(parentRow.id)}\n\n`);

  // ── 3. Powtórz DOKŁADNIE zapytania adaptera, bez połykania błędów ──────────
  process.stdout.write("SZUKANIE RODZICA PO NAGŁÓWKU — tak jak robi to adapter\n");

  const variants: { label: string; criteria: Record<string, unknown> }[] = [
    { label: 'header {"Message-ID": <z nawiasami>}', criteria: { header: { "Message-ID": parentRef } } },
    {
      label: 'header {"message-id": <małe litery>}',
      criteria: { header: { "message-id": parentRef } },
    },
    {
      label: "header Message-ID BEZ nawiasów kątowych",
      criteria: { header: { "Message-ID": parentRef.replace(/^<|>$/g, "") } },
    },
  ];

  for (const folder of plan.threadFolders) {
    process.stdout.write(`\n  [folder ${folder}]\n`);
    let l: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
    try {
      l = await client.getMailboxLock(folder, { readOnly: true });
      for (const v of variants) {
        try {
          const res = await client.search(v.criteria as never, { uid: true });
          const uids = res === false ? [] : res;
          process.stdout.write(
            `    ${uids.length > 0 ? "✓" : "✗"} ${v.label} → ${uids.length} uid ${uids.length ? `(${uids.join(",")})` : ""}\n`,
          );
        } catch (err) {
          process.stdout.write(
            `    ! ${v.label} → BŁĄD: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      // Odwrotny kierunek: kto wskazuje na ziarno w References.
      try {
        const res = await client.search(
          { header: { References: linked.id } } as never,
          { uid: true },
        );
        const uids = res === false ? [] : res;
        process.stdout.write(
          `    ${uids.length > 0 ? "✓" : "✗"} header {References: <ziarno>} → ${uids.length} uid\n`,
        );
      } catch (err) {
        process.stdout.write(
          `    ! header {References} → BŁĄD: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    } catch (err) {
      process.stdout.write(
        `    ! nie udało się otworzyć folderu: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } finally {
      l?.release();
    }
  }

  // ── 4. Odtwórz krok 3 adaptera: dociąganie każdej referencji ────────────────
  //
  // Wyszukiwanie działa (punkt 3), więc jeśli wątek i tak wraca jednoelementowy,
  // błąd jest PO wyszukiwaniu — w pobieraniu albo parsowaniu. Adapter ma tam
  // połykający catch, więc awaria wygląda jak "nie znaleziono".
  //
  // Ten krok robi to samo, ale mówi, co się stało: ile uid znalazło wyszukiwanie,
  // ile rekordów wyszło z pobrania, i jaki błąd poleciał, jeśli poleciał.
  process.stdout.write("\nDOCIĄGANIE REFERENCJI — krok 3 adaptera, bez połykania błędów\n");

  const wanted = [...new Set([linked.id, ...linked.refs])];
  process.stdout.write(`  referencji do sprawdzenia: ${wanted.length}\n\n`);

  let hits = 0;
  let fetchFailures = 0;
  let parseFailures = 0;

  for (const [i, id] of wanted.entries()) {
    if (id === linked.id) continue;
    const isParent = id === parentRef;
    const tag = isParent ? " ← RODZIC" : "";

    for (const folder of plan.threadFolders) {
      let l: Awaited<ReturnType<ImapFlow["getMailboxLock"]>> | null = null;
      try {
        l = await client.getMailboxLock(folder, { readOnly: true });
        const res = await client.search({ header: { "Message-ID": id } } as never, {
          uid: true,
        });
        const uids = res === false ? [] : res;
        if (uids.length === 0) {
          if (isParent) {
            process.stdout.write(`  [${i}] ${folder}: 0 uid — a POWINIEN być${tag}\n`);
          }
          continue;
        }

        // Pobranie i parsowanie — tu adapter połyka błędy.
        let fetched = 0;
        let parsed = 0;
        let lastError = "";
        for await (const msg of client.fetch(
          String(uids[uids.length - 1]),
          { uid: true, envelope: true, source: true, internalDate: true, flags: true },
          { uid: true },
        )) {
          fetched += 1;
          try {
            const hasSource = Boolean(msg.source);
            if (!hasSource) throw new Error("fetch nie zwrócił pola source");
            await simpleParser(msg.source as Buffer);
            parsed += 1;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }

        if (parsed > 0) {
          hits += 1;
          process.stdout.write(
            `  [${i}] ${folder}: znaleziono i sparsowano (uid ${uids[uids.length - 1]})${tag}\n`,
          );
        } else if (fetched === 0) {
          fetchFailures += 1;
          process.stdout.write(
            `  [${i}] ${folder}: SEARCH dał uid ${uids.join(",")}, ale FETCH nie zwrócił nic${tag}\n`,
          );
        } else {
          parseFailures += 1;
          process.stdout.write(
            `  [${i}] ${folder}: pobrano ${fetched}, PARSOWANIE PADŁO: ${lastError}${tag}\n`,
          );
        }
        break;
      } catch (err) {
        process.stdout.write(
          `  [${i}] ${folder}: BŁĄD: ${err instanceof Error ? err.message : String(err)}${tag}\n`,
        );
      } finally {
        l?.release();
      }
    }
  }

  process.stdout.write(
    `\n  Podsumowanie: dociągnięto ${hits}, awarii pobrania ${fetchFailures}, ` +
      `awarii parsowania ${parseFailures}.\n` +
      `  Wątek powinien mieć ${hits + 1} wiadomości (ziarno + dociągnięte).\n`,
  );

  await client.logout();
  process.stdout.write("\nGotowe.\n");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    process.stderr.write(`Sonda padła: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
