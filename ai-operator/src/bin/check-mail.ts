#!/usr/bin/env tsx
import { loadConfig } from "../config.js";
import { ImapMailProvider } from "../mail/imap.js";
import { FixtureMailProvider } from "../mail/fixture.js";
import type { MailProvider } from "../mail/types.js";
import { normalizeReferences } from "../mail/thread.js";
import type { FolderPlan, MailboxInfo } from "../mail/folders.js";

/**
 * Dostawca, który potrafi opowiedzieć o swoich folderach. Oba istniejące
 * dostawcy to implementują — celowo poza interfejsem MailProvider, bo agent
 * tego nie potrzebuje i nie ma po co widzieć struktury skrzynki.
 */
type FolderAware = MailProvider & {
  listMailboxes(): Promise<MailboxInfo[]>;
  resolveFolders(): Promise<FolderPlan>;
};

/**
 * Test warstwy poczty BEZ MODELU. Dziesięć sprawdzeń z listy uruchomieniowej.
 *
 *   npm run check:mail                  # tryb z .env (fixture albo live)
 *   MODE=live npm run check:mail
 *   MODE=live npm run check:mail -- --days 7
 *
 * Ten skrypt nie woła modelu i nie wywołuje capability — sprawdza sam adapter.
 * Jeśli tu coś nie działa, nie ma sensu włączać AI.
 *
 * OCHRONA DANYCH: nie wypisuje treści wiadomości ani danych dostępowych.
 * Adresy są maskowane, tematy przycinane. Zamiast treści raportowane są
 * właściwości (długość, obecność polskich znaków, czy było HTML).
 */

const argv = process.argv.slice(2);
const numArg = (flag: string, fallback: number): number => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const SINCE_DAYS = numArg("--days", 3);

/** a***@domena.pl — domena zostaje, bo bez niej nie widać, czy adres jest sensowny. */
function maskAddress(addr: string | null | undefined): string {
  if (!addr) return "(brak)";
  const at = addr.indexOf("@");
  if (at <= 0) return "***";
  return `${addr[0]}***${addr.slice(at)}`;
}

function clipSubject(subject: string, max = 48): string {
  const s = subject.replace(/\s+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, max) + "…";
}

const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;

interface Result {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
  /** true = brak danych do sprawdzenia, nie porażka adaptera. */
  readonly skipped?: boolean;
}

const results: Result[] = [];
function record(step: string, ok: boolean, detail: string, skipped = false): void {
  results.push({ step, ok, detail, skipped });
  const mark = skipped ? "–" : ok ? "✓" : "✗";
  process.stdout.write(`  ${mark} ${step}\n      ${detail}\n`);
}

