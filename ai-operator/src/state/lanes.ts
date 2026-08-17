import { findOrderRefs, isOwnOrderShape } from "./order-refs.js";
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
 * Dlatego twierdzenie „nie ma tego w TeaBrew" musi być poparte numerem, który
 * DZISIEJSZE reguły znajdują w tekście tej sprawy — patrz `currentOwnOrderRefs`.
 * Bez niego jest to zdanie o czymś, o co dziś w ogóle byśmy nie zapytali,
 * i nie ma prawa windować priorytetu. Ta sama zasada, co w kontroli dowodów:
 * twierdzenie bez pokrycia jest gorsze niż brak twierdzenia.
 */
export function missingInErp(issue: Issue): boolean {
  if (!/NIE MA w TeaBrew/i.test(issue.lastErpSummary ?? "")) return false;
  return currentOwnOrderRefs(issue).length > 0;
}

/**
 * Numery zamówień policzone OD NOWA, dzisiejszymi regułami, z tekstu sprawy.
 *
 * Świadomie NIE patrzymy na `relatedOrderRefs`. Pierwsza wersja tej kontroli
 * sprawdzała kształt zapisanych numerów i nie zadziałała — bo w tej samej
 * sprawie z awizem InPostu siedział NIP `8842745578`, a dziesięć cyfr to
 * poprawny kształt naszego numeru zamówienia. Kontrola kształtu nie odróżni
 * numeru, którego dziś byśmy nie wyciągnęli, od takiego, który byśmy wyciągnęli.
 *
 * Odróżnia to dopiero ponowne rozpoznanie: dzisiejszy `findOrderRefs` odrzuca
 * NIP po sąsiadującym słowie kluczowym, a numer przesyłki po długości. Jeśli na
 * tym samym tekście nie znajduje dziś nic naszego, to znaczy, że twierdzenie
 * TeaBrew dotyczyło czegoś, o co byśmy dziś nie zapytali.
 *
 * Tekst bierzemy z `title` i `summary`, bo to dokładnie to samo, na czym
 * pracował monitor przy zakładaniu sprawy (nadawca + temat, podgląd treści).
 * Dzięki temu stan leczy się sam przy każdej poprawce rozpoznawania numerów,
 * bez migracji dziennika.
 */
export function currentOwnOrderRefs(issue: Issue): string[] {
  const znalezione = [...findOrderRefs(issue.title), ...findOrderRefs(issue.summary)];
  return [
    ...new Set(
      znalezione
        .filter((f) => f.why !== "prefiks")
        .map((f) => f.ref)
        .filter(isOwnOrderShape),
    ),
  ];
}

/**
 * TERAZ — sprawy, przy których czekanie ma koszt. Trzy warunki, każdy z faktu:
 * klient pisze o zamówieniu, którego nie ma w systemie; priorytet wysoki;
 * sprawa uznana za wartą powiadomienia.
 */
export function isNow(issue: Issue): boolean {
  return whyNow(issue) !== null;
}

/**
 * DLACZEGO sprawa jest w TERAZ, albo `null`, gdy nie jest.
 *
 * Jedna funkcja zwraca i decyzję, i jej uzasadnienie — celowo. Wcześniej
 * `isNow` decydowało o grupie, a powiadomienie budowało własne zdanie
 * z surowego `lastErpSummary`. Dwa źródła prawdy o tym samym rozjechały się
 * dokładnie tak, jak musiały: sprawa przestała kwalifikować się przez TeaBrew,
 * a powiadomienie dalej pisało „numeru nie ma w TeaBrew", bo testowało tekst
 * po swojemu. Powód i decyzja mają odtąd jedno źródło.
 */
export function whyNow(issue: Issue): string | null {
  // Wysyłka masowa nie wchodzi do TERAZ nawet z wysokim priorytetem — inaczej
  // jeden newsletter z natrętnym tematem zająłby najważniejsze miejsce.
  if (issue.likelyIrrelevant) return null;

  if (missingInErp(issue)) {
    const refs = currentOwnOrderRefs(issue);
    return `numeru ${refs.join(", ")} nie ma w TeaBrew`;
  }

  /**
   * Unieważnienie CAŁEGO przebiegu, nie samego zdania.
   *
   * Trzy poprawki tej funkcji poszły na to samo awizo InPostu i dwie pierwsze
   * nie zadziałały, bo naprawiałem po jednym polu naraz. Sedno jest takie:
   * gdy monitor uznał, że numeru nie ma w TeaBrew, ustawił w jednym przebiegu
   * kilka rzeczy naraz — `lastErpSummary`, wysoki priorytet i „warte
   * powiadomienia". Odebranie wiary jednemu z tych pól, a zostawienie
   * pozostałych, nie zmienia nic: sprawa dalej stoi na górze, tylko z innym
   * uzasadnieniem.
   *
   * Dlatego: jeśli twierdzenie ERP z tamtego przebiegu jest dziś niepoparte
   * (numer, o który wtedy pytaliśmy, nie jest już przez nas rozpoznawany), to
   * NIC z tamtego przebiegu nie windują sprawy. Sprawa zostaje w pamięci
   * i w niższej grupie — nie znika, tylko przestaje udawać najpilniejszą.
   */
  const bylTwierdzeniemErp = /NIE MA w TeaBrew/i.test(issue.lastErpSummary ?? "");
  if (bylTwierdzeniemErp) return null;

  if (issue.priority === "high") return "wysoki priorytet";
  if (issue.notificationCandidate) {
    return issue.notificationReason ?? "uznane za warte powiadomienia";
  }
  return null;
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

  /**
   * DECYZJE to wyłącznie kategoria `decision`, a NIE status `waiting_for_owner`.
   *
   * Te dwie rzeczy nazywają się podobnie i znaczą co innego. Monitor ustawia
   * `waiting_for_owner` każdej wiadomości kategorii `reply` — w sensie „ktoś
   * czeka na naszą odpowiedź". Sekcja DECYZJE ma znaczyć „to wymaga mojego
   * rozstrzygnięcia", a nie „trzeba odpisać".
   *
   * Zlanie ich w jedno robiło z DECYZJI drugą kopię ODPOWIEDZI i wpychało tam
   * rzeczy, przy których nie ma czego decydować — łącznie z wiadomością
   * phishingową, która trafiła na szczyt listy.
   */
  if (issue.category === "decision") return "decyzje";
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
