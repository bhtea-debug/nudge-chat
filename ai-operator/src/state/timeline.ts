import { SOURCE_LABEL, viewRef } from "./source-ref.js";
import type { Issue } from "./types.js";

/**
 * Chronologia źródeł jednej sprawy (§15).
 *
 * To jest ten element, który daje właścicielowi coś, czego nie da mu żadna
 * z osobnych aplikacji: jeden ciąg zdarzeń z poczty, czatu i systemu
 * operacyjnego, uporządkowany czasem.
 *
 * Jedna zasada trzyma ten plik w ryzach: **wpis powstaje tylko z faktu, który ma
 * własny znacznik czasu.** Nie dokładam pozycji „odpowiedzieliśmy", choć wiem
 * z flagi IMAP `\Answered`, że odpowiedź poszła — bo NIE WIEM KIEDY, a wstawienie
 * jej w zgadniętym miejscu przestawiłoby kolejność zdarzeń i zmieniło wnioski.
 * Ta informacja jest w stanie sprawy („na co czekamy"), nie w chronologii.
 */

/**
 * Rodzaj wpisu. Rozróżnienie nie jest kosmetyczne — od niego zależy, co znaczy
 * „ostatnio coś przyszło".
 *
 *  - `komunikacja` — ktoś z zewnątrz albo z firmy coś napisał. TYLKO to jest
 *    zdarzeniem, na które można odpowiedzieć.
 *  - `system` — nasz własny odczyt stanu z TeaBrew. Nic nie „przyszło": to my
 *    zapytaliśmy. Pierwsza wersja mieszała to z komunikacją i ekran sprawy
 *    pokazywał to samo zdanie o TeaBrew trzy razy, raz jako „co przyszło
 *    ostatnio" — czyli nieprawdę o tym, kto się ruszył.
 *  - `wlasne` — działanie właściciela.
 */
export type EntryKind = "komunikacja" | "system" | "wlasne";

export interface TimelineEntry {
  readonly at: string;
  /** Etykieta systemu w języku właściciela: „E-mail", „Connecteam", „TeaBrew". */
  readonly source: string;
  /** Kto/co — nadawca, autor, albo nazwa systemu. */
  readonly who: string;
  /** Jedno zdanie: co się wtedy stało. */
  readonly what: string;
  readonly kind: EntryKind;
  /**
   * Czy to wpis o NASZYM działaniu. UI odsuwa je wizualnie, bo mieszanie
   * „co przyszło" z „co zrobiłem" utrudnia odpowiedź na pytanie „czy ktoś czeka".
   */
  readonly own: boolean;
}

/** Ostatnia rzecz, która FAKTYCZNIE przyszła z zewnątrz. `null`, gdy nic. */
export function lastIncoming(entries: readonly TimelineEntry[]): TimelineEntry | null {
  return entries.filter((e) => e.kind === "komunikacja").at(-1) ?? null;
}

export function buildTimeline(issue: Issue): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const ref of issue.sourceRefs) {
    const v = viewRef(ref);
    // Dla czatu nazwa kanału idzie do etykiety źródła, nie do treści wpisu.
    // Inaczej wychodziło „Ania — Produkcja — nie mamy etykiet", czyli nazwa
    // kanału wciśnięta między autora i to, co napisał. Widać to dopiero na
    // prawdziwym wyjściu, nie w teście na obecność pól.
    const kanal = v.kind !== "mail" && v.heading ? ` · ${v.heading}` : "";
    entries.push({
      at: v.date,
      source: `${SOURCE_LABEL[v.kind]}${kanal}`,
      who: v.author ?? "nieznany nadawca",
      what: v.kind !== "mail" ? describeRef("", v.preview) : describeRef(v.heading, v.preview),
      kind: "komunikacja",
      own: false,
    });
  }

  // TeaBrew nie przysyła wiadomości — to obserwacja stanu, którą zrobiliśmy my
  // w konkretnym momencie. Dlatego jedna pozycja z czasem dowodu, a nie
  // udawana „wiadomość z systemu".
  if (issue.lastEvidenceAt && issue.lastErpSummary) {
    entries.push({
      at: issue.lastEvidenceAt,
      source: "TeaBrew",
      who: "system",
      what: issue.lastErpSummary,
      kind: "system",
      own: false,
    });
  }

  // Działania właściciela mają prawdziwe znaczniki czasu, więc mogą stać
  // w chronologii. Wpisy monitora — nie: „utworzona z wiadomości X" jest
  // duplikatem pozycji o tej wiadomości i tylko zaśmieca.
  for (const h of issue.history) {
    if (h.by !== "wlasciciel") continue;
    entries.push({ at: h.at, source: "Ty", who: "Ty", what: h.what, kind: "wlasne", own: true });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

function describeRef(heading: string, preview: string): string {
  const head = heading.trim();
  const body = preview.trim();
  if (head && body) return `${head} — ${body}`;
  if (head) return head;
  if (body) return body;
  return "(brak treści po stronie źródła)";
}

/**
 * Czy ta sprawa ma więcej niż jedno źródło. Używane w UI do pokazania, że
 * informacja jest zszyta z kilku systemów — bo to jest główna wartość produktu
 * i musi być widoczna bez czytania szczegółów.
 */
export function sourceSummary(issue: Issue): string {
  const kinds = [...new Set(issue.sourceRefs.map((r) => viewRef(r).kind))];
  const labels = kinds.map((k) => SOURCE_LABEL[k]);
  if (issue.lastErpSummary) labels.push("TeaBrew");
  return labels.join(" + ");
}
