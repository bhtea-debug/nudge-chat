import { isOwnOrderShape } from "./order-refs.js";
import type { Issue } from "./types.js";

/**
 * Do której grupy należy sprawa.
 *
 * ── Dlaczego to jest tutaj, a nie w Claude ────────────────────────────────────
 * Przez chwilę był to moduł UI rysujący sekcje na stronie. Strona została
 * usunięta — całym interfejsem jest Claude — ale sam podział **musi zostać po
 * naszej stronie** i to nie jest niechęć do oddania roboty modelowi:
 *
 *  - dwa pytania o to samo („co pilnego", „co mam na głowie") mają dać ten sam
 *    układ. Gdyby grupowanie liczył model za każdym razem od nowa, właściciel
 *    dostawałby raz trzy sekcje, raz cztery, i przestałby im wierzyć,
 *  - grupa wynika z FAKTÓW (numer nieznany TeaBrew, priorytet, status
 *    oznaczony przez właściciela), więc nie ma tu czego interpretować,
 *  - właściciel ma móc powiedzieć „to nie powinno być w TERAZ" i dostać zmianę
 *    jednej reguły z testem, a nie negocjację z promptem.
 *
 * Claude ma prawo tę grupę nadpisać, gdy z TREŚCI wynika co innego — po to
 * dostaje `whyListed` obok. Ale wtedy niech powie, że to jego ocena.
 */

export type Lane = "teraz" | "decyzje" | "odpowiedzi" | "obserwuj" | "prawdopodobnie_nieistotne";

/**
 * Czy TeaBrew powiedział, że numeru z wiadomości u niego nie ma.
 *
 * Warunek jest DWUCZĘŚCIOWY i drugi człon jest tu z bolesnego powodu.
 *
 * `lastErpSummary` to zdanie zapisane w momencie sprawdzenia i nikt go potem nie
 * weryfikuje. Sprawa założona przez starszą wersję rozpoznawania numerów mogła
 * dostać takie zdanie o numerze, który dziś w ogóle nie kwalifikuje się do
 * pytania TeaBrew — i wtedy siedzi na szczycie „Teraz" BEZ KOŃCA, bo nic tego
 * zdania nie unieważnia.
 *
 * Zdarzyło się to naprawdę: awizo InPostu z 24-cyfrowym numerem przesyłki
 * i NIP-em w temacie wylądowało jako najpilniejsza sprawa w firmie, długo po
 * tym, jak oba te fałszywe alarmy zostały naprawione w `order-refs.ts`.
 *
 * Dlatego twierdzenie „nie ma tego w TeaBrew" musi być poparte AKTUALNYM
 * numerem o kształcie naszego numeru zamówienia. Bez niego jest to zdanie
 * o czymś, o co dziś w ogóle byśmy nie zapytali — i nie ma prawa windować
 * priorytetu. Ta sama zasada, co w kontroli dowodów: twierdzenie bez pokrycia
 * jest gorsze niż brak twierdzenia.
 */
export function missingInErp(issue: Issue): boolean {
  if (!/NIE MA w TeaBrew/i.test(issue.lastErpSummary ?? "")) return false;
  return issue.relatedOrderRefs.some(isOwnOrderShape);
}

/**
 * TERAZ — sprawy, przy których czekanie ma koszt. Trzy warunki, każdy z faktu:
 * klient pisze o zamówieniu, którego nie ma w systemie; priorytet wysoki;
 * sprawa uznana za wartą powiadomienia.
 */
export function isNow(issue: Issue): boolean {
  // Wysłanka masowa nie wchodzi do TERAZ nawet z wysokim priorytetem — inaczej
  // jeden newsletter z natrętnym tematem zająłby najważniejsze miejsce.
  if (issue.likelyIrrelevant) return false;
  return missingInErp(issue) || issue.priority === "high" || issue.notificationCandidate;
}

/**
 * Grupa dla JEDNEJ sprawy. Kolejność warunków jest pierwszeństwem.
 *
 * Ostatnia gałąź jest workiem na wszystko, co nie trafiło wyżej — także na
 * kategorie, których dziś nie przewidujemy. Sprawa bez grupy byłaby sprawą,
 * której właściciel nigdzie nie zobaczy, a to najgorszy możliwy błąd tej funkcji.
 */
export function laneOf(issue: Issue): Lane {
  if (issue.likelyIrrelevant) return "prawdopodobnie_nieistotne";
  if (isNow(issue)) return "teraz";
  if (issue.status === "waiting_for_owner" || issue.category === "decision") return "decyzje";
  if (issue.category === "reply" || issue.category === "urgent") return "odpowiedzi";
  return "obserwuj";
}

export const LANE_ORDER: readonly Lane[] = [
  "teraz",
  "decyzje",
  "odpowiedzi",
  "obserwuj",
  "prawdopodobnie_nieistotne",
];

/**
 * Ile spraw w której grupie — żeby Claude mógł zacząć odpowiedź jednym zdaniem
 * o całości, zamiast wyliczać wszystko i dopiero na końcu podsumować.
 */
export function laneCounts(issues: readonly Issue[]): Record<Lane, number> {
  const counts: Record<Lane, number> = {
    teraz: 0,
    decyzje: 0,
    odpowiedzi: 0,
    obserwuj: 0,
    prawdopodobnie_nieistotne: 0,
  };
  for (const i of issues) counts[laneOf(i)] += 1;
  return counts;
}
