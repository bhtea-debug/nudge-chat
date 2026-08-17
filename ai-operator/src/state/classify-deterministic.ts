import type { MailMessage } from "../mail/types.js";
import { findOrderRefs, isOwnOrderShape } from "./order-refs.js";
import type { IssueCategory, IssuePriority } from "./types.js";

/**
 * Klasyfikacja BEZ modelu — z faktów, ale Z UZASADNIENIEM.
 *
 * Pierwsza wersja zbierała fakty i na tym poprzestawała. Właściciel ocenił to
 * jednym zdaniem: „mało potrzebny ten raport, nie rozdziela spamu od wiadomości,
 * nie ma priorytetów, opisów, wyjaśnienia". Miał rację — lista faktów bez
 * uzasadnienia zmusza go do otwarcia każdej pozycji, czyli do wykonania
 * dokładnie tej pracy, którą miał zdjąć z siebie.
 *
 * Trzy z czterech zarzutów da się naprawić bez modelu. Kluczem jest sygnał,
 * którego wcześniej nie używałem: **czy kiedykolwiek pisaliśmy do tej domeny.**
 * To wynika z NASZEGO działania (folder wysłanych), więc jest mocniejsze niż
 * jakakolwiek heurystyka po treści — i nie da się tego podrobić newsletterem.
 *
 * Czego nadal NIE MA i nie da się mieć bez modelu: streszczenia własnymi
 * słowami. Opis to podgląd treści, który przyszedł z serwera — dosłownie, bez
 * przeformułowania. Dzięki temu nie ma czego zmyślić, ale też nie ma skrótu.
 */

export interface Signals {
  /** Pisaliśmy kiedyś do tej domeny (z folderu wysłanych). */
  readonly knownSender: boolean;
  /** Wiadomość jest odpowiedzią w istniejącej korespondencji. */
  readonly inThread: boolean;
  /** Jest numer o kształcie naszego numeru zamówienia. */
  readonly hasOrderRef: boolean;
  /** Odpowiedzieliśmy już na to (flaga IMAP \\Answered). */
  readonly answered: boolean;
  /** Napisano DO nas, nie tylko w kopii. */
  readonly direct: boolean;
  /**
   * Czy sygnał „znany nadawca" jest w ogóle dostępny. Bez skanu folderu
   * wysłanych NIE WOLNO wnioskować „nieznany" — brak wiedzy to nie brak relacji.
   */
  readonly senderHistoryAvailable: boolean;
}

export interface DeterministicVerdict {
  readonly title: string;
  readonly summary: string;
  readonly category: IssueCategory;
  readonly priority: IssuePriority;
  readonly orderRefs: string[];
  /** Numery, które wolno sprawdzać w TeaBrew i którymi wolno alarmować. */
  readonly refsForErp: string[];
  readonly waitingFor: string | null;
  /** Zdanie odpowiadające na „dlaczego to jest na liście i dlaczego taki priorytet". */
  readonly whyListed: string;
  /** Prawdopodobnie nie korespondencja. NIE usuwamy — pokazujemy osobno. */
  readonly likelyIrrelevant: boolean;
  readonly signals: Signals;
}

/** Ile znaków podglądu wchodzi do opisu. Reszta jest w poczcie. */
const SUMMARY_LIMIT = 400;

const senderOf = (msg: MailMessage): string =>
  msg.from?.name?.trim() || msg.from?.address || "nieznany nadawca";

export const domainOf = (address: string | null | undefined): string | null => {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : null;
};

export function classifyDeterministic(
  msg: MailMessage,
  opts: {
    /** Czy pisaliśmy do tej domeny. `null` = nie wiemy (brak skanu wysłanych). */
    isKnownDomain?: ((domain: string | null) => boolean) | null;
    ownAddress?: string | null;
  } = {},
): DeterministicVerdict {
  const found = [...findOrderRefs(msg.subject), ...findOrderRefs(msg.snippet).slice(0, 3)];
  const orderRefs = [...new Set(found.map((f) => f.ref))];
  const refsForErp = [...new Set(found.filter((f) => f.why !== "prefiks").map((f) => f.ref))];

  const domain = domainOf(msg.from?.address);
  const own = opts.ownAddress?.toLowerCase() ?? null;

  const signals: Signals = {
    senderHistoryAvailable: opts.isKnownDomain != null,
    knownSender: opts.isKnownDomain ? opts.isKnownDomain(domain) : false,
    inThread: msg.references.length > 0 || msg.inReplyTo !== null,
    hasOrderRef: refsForErp.some(isOwnOrderShape),
    answered: msg.answered,
    direct: own === null ? true : msg.to.some((a) => a.address.toLowerCase() === own),
  };

  const { priority, category, whyListed, likelyIrrelevant } = judge(signals, refsForErp, domain);

  const snippet = msg.snippet.trim();
  return {
    title: `${senderOf(msg)} — ${msg.subject}`,
    summary:
      snippet.length > SUMMARY_LIMIT
        ? `${snippet.slice(0, SUMMARY_LIMIT)}…`
        : snippet || "(serwer nie zwrócił podglądu treści — otwórz wątek)",
    category,
    priority,
    orderRefs,
    refsForErp,
    waitingFor: signals.answered
      ? "odpowiedzieliśmy — ruch po drugiej stronie"
      : signals.direct
        ? "brak odpowiedzi z naszej strony"
        : null,
    whyListed,
    likelyIrrelevant,
    signals,
  };
}

