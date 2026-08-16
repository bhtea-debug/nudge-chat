#!/usr/bin/env tsx
import { loadConfig } from "../config.js";
import { CapabilityError } from "../capability/types.js";
import { ImapMailProvider } from "../mail/imap.js";
import { FixtureMailProvider } from "../mail/fixture.js";
import type { MailProvider } from "../mail/types.js";
import { normalizeReferences, parentRefsWithin } from "../mail/thread.js";
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

/** Ile czekamy na jedno sprawdzenie, zanim uznamy je za zawieszone. */
const STEP_TIMEOUT_MS = Number(process.env["CHECK_MAIL_STEP_TIMEOUT_MS"] ?? 60_000);

class StepTimeout extends Error {
  constructor(
    readonly step: string,
    readonly seconds: number,
  ) {
    super(`serwer nie odpowiedział w ${seconds} s na: ${step}`);
    this.name = "StepTimeout";
  }
}

/**
 * Twardy limit na jedno sprawdzenie.
 *
 * Nie da się anulować zapytania IMAP, które serwer już wykonuje — ale da się
 * przestać na nie czekać i POWIEDZIEĆ, na czym stanęło. Bez tego narzędzie
 * diagnostyczne wisi bez komunikatu, czyli nie diagnozuje niczego.
 */
