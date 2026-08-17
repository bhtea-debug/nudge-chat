import type { ConnecteamSourceRef, MailSourceRef, SourceRef } from "./types.js";

/**
 * Jednolity widok na referencję do źródła.
 *
 * Powstał, gdy `SourceRef` przestał być tylko pocztą. Alternatywą było
 * rozsypanie `if (ref.kind === "mail")` po korelacji, capability, raporcie i UI —
 * czyli cztery miejsca, w których dodanie trzeciego źródła wymaga pamiętania
 * o wszystkich czterech. Tutaj jest jedno.
 *
 * Zasada: ten moduł NIE wymyśla danych. Jeśli źródło nie podało autora albo
 * tematu, pole jest puste i tak trafia wyżej. Wypełnianie luk „sensownym
 * domyślnym" w warstwie prezentacji jest dokładnie tym, przez co potem nie da
 * się odróżnić „nie wiemy" od „wiemy, że nic".
 */

/** Nazwa systemu w języku właściciela. W UI nie pokazujemy nazw technicznych. */
export const SOURCE_LABEL: Record<SourceRef["kind"], string> = {
  mail: "E-mail",
  connecteam: "Connecteam",
};

export interface RefView {
  readonly kind: SourceRef["kind"];
  /** Kanoniczna tożsamość — na niej stoi odsiewanie duplikatów. */
  readonly messageId: string;
  readonly date: string;
  /** Nagłówek: temat maila albo nazwa konwersacji. Może być pusty. */
  readonly heading: string;
  /** Kto to napisał, w formie czytelnej dla człowieka. `null` = nie wiemy. */
  readonly author: string | null;
  /** Grupa, do której należy wiadomość: wątek poczty albo konwersacja czatu. */
  readonly groupId: string | null;
  /** Gdzie to leży — folder poczty albo nazwa kanału. Do diagnostyki, nie do UI. */
  readonly location: string | null;
  /** Podgląd treści, jeśli źródło go dało. Pusty łańcuch = nie mamy treści. */
  readonly preview: string;
}

export function isMailRef(ref: SourceRef): ref is MailSourceRef {
  return ref.kind === "mail";
}

export function isConnecteamRef(ref: SourceRef): ref is ConnecteamSourceRef {
  return ref.kind === "connecteam";
}

export function viewRef(ref: SourceRef): RefView {
  if (isMailRef(ref)) {
    return {
      kind: "mail",
      messageId: ref.messageId,
      date: ref.date,
      heading: ref.subject,
      author: ref.from,
      groupId: ref.threadId,
      location: ref.folder,
      // Poczta trzyma podgląd w streszczeniu sprawy, nie w referencji — treści
      // maili świadomie nie ma w stanie Copilota.
      preview: "",
    };
  }
  return {
    kind: "connecteam",
    messageId: ref.messageId,
    date: ref.date,
    heading: ref.conversationName ?? "",
    author: ref.authorName,
    groupId: ref.conversationId,
    location: ref.conversationName,
    preview: ref.preview,
  };
}

/** Tekst do wyszukiwania w sprawach. Zbiera to, co da się z referencji wyczytać. */
export function searchableText(ref: SourceRef): string {
  const v = viewRef(ref);
  return [v.heading, v.author ?? "", v.preview].filter(Boolean).join(" ");
}

/** Najnowsza referencja danego rodzaju. `null`, gdy sprawa nie ma takiego źródła. */
export function latestOfKind<K extends SourceRef["kind"]>(
  refs: readonly SourceRef[],
  kind: K,
): Extract<SourceRef, { kind: K }> | null {
  const matching = refs.filter((r): r is Extract<SourceRef, { kind: K }> => r.kind === kind);
  if (matching.length === 0) return null;
  return matching.reduce((a, b) => (a.date >= b.date ? a : b));
}

/** Które systemy zasilają tę sprawę. Kolejność stała, żeby UI nie migał. */
export function kindsOf(refs: readonly SourceRef[]): SourceRef["kind"][] {
  const present = new Set(refs.map((r) => r.kind));
  return (["mail", "connecteam"] as const).filter((k) => present.has(k));
}
