#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { createApp } from "../index.js";
import { laneOf } from "../state/lanes.js";
import type { Issue } from "../state/types.js";

/**
 * UX SPIKE — jedna pilna sprawa, jedno kliknięcie, rozmowa o TEJ sprawie.
 *
 *   npm run pilne              # najpilniejsza otwarta sprawa
 *   npm run pilne -- spr_1a2b  # konkretna
 *
 * To NIE jest system powiadomień i nie ma nim zostać. To narzędzie do
 * rozstrzygnięcia jednego pytania: czy da się z powiadomienia trafić prosto
 * do rozmowy o konkretnej sprawie, bez kopiowania czegokolwiek.
 *
 * ── Co idzie do adresu, a co NIE ──────────────────────────────────────────────
 * W URL-u jest WYŁĄCZNIE identyfikator sprawy. Żadnego tematu, nadawcy, numeru
 * zamówienia ani streszczenia. Powody są dwa i oba praktyczne:
 *
 *  1. Adres trafia do historii przeglądarki, do logów systemu i bywa widoczny
 *     na ekranie blokady w powiadomieniu. Dane firmy nie mają tam czego szukać.
 *  2. Dane w URL-u są ZAMROŻONE w momencie kliknięcia. Sprawa mogła się zmienić
 *     przez ostatnią godzinę, a wtedy Claude mówiłby o stanie sprzed godziny
 *     z pełnym przekonaniem. Aktualny stan pobiera przez MCP, w momencie pytania.
 */

const MAX_URL_PROMPT = 2000;

const app = createApp();
const wskazany = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;

const issues = app.store.all().filter((i) => i.status !== "resolved" && !i.likelyIrrelevant);

const wybrana: Issue | null = wskazany
  ? app.store.get(wskazany)
  : (issues.filter((i) => laneOf(i) === "teraz").sort(najpierwNajnowsze)[0] ??
     issues.sort(najpierwNajnowsze)[0] ??
     null);

if (!wybrana) {
  process.stdout.write(
    wskazany
      ? `Nie ma sprawy o identyfikatorze ${wskazany}.\n`
      : "Nie ma ani jednej otwartej sprawy — uruchom najpierw `npm run monitor`.\n",
  );
  process.exit(1);
}

/**
 * Polecenie w URL-u. Minimalne i BEZ danych sprawy — patrz komentarz na górze.
 * Mówi Claude, co ma zrobić, a nie co ma powiedzieć.
 */
const polecenie =
  `Otwórz sprawę ${wybrana.id}. Pobierz jej aktualny kontekst przez BHT Copilot ` +
  `i zacznij od krótkiego podsumowania: co się stało, co jest potwierdzone ` +
  `i czego potrzebujesz ode mnie. Rozmawiaj wyłącznie o tej sprawie.`;

if (polecenie.length > MAX_URL_PROMPT) {
  // Nie może się zdarzyć przy identyfikatorze o stałej długości, ale gdyby
  // ktoś kiedyś wstawił tu treść sprawy — niech się wywali głośno.
  process.stderr.write(`Polecenie ma ${polecenie.length} znaków, limit to ${MAX_URL_PROMPT}.\n`);
  process.exit(1);
}

const q = encodeURIComponent(polecenie);
const LINK_APLIKACJA = `claude://claude.ai/new?q=${q}`;
const LINK_WWW = `https://claude.ai/new?q=${q}`;

// ── treść powiadomienia (§8) ──────────────────────────────────────────────────

const powod =
  wybrana.lastErpSummary && /NIE MA w TeaBrew/i.test(wybrana.lastErpSummary)
    ? "numeru z tej wiadomości nie ma w TeaBrew"
    : wybrana.notificationReason ?? wybrana.whyListed ?? "wymaga Twojej uwagi";

const tytul = `🔴 ${wybrana.title}`.slice(0, 120);
const tresc = `${jednymZdaniem(wybrana.summary)}\nDlaczego: ${powod}`;

process.stdout.write(
  `\n${tytul}\n${tresc}\n\n` +
    `  Sprawa:   ${wybrana.id}  (${laneOf(wybrana)})\n` +
    `  Źródła:   ${[...new Set(wybrana.sourceRefs.map((r) => r.kind))].join(" + ")}` +
    `${wybrana.lastErpSummary ? " + TeaBrew" : ""}\n\n` +
    `OTWÓRZ SPRAWĘ — kliknij jeden z tych adresów:\n\n` +
    `  aplikacja:  ${LINK_APLIKACJA}\n\n` +
    `  przeglądarka/telefon:  ${LINK_WWW}\n\n` +
    `W adresie jest TYLKO identyfikator sprawy. Żadnych danych firmy —\n` +
    `aktualny stan Claude pobiera przez MCP w momencie pytania.\n\n`,
);

// ── powiadomienie systemowe (macOS) ───────────────────────────────────────────
/**
 * Najbliższe docelowemu pushowi, co da się zrobić bez budowania systemu
 * powiadomień. Świadome ograniczenie: `display notification` w AppleScript NIE
 * potrafi otworzyć adresu po kliknięciu — kliknięcie budzi aplikację, która je
 * wysłała. Dlatego adres jest wypisany wyżej w terminalu i to jego się klika.
 *
 * To jest dokładnie ta różnica, którą spike ma zmierzyć, więc nie udaję, że
 * powiadomienie robi więcej, niż robi.
 */
if (process.platform === "darwin" && !process.argv.includes("--bez-powiadomienia")) {
  try {
    execFileSync(
      "/usr/bin/osascript",
      ["-e", 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv) sound name "Ping"\nend run', tytul, tresc.replace(/\n/g, " · ")],
      { stdio: "ignore" },
    );
    process.stdout.write("Powiadomienie systemowe wysłane.\n\n");
  } catch {
    process.stdout.write("Powiadomienia systemowego nie udało się wysłać (to nie psuje testu).\n\n");
  }
}

process.stdout.write(
  `Do zmierzenia w tym teście:\n` +
    `  1. Ile czynności od kliknięcia do rozmowy o TEJ sprawie.\n` +
    `  2. Czy polecenie wysyła się samo, czy trzeba nacisnąć wyślij.\n` +
    `  3. Czy Claude faktycznie sięgnął po sprawę, czy zaczął zgadywać.\n\n`,
);

await app.close();

function najpierwNajnowsze(a: Issue, b: Issue): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

function jednymZdaniem(s: string): string {
  const czyste = s.replace(/\s+/g, " ").trim();
  return czyste.length > 160 ? `${czyste.slice(0, 160)}…` : czyste || "(brak podglądu treści)";
}