/**
 * Reguły priorytetu. Każda opiera się na FAKCIE i każda niesie swoje
 * uzasadnienie — żeby właściciel mógł się z konkretną regułą nie zgodzić,
 * zamiast odrzucać cały mechanizm.
 *
 * Kolejność ma znaczenie: pierwsza dopasowana reguła wygrywa.
 */
function judge(
  s: Signals,
  refsForErp: readonly string[],
  domain: string | null,
): {
  priority: IssuePriority;
  category: IssueCategory;
  whyListed: string;
  likelyIrrelevant: boolean;
} {
  const ownRefs = refsForErp.filter(isOwnOrderShape);

  // 1. Numer zamówienia w wiadomości. Najmocniejszy sygnał operacyjny, jaki da
  //    się wyciągnąć bez rozumienia treści. Priorytet podniesie do wysokiego
  //    dopiero sprawdzenie w TeaBrew, jeśli numeru tam nie ma.
  if (s.hasOrderRef) {
    return {
      priority: "normal",
      category: s.answered ? "monitor" : "reply",
      whyListed: `w wiadomości jest numer zamówienia ${ownRefs.join(", ")}`,
      likelyIrrelevant: false,
    };
  }

  // 2. Odpowiedź w trwającej korespondencji. Ktoś kontynuuje rozmowę, więc
  //    ktoś na coś czeka — nawet jeśli nie wiemy, na co.
  if (s.inThread) {
    return {
      priority: s.answered ? "low" : "normal",
      category: s.answered ? "monitor" : "reply",
      whyListed: s.answered
        ? "trwająca korespondencja, już odpowiedzieliśmy"
        : "odpowiedź w trwającej korespondencji, my jeszcze nie odpisaliśmy",
      likelyIrrelevant: false,
    };
  }

  // 3. Znany kontrahent: pisaliśmy do tej domeny. To nasze własne działanie,
  //    więc nie da się tego podrobić wysyłką masową.
  if (s.knownSender) {
    return {
      priority: s.answered ? "low" : "normal",
      category: s.answered ? "monitor" : "reply",
      whyListed: `piszemy z tym kontrahentem (${domain}), ale to nowy wątek`,
      likelyIrrelevant: false,
    };
  }

  // 4. Nie wiemy nic. Bez historii wysłanych NIE WOLNO stwierdzić „nieznany" —
  //    brak wiedzy to nie brak relacji, a ukrycie pierwszego maila od klienta
  //    jest najgorszą możliwą pomyłką tego systemu.
  if (!s.senderHistoryAvailable) {
    return {
      priority: "normal",
      category: "reply",
      whyListed:
        "nie umiem ocenić nadawcy — brak skanu folderu wysłanych " +
        "(ustaw MAIL_SENT_FOLDER, żeby to rozdzielić)",
      likelyIrrelevant: false,
    };
  }

  // 5. Nieznany nadawca, brak numeru, brak wątku. Prawdopodobnie nie
  //    korespondencja — ale POKAZUJEMY osobno, nie usuwamy.
  return {
    priority: "low",
    category: "informational",
    whyListed: `nigdy nie pisaliśmy do ${domain ?? "tego nadawcy"}, brak numeru zamówienia i brak wątku`,
    likelyIrrelevant: true,
  };
}

/**
 * Wszystko zostaje sprawą — także to, co wygląda nieistotnie.
 *
 * Rozdzielenie robi teraz `likelyIrrelevant`, a nie odrzucenie na wejściu.
 * Różnica jest praktyczna: sprawa oznaczona jako prawdopodobnie nieistotna jest
 * widoczna w zwiniętej sekcji i da się ją znaleźć przez `copilot_search_issues`,
 * a wiadomość odrzucona na wejściu przestaje istnieć dla całego systemu.
 */
export function deservesIssue(_v: DeterministicVerdict): boolean {
  return true;
}
