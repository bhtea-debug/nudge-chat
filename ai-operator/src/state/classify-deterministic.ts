import type { MailMessage } from "../mail/types.js";
import { findOrderRefs } from "./order-refs.js";
import type { IssueCategory, IssuePriority } from "./types.js";

/**
 * Klasyfikacja BEZ modelu — wyłącznie fakty z wiadomości.
 *
 * Powstało, bo właściciel nie chce płacić za kredyty API, a jego własna zasada
 * brzmi: reasoning robi Claude, nasza infrastruktura nie woła drugiego modelu.
 * Monitor w tle był jedynym miejscem, które tę zasadę naruszało.
 *
 * Podział obowiązków, który z tego wynika, jest zdrowszy niż poprzedni:
 *
 *  - **my dostarczamy FAKTY**: kto napisał, w jakiej sprawie, jakie numery
 *    wymienił, co o tych numerach mówi TeaBrew, czy już odpowiedzieliśmy,
 *  - **Claude dostarcza OCENĘ**, w momencie gdy właściciel pyta — i robi to na
 *    swojej subskrypcji, bez naszego rachunku.
 *
 * Dlatego tytuł i streszczenie NIE są tu generowane. Tytuł to nadawca i temat,
 * streszczenie to podgląd treści, który i tak przyszedł z serwera. Nic nie jest
 * przeformułowane, więc nie ma czego zmyślić.
 *
 * Kategoria i priorytet są HEURYSTYKĄ i sprawa niesie tę informację o sobie
 * (`classifier: "deterministic"`), żeby Claude wiedział, że to słaby sygnał,
 * a nie ocena — i mógł ją nadpisać własnym rozumowaniem.
 */

export interface DeterministicVerdict {
  readonly title: string;
  readonly summary: string;
  readonly category: IssueCategory;
  readonly priority: IssuePriority;
  readonly orderRefs: string[];
  /**
   * Podzbiór `orderRefs`, który warto sprawdzać w TeaBrew i który może podnieść
   * priorytet. Nie ma tu numerów rozpoznanych po PREFIKSIE literowym
   * (`RB-2026-118`), bo taki zapis to zwykle numeracja KONTRAHENTA, nie nasza —
   * jego nieobecność w TeaBrew jest oczekiwana i alarmowanie nią byłoby szumem.
   */
  readonly refsForErp: string[];
  readonly waitingFor: string | null;
  /** Kto jest adresatem: czy pisano DO nas, czy tylko w kopii. */
  readonly directlyAddressed: boolean;
}

/** Ile znaków podglądu wchodzi do streszczenia. Reszta jest w poczcie. */
const SUMMARY_LIMIT = 400;

const senderOf = (msg: MailMessage): string =>
  msg.from?.name?.trim() || msg.from?.address || "nieznany nadawca";

/**
 * Czy wiadomość była skierowana do nas, czy tylko dostaliśmy kopię.
 *
 * Rozróżnienie ma znaczenie operacyjne: na maila w kopii zwykle nikt nie czeka.
 * Bez adresu własnej skrzynki nie zgadujemy — wtedy traktujemy jak skierowany,
 * bo pominięcie prawdziwego pytania klienta jest gorsze niż jedna sprawa więcej.
 */
function isDirect(msg: MailMessage, ownAddress: string | null): boolean {
  if (!ownAddress) return true;
  const own = ownAddress.toLowerCase();
  return msg.to.some((a) => a.address.toLowerCase() === own);
}

export function classifyDeterministic(
  msg: MailMessage,
  opts: { ownAddress?: string | null } = {},
): DeterministicVerdict {
  const found = [...findOrderRefs(msg.subject), ...findOrderRefs(msg.snippet).slice(0, 3)];
  const orderRefs = [...new Set(found.map((f) => f.ref))];
  const refsForErp = [
    ...new Set(found.filter((f) => f.why !== "prefiks").map((f) => f.ref)),
  ];
  const direct = isDirect(msg, opts.ownAddress ?? null);

  // Kategoria z FAKTÓW, nie z rozumienia treści:
  //  - nieodpowiedziana wiadomość skierowana do nas = ktoś czeka („reply"),
  //  - wiadomość w kopii albo już odpowiedziana = do obserwacji („monitor").
  // Świadomie NIE zgadujemy „urgent" po słowach w temacie: „pilne" w temacie
  // pisze też każdy automat marketingowy, a pomyłka w drugą stronę (uznanie
  // reklamacji za informację) jest znacznie kosztowniejsza niż brak etykiety.
  const category: IssueCategory = msg.answered ? "monitor" : direct ? "reply" : "informational";

  const waitingFor = msg.answered
    ? "odpowiedzieliśmy — czekamy na ruch po drugiej stronie"
    : direct
      ? "wiadomość bez odpowiedzi z naszej strony"
      : null;

  const snippet = msg.snippet.trim();
  const summary =
    snippet.length > SUMMARY_LIMIT ? `${snippet.slice(0, SUMMARY_LIMIT)}…` : snippet || "(brak podglądu treści)";

  return {
    title: `${senderOf(msg)} — ${msg.subject}`,
    summary,
    category,
    // Priorytet podnosi wyłącznie FAKT, nie wrażenie. Ustawia go monitor po
    // sprawdzeniu numeru w TeaBrew — tutaj startujemy neutralnie.
    priority: "normal",
    orderRefs,
    refsForErp,
    waitingFor,
    directlyAddressed: direct,
  };
}

/**
 * Czy ta wiadomość zasługuje na sprawę, gdy nie ma modelu do oceny.
 *
 * Bez rozumienia treści nie da się rzetelnie stwierdzić „to nie wymaga
 * działania". Dlatego progiem jest FAKT, nie domysł: sprawę zakłada wiadomość
 * skierowana do nas albo taka, która wymienia numer zamówienia. Reszta zostaje
 * odnotowana jako widziana i nie zaśmieca listy.
 *
 * Ta granica jest celowo szeroka po stronie zakładania spraw. Sprawa, na którą
 * właściciel spojrzy i wzruszy ramionami, kosztuje sekundę; przeoczone pytanie
 * klienta kosztuje klienta.
 */
export function deservesIssue(v: DeterministicVerdict): boolean {
  return v.directlyAddressed || v.orderRefs.length > 0;
}