async function withDeadline<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StepTimeout(label, Math.round(STEP_TIMEOUT_MS / 1000))),
      STEP_TIMEOUT_MS,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    // Gdy wygrał deadline, `work` nadal biegnie i może odrzucić później.
    // Bez tego handlera byłoby to nieobsłużone odrzucenie i wywrót procesu.
    void Promise.resolve(work).catch(() => {});
  }
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
      const code = err instanceof CapabilityError ? err.code : "nieznany";
      record("1. Połączenie", false, `[${code}] ${msg(err)}`);

      // Podpowiedzi zależne od tego, CZY serwer odpowiedział. To jest cała
      // różnica między „szukaj problemu w haśle" i „szukaj go w sieci".
      process.stdout.write("\n  Co sprawdzić:\n");
      if (code === "auth_failed") {
        process.stdout.write(
          "    - serwer odpowiedział i odrzucił logowanie, więc sieć i port są dobre,\n" +
            "    - czy login to PEŁNY adres e-mail,\n" +
            "    - czy hasło to hasło tej skrzynki (u części dostawców nie ma osobnych\n" +
            "      haseł aplikacji — wtedy właściwe jest zwykłe hasło skrzynki),\n" +
            "    - czy dostęp IMAP jest dla tego konta włączony w panelu dostawcy,\n" +
            "    - czy hasło nie zostało wklejone ze spacją albo znakiem końca linii.\n",
        );
      } else {
        process.stdout.write(
          "    - serwer NIE odpowiedział, więc problem jest przed logowaniem,\n" +
            "    - czy host i port są poprawne (993 = IMAP po SSL/TLS),\n" +
            "    - czy sieć nie blokuje portu 993 (firma, VPN, hotspot),\n" +
            "    - czy dostawca nie ogranicza dostępu IMAP do wybranych adresów IP,\n" +
            "    - czy z tej maszyny da się w ogóle otworzyć połączenie:\n" +
            `        nc -vz ${config.mail.kind === "imap" ? config.mail.host : "<host>"} ${config.mail.kind === "imap" ? config.mail.port : 993}\n`,
        );
      }
      process.stdout.write("\nBez połączenia dalsze sprawdzenia nie mają sensu.\n");
      return 1;
    }

    // ── 2. listowanie ─────────────────────────────────────────────────────────
    const recent = await withDeadline(
      "listowanie",
      provider.listRecent({ limit: 25, since, folder: inboxFolder }),
    );
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
    const thread = await withDeadline(
      "pobranie wątku",
      provider.getThread({ messageId: seed.id, maxMessages: 10 }),
    );
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
    const found = await withDeadline(
      "wyszukiwanie",
      provider.search({ query: needle, limit: 10, since }),
    );
    record(
      "4. Wyszukiwanie",
      found.length > 0,
      found.length > 0
        ? `fraza "${needle}" → ${found.length} trafień`
        : `fraza "${needle}" → 0 trafień. Serwer może nie wspierać SEARCH BODY/FROM`,
    );

    // ── 5. rekonstrukcja wątku ────────────────────────────────────────────────
    //
    // Sam nagłówek References NIE znaczy, że wątek da się odtworzyć: automatyczni
    // nadawcy (systemy biletowe, portale rezerwacyjne) ustawiają References na
    // wątek, który żyje po ICH stronie, a rodzica w naszej skrzynce nigdy nie było.
    // Wątek jednoelementowy jest wtedy poprawnym wynikiem, nie usterką.
    //
    // Dlatego testujemy na odpowiedzi, której rodzic JEST w oknie. Dopiero wtedy
    // „mniej niż 2" oznacza rzeczywisty problem z rekonstrukcją.
    const idsInWindow = new Set(recent.map((m) => m.id));
    // parentRefsWithin wyklucza autoreferencje — automaty potrafią wstawić
    // własny Message-ID do własnego References, a wtedy wiadomość udaje
    // odpowiedź z rodzicem w skrzynce i „wątek" jednoelementowy wygląda
    // jak usterka, choć jest poprawnym wynikiem.
    const linkedReply = recent.find((m) => parentRefsWithin(m, idsInWindow).length > 0);
    const anyReply = recent.find((m) => m.references.length > 0 || m.inReplyTo);
    const reply = linkedReply ?? anyReply;

    if (!reply) {
      record(
        "5. Rekonstrukcja wątku",
        true,
        `w ostatnich ${SINCE_DAYS} dniach nie ma wiadomości z References/In-Reply-To — brak materiału`,
        true,
      );
    } else {
      const t = await withDeadline(
        "rekonstrukcja wątku",
        provider.getThread({ messageId: reply.id, maxMessages: 20 }),
      );
      if (!t) {
        record("5. Rekonstrukcja wątku", false, "nie udało się odtworzyć wątku");
      } else if (t.messageCount >= 2) {
        const folders = [...new Set(t.messages.map((m) => m.folder))].join(", ");
        record(
          "5. Rekonstrukcja wątku",
          true,
          `wątek "${clipSubject(t.subject)}": ${t.messageCount} wiadomości z folderów: ${folders}`,
        );
      } else if (linkedReply) {
        // Rodzic jest w oknie, a mimo to nie został dołączony — to jest usterka.
        record(
          "5. Rekonstrukcja wątku",
          false,
          `wątek "${clipSubject(t.subject)}": 1 wiadomość, choć wiadomość-rodzic jest w tym samym oknie. ` +
            "Sprawdź MAIL_THREAD_FOLDERS i uprawnienia do folderów.",
        );
      } else {
        // Brak materiału, nie usterka: rodzic nie istnieje w tej skrzynce.
        record(
          "5. Rekonstrukcja wątku",
          true,
          `wątek "${clipSubject(t.subject)}": 1 wiadomość. Nagłówek References wskazuje ` +
            "wiadomość, której w tej skrzynce nie ma — typowe dla nadawców " +
            "automatycznych. Brak materiału do sprawdzenia sklejania wątku.",
          true,
        );
      }
    }

    // ── 6. wiadomości z folderu wysłanych ─────────────────────────────────────
    if (sentFolder) {
      const sent = await withDeadline(
        "listowanie folderu wysłanych",
        provider.listRecent({ limit: 10, since, folder: sentFolder }),
      );
      // Pusty folder wysłanych w oknie to fakt o skrzynce, nie usterka:
      // nikt nie musiał niczego wysłać w ostatnich N dniach. Sprawdzeniem
      // zdolności do CZYTANIA tego folderu jest samo udane listowanie —
      // brak wyjątku powyżej. Oznaczanie tego jako porażki uczyłoby
      // właściciela ignorować czerwone krzyżyki.
      record(
        "6. Czytanie folderu wysłanych",
        true,
        sent.length > 0
          ? `${sent.length} naszych wiadomości w "${sentFolder}"; najnowsza ${sent[0]!.date.slice(0, 16)}`
          : `folder "${sentFolder}" otwarty i odczytany, ale w oknie ${SINCE_DAYS} dni nic nie wysłano — ` +
              "wydłuż okno (--days 7), żeby to potwierdzić na danych",
        sent.length === 0,
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
    if (err instanceof StepTimeout) {
      // Po przekroczonym limicie stan połączenia IMAP jest niepewny: serwer może
      // dosłać odpowiedź na poprzednie polecenie w dowolnym momencie. Dalsze
      // sprawdzenia na tym samym połączeniu dałyby wynik, któremu nie można
      // ufać — więc przerywamy i mówimy, na czym stanęło.
      record("Przekroczony limit czasu", false, `${err.message}. Kolejne sprawdzenia pominięte, bo stan połączenia jest niepewny.`);
      process.stdout.write(
        "\n  Co sprawdzić:\n" +
          "    - to prawie zawsze SEARCH na dużym folderze bez indeksu pełnotekstowego,\n" +
          "    - zawęź okno: npm run check:mail -- --days 1\n" +
          `    - albo podnieś limit: CHECK_MAIL_STEP_TIMEOUT_MS=180000 npm run check:mail\n`,
      );
    } else {
      record("Nieoczekiwany błąd", false, msg(err));
    }
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
  // Idziemy po łańcuchu `cause`: bez tego widać tylko nasz własny komunikat
  // opakowujący, a nie to, co faktycznie powiedział serwer.
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth += 1) {
    const e = cur as { message?: string; cause?: unknown };
    if (e.message && !parts.includes(e.message)) parts.push(e.message);
    cur = e.cause;
  }
  const raw = parts.length > 0 ? parts.join("\n      ↳ ") : String(err);
  // Komunikat IMAP może zawierać nazwę konta — maskujemy adresy.
  return raw.replace(/[\w.+-]+@[\w.-]+/g, (m) => maskAddress(m));
}

main().then((code) => process.exit(code));