async function main(): Promise<number> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Konfiguracja: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const isLive = config.mail.kind === "imap";
  const provider: FolderAware =
    config.mail.kind === "imap"
      ? new ImapMailProvider({
          host: config.mail.host,
          port: config.mail.port,
          user: config.mail.user,
          pass: config.mail.pass,
          folder: config.mail.folder,
          threadFolders: config.mail.threadFolders,
        })
      : new FixtureMailProvider({ filePath: config.mail.filePath });

  process.stdout.write(
    `Test warstwy poczty — dostawca: ${provider.id}` +
      (isLive && config.mail.kind === "imap"
        ? `, host: ${config.mail.host}:${config.mail.port}, konto: ${maskAddress(config.mail.user)}`
        : "") +
      `\nOkno: ${SINCE_DAYS} dni. Model NIE jest wołany.\n\n`,
  );

  const since = new Date(Date.now() - SINCE_DAYS * 86_400_000);
  let inboxFolder = "INBOX";
  let sentFolder: string | null = null;

  try {
    // ── 1. połączenie i foldery ───────────────────────────────────────────────
    // Sprawdzenie strukturalne, nie instanceof — ta sama diagnostyka działa dla
    // adaptera IMAP i dla fikstur, więc checker sam jest testowany na fiksturach.
    try {
      const boxes = await provider.listMailboxes();
      record(
        isLive ? "1. Połączenie IMAP" : "1. Połączenie z dostawcą",
        true,
        `${isLive ? "połączono" : "wczytano fikstury"}, ${boxes.length} folderów: ` +
          boxes.map((b) => b.path).join(", "),
      );

      // ── folder wysłanych: wykryty po SPECIAL-USE, nie zgadnięty po nazwie ───
      const plan = await provider.resolveFolders();
      inboxFolder = plan.inbox;
      sentFolder = plan.sent;
      const special = boxes
        .filter((b) => b.specialUse)
        .map((b) => `${b.specialUse}=${b.path}`)
        .join(", ");
      record(
        "1b. Wykrycie folderu wysłanych",
        plan.sent !== null,
        plan.sent
          ? `\\Sent = "${plan.sent}" (źródło: ${plan.sentSource}); wątki z: ${plan.threadFolders.join(", ")}`
          : `nie wskazano \\Sent. Foldery specjalne: ${special || "brak"}. ` +
              "Wpisz właściwą nazwę ręcznie w MAIL_THREAD_FOLDERS.",
      );
      for (const w of plan.warnings) process.stdout.write(`      ⚠ ${w}\n`);
    } catch (err) {
      record("1. Połączenie", false, msg(err));
      process.stdout.write("\nBez połączenia dalsze sprawdzenia nie mają sensu.\n");
      return 1;
    }

    // ── 2. listowanie ─────────────────────────────────────────────────────────
    const recent = await provider.listRecent({ limit: 25, since, folder: inboxFolder });
    record(
      "2. Listowanie ostatnich wiadomości",
      recent.length > 0,
      recent.length > 0
        ? `${recent.length} wiadomości; najnowsza: ${recent[0]!.date.slice(0, 16)} od ${maskAddress(recent[0]!.from?.address)}`
        : `0 wiadomości w ostatnich ${SINCE_DAYS} dniach — zwiększ --days albo sprawdź folder`,
    );

    if (recent.length === 0) {
      process.stdout.write("\nBrak wiadomości w oknie — reszta sprawdzeń nie ma na czym pracować.\n");
      return 1;
    }

    // ── 3. pobranie jednej wiadomości (pełna treść przez wątek) ───────────────
    const seed = recent[0]!;
    const thread = await provider.getThread({ messageId: seed.id, maxMessages: 10 });
    const seedFull = thread?.messages.find((m) => m.id === seed.id) ?? thread?.messages[0];
    record(
      "3. Pobranie treści wiadomości",
      Boolean(seedFull),
      seedFull
        ? `temat: "${clipSubject(seedFull.subject)}", treść: ${seedFull.body.length} znaków` +
            (seedFull.bodyTruncated ? " (przycięta)" : "")
        : "nie udało się pobrać treści wiadomości-ziarna",
    );

    // ── 4. wyszukiwanie ───────────────────────────────────────────────────────
    // Fraza z prawdziwego nadawcy — pewne trafienie, jeśli wyszukiwanie działa.
    const domain = seed.from?.address.split("@")[1] ?? "";
    const needle = domain || clipSubject(seed.subject, 12);
    const found = await provider.search({ query: needle, limit: 10, since });
    record(
      "4. Wyszukiwanie",
      found.length > 0,
      found.length > 0
        ? `fraza "${needle}" → ${found.length} trafień`
        : `fraza "${needle}" → 0 trafień. Serwer może nie wspierać SEARCH BODY/FROM`,
    );

    // ── 5. rekonstrukcja wątku ────────────────────────────────────────────────
    // Szukamy w oknie wiadomości, która faktycznie jest odpowiedzią.
    const reply = recent.find((m) => m.references.length > 0 || m.inReplyTo);
    if (reply) {
      const t = await provider.getThread({ messageId: reply.id, maxMessages: 20 });
      record(
        "5. Rekonstrukcja wątku",
        Boolean(t && t.messageCount >= 2),
        t
          ? `wątek "${clipSubject(t.subject)}": ${t.messageCount} wiadomości` +
              (t.messageCount < 2
                ? " — mniej niż 2, choć wiadomość ma References. Sprawdź MAIL_THREAD_FOLDERS"
                : "")
          : "nie udało się odtworzyć wątku",
      );
    } else {
      record(
        "5. Rekonstrukcja wątku",
        true,
        `w ostatnich ${SINCE_DAYS} dniach nie ma wiadomości z References/In-Reply-To — brak materiału`,
        true,
      );
    }

    // ── 6. wiadomości z folderu wysłanych ─────────────────────────────────────
    if (sentFolder) {
      const sent = await provider.listRecent({ limit: 10, since, folder: sentFolder });
      record(
        "6. Widoczność folderu wysłanych",
        sent.length > 0,
        sent.length > 0
          ? `${sent.length} naszych wiadomości w "${sentFolder}"; najnowsza ${sent[0]!.date.slice(0, 16)}`
          : `folder "${sentFolder}" jest widoczny, ale w oknie ${SINCE_DAYS} dni nic w nim nie ma`,
      );
    } else {
      record(
        "6. Widoczność folderu wysłanych",
        false,
        "brak wykrytego folderu wysłanych — agent nie zobaczy naszych odpowiedzi",
      );
    }

    // ── 7. polskie znaki ──────────────────────────────────────────────────────
    const pool = [...recent];
    if (seedFull) pool.push(seedFull as (typeof recent)[number]);
    const withPolish = pool.filter(
      (m) => POLISH.test(m.subject) || POLISH.test(m.snippet),
    );
    const sample = withPolish[0];
    const diacritics = sample
      ? [...new Set((sample.subject + sample.snippet).match(POLISH) ?? [])].join("")
      : "";
    record(
      "7. Polskie znaki",
      withPolish.length > 0,
      withPolish.length > 0
        ? `${withPolish.length}/${pool.length} wiadomości ma diakrytyki; wykryte znaki: ${diacritics}`
        : "w próbce nie ma polskich znaków — nie da się tego potwierdzić ani zaprzeczyć",
      withPolish.length === 0,
    );

    // ── 8. HTML i plain text ──────────────────────────────────────────────────
    // Wskaźnik: treść po normalizacji nie może zawierać znaczników.
    const bodies = thread?.messages ?? [];
    const withMarkup = bodies.filter((m) => /<\/?(div|p|table|span|br)\b/i.test(m.body));
    const nonEmpty = bodies.filter((m) => m.body.trim().length > 0);
    record(
      "8. HTML → tekst",
      withMarkup.length === 0 && nonEmpty.length > 0,
      nonEmpty.length === 0
        ? "wszystkie treści w próbce puste — nie ma czego sprawdzić"
        : withMarkup.length === 0
          ? `${nonEmpty.length}/${bodies.length} treści niepustych, żadna nie zawiera znaczników HTML`
          : `${withMarkup.length} treści nadal zawiera znaczniki HTML — normalizacja nie zadziałała`,
    );

    // ── 9. References / In-Reply-To ───────────────────────────────────────────
    const withRefs = recent.filter((m) => m.references.length > 0 || m.inReplyTo);
    const consistent = withRefs.every(
      (m) => normalizeReferences(m.references, m.inReplyTo).length > 0,
    );
    record(
      "9. References / In-Reply-To",
      withRefs.length === 0 || consistent,
      withRefs.length === 0
        ? "brak wiadomości z nagłówkami wątku w oknie"
        : `${withRefs.length} wiadomości ma nagłówki wątku, normalizacja spójna dla wszystkich`,
      withRefs.length === 0,
    );

    // ── 10. metadane załączników ──────────────────────────────────────────────
    const withAtt = recent.filter((m) => m.attachments.length > 0);
    const att = withAtt[0]?.attachments[0];
    record(
      "10. Załączniki jako metadane",
      withAtt.length === 0 || Boolean(att && (att.filename || att.contentType)),
      withAtt.length === 0
        ? "w oknie nie ma wiadomości z załącznikami"
        : `${withAtt.length} wiadomości z załącznikami; przykład: ${att?.filename ?? "(bez nazwy)"} ` +
            `${att?.contentType ?? "?"} ${att?.sizeBytes ?? "?"} B — sama metryka, bez zawartości`,
      withAtt.length === 0,
    );
  } catch (err) {
    record("Nieoczekiwany błąd", false, msg(err));
  } finally {
    await provider.close();
  }

  const failed = results.filter((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  process.stdout.write(
    `\n${results.length - failed.length - skipped.length} przeszło, ${failed.length} nie przeszło, ` +
      `${skipped.length} pominięto (brak danych do sprawdzenia).\n`,
  );
  if (failed.length > 0) {
    process.stdout.write("Nie włączaj modelu, dopóki poczta nie przechodzi:\n");
    for (const f of failed) process.stdout.write(`  - ${f.step}: ${f.detail}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

function msg(err: unknown): string {
  // Komunikat błędu IMAP może zawierać nazwę konta — maskujemy adresy.
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[\w.+-]+@[\w.-]+/g, (m) => maskAddress(m));
}

main().then((code) => process.exit(code));
