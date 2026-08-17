import type { Issue } from "../state/types.js";

/**
 * Podział spraw na sekcje ekranu głównego (§4).
 *
 * To jest najważniejsza decyzja produktowa w całym UI: właściciel patrzy na ten
 * ekran kilkadziesiąt razy dziennie i sekcja, w której coś wyląduje, decyduje,
 * czy to zobaczy w ciągu minuty, czy wieczorem.
 *
 * Dlatego reguły są tu, osobno od rysowania HTML-a: właściciel powie „to nie
 * powinno być w TERAZ", a poprawka będzie dotyczyć jednej funkcji z testem, nie
 * szablonu strony.
 *
 * ── Uczciwa uwaga o DECYZJACH ────────────────────────────────────────────────
 * Klasyfikator deterministyczny NIE potrafi wystawić kategorii `decision` — do
 * rozpoznania „to wymaga Twojej decyzji" trzeba zrozumieć treść, a treści nie
 * przeformułowujemy (§17: zero kredytów). Sekcja DECYZJE zapełnia się więc
 * z dwóch źródeł: statusu `waiting_for_owner` i ręcznego oznaczenia przez
 * właściciela w UI. Puste sekcje nie są rysowane — udawana rubryka, która nigdy
 * nic nie zawiera, uczy ignorować cały ekran.
 */

export type LaneId = "teraz" | "decyzje" | "odpowiedzi" | "obserwuj" | "szum";

export interface Lane {
  readonly id: LaneId;
  readonly icon: string;
  readonly title: string;
  /** Zdanie wyjaśniające, po co ta sekcja istnieje. Widoczne, gdy sekcja jest pusta. */
  readonly hint: string;
  readonly issues: readonly Issue[];
}

/** Czy TeaBrew powiedział, że numeru z wiadomości u niego nie ma. */
export function missingInErp(issue: Issue): boolean {
  return /NIE MA w TeaBrew/i.test(issue.lastErpSummary ?? "");
}

/**
 * TERAZ — sprawy, przy których czekanie ma koszt.
 *
 * Trzy warunki, każdy z faktu, nie z oceny treści:
 *  - klient pisze o zamówieniu, którego NIE MA w systemie (ktoś go nie wprowadził),
 *  - priorytet wysoki,
 *  - sprawa została uznana za wartą powiadomienia na telefon.
 */
export function isNow(issue: Issue): boolean {
  if (issue.likelyIrrelevant) return false;
  return missingInErp(issue) || issue.priority === "high" || issue.notificationCandidate;
}

export function assignLanes(issues: readonly Issue[]): Lane[] {
  const open = issues.filter((i) => i.status !== "resolved");

  const szum = open.filter((i) => i.likelyIrrelevant);
  const rest = open.filter((i) => !i.likelyIrrelevant);

  const teraz = rest.filter(isNow);
  const taken = new Set(teraz.map((i) => i.id));

  const decyzje = rest.filter(
    (i) => !taken.has(i.id) && (i.status === "waiting_for_owner" || i.category === "decision"),
  );
  for (const i of decyzje) taken.add(i.id);

  const odpowiedzi = rest.filter(
    (i) => !taken.has(i.id) && (i.category === "reply" || i.category === "urgent"),
  );
  for (const i of odpowiedzi) taken.add(i.id);

  // Wszystko, co zostało, trafia tutaj — także kategorie, których dziś nie
  // przewidujemy. Sprawa, która wypadłaby ze WSZYSTKICH sekcji, byłaby ukryta,
  // a to najgorszy możliwy błąd tego ekranu.
  const obserwuj = rest.filter((i) => !taken.has(i.id));

  return [
    {
      id: "teraz",
      icon: "🔴",
      title: "Teraz",
      hint: "Sprawy, przy których czekanie ma koszt: numer, którego nie ma w TeaBrew, albo wysoki priorytet.",
      issues: teraz,
    },
    {
      id: "decyzje",
      icon: "🟠",
      title: "Decyzje",
      hint: "Sprawy odłożone jako „wymaga mojej decyzji”. Trafiają tu, gdy sam je tak oznaczysz.",
      issues: decyzje,
    },
    {
      id: "odpowiedzi",
      icon: "🟡",
      title: "Odpowiedzi",
      hint: "Ktoś napisał i czeka na reakcję.",
      issues: odpowiedzi,
    },
    {
      id: "obserwuj",
      icon: "👀",
      title: "Obserwuj",
      hint: "Ważne, ale nic nie wymaga działania w tej chwili.",
      issues: obserwuj,
    },
    {
      id: "szum",
      icon: "📭",
      title: "Prawdopodobnie nieistotne",
      hint: "Nadawcy, z którymi nigdy nie korespondowaliśmy, bez numeru zamówienia i bez wątku. Nic nie jest usuwane.",
      issues: szum,
    },
  ];
}

export interface HeadStatus {
  readonly open: number;
  readonly needAttention: number;
  readonly changed: number;
}

/**
 * Trzy liczby pod nagłówkiem (§4).
 *
 * „Zmieniły się od ostatniej wizyty" liczymy tym samym warunkiem, co delta dla
 * Claude: sprawa nigdy nie pokazana albo zmieniona PO pokazaniu. Gdyby te dwa
 * liczniki rozjechały się, właściciel dostałby dwie różne prawdy o tym samym
 * stanie — raz na ekranie, raz w rozmowie.
 */
export function headStatus(issues: readonly Issue[]): HeadStatus {
  const open = issues.filter((i) => i.status !== "resolved" && !i.likelyIrrelevant);
  return {
    open: open.length,
    needAttention: open.filter(isNow).length,
    changed: open.filter((i) => i.lastPresentedAt === null || i.updatedAt > i.lastPresentedAt).length,
  };
}
