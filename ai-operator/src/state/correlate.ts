import { OPEN_STATUSES, type Issue, type SourceRef } from "./types.js";

/**
 * Dopasowanie wiadomości do istniejącej sprawy.
 *
 * Zasada, którą ten plik ma wymuszać: **duplikat jest mniej groźny niż scalenie
 * dwóch różnych spraw.** Dwie sprawy o tym samym można potem połączyć ręcznie.
 * Sprawa, w której zmieszały się dwa różne zamówienia dwóch różnych klientów,
 * podaje właścicielowi nieprawdę i nie widać tego, dopóki nie zaszkodzi.
 *
 * Dlatego dopasowanie ma stopnie pewności i automatycznie scalamy tylko przy
 * wysokim. Przy średnim zwracamy kandydata, ale zakładamy nową sprawę — a
 * podobieństwo trafia do jej opisu, żeby człowiek mógł je zobaczyć.
 */

export type MatchConfidence = "high" | "medium" | "none";

export interface MatchResult {
  readonly issue: Issue | null;
  readonly confidence: MatchConfidence;
  /** Dlaczego tak — trafia do historii sprawy, nie do promptu. */
  readonly why: string;
  /** Sprawy podobne, ale nie na tyle, żeby scalać. */
  readonly nearMisses: readonly { id: string; title: string; why: string }[];
}

export interface IncomingMessage {
  readonly ref: SourceRef;
  /** Message-ID przodków z References + In-Reply-To, już znormalizowane. */
  readonly parentIds: readonly string[];
  readonly orderRefs: readonly string[];
}

const domainOf = (address: string | null): string | null => {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : null;
};

/** Wątek tej samej korespondencji — najmocniejszy dowód, jaki daje poczta. */
function sameThread(issue: Issue, msg: IncomingMessage): boolean {
  const known = new Set(issue.sourceRefs.map((r) => r.messageId));
  if (msg.parentIds.some((p) => known.has(p))) return true;
  // threadId liczy się tylko wtedy, gdy naprawdę istnieje po obu stronach —
  // null === null nie jest dowodem na nic.
  if (msg.ref.threadId === null) return false;
  return issue.sourceRefs.some((r) => r.threadId === msg.ref.threadId);
}

export function matchIssue(
  issues: readonly Issue[],
  msg: IncomingMessage,
): MatchResult {
  const open = issues.filter((i) => OPEN_STATUSES.includes(i.status));
  const nearMisses: { id: string; title: string; why: string }[] = [];

  // 1. Ten sam wątek korespondencji. Pewność wysoka i nie wymaga niczego więcej —
  //    odpowiedź w wątku JEST tą samą sprawą. Szukamy też w zamkniętych: klient
  //    odpisujący do zamkniętej sprawy ją otwiera ponownie, nie zakłada nowej.
  for (const issue of issues) {
    if (sameThread(issue, msg)) {
      return {
        issue,
        confidence: "high",
        why: `odpowiedź w tym samym wątku (${msg.ref.messageId})`,
        nearMisses: [],
      };
    }
  }

  // 2. Ten sam numer zamówienia ORAZ ta sama domena nadawcy. Dwa niezależne
  //    sygnały — dopiero razem dają pewność wystarczającą do scalenia.
  const incomingDomain = domainOf(msg.ref.from);
  for (const issue of open) {
    const shared = msg.orderRefs.filter((r) => issue.relatedOrderRefs.includes(r));
    if (shared.length === 0) continue;

    const issueDomains = new Set(
      issue.sourceRefs.map((r) => domainOf(r.from)).filter((d): d is string => d !== null),
    );

    if (incomingDomain && issueDomains.has(incomingDomain)) {
      return {
        issue,
        confidence: "high",
        why: `ten sam numer ${shared.join(", ")} i ten sam nadawca (${incomingDomain})`,
        nearMisses: [],
      };
    }

    // Sam numer bez zgodnego nadawcy: to często JEST ta sama sprawa (np. dział
    // księgowości pisze o zamówieniu handlowca), ale równie dobrze może być
    // zupełnie inna sprawa dotycząca tego samego zamówienia. Nie scalamy.
    nearMisses.push({
      id: issue.id,
      title: issue.title,
      why: `wspólny numer ${shared.join(", ")}, ale inny nadawca`,
    });
  }

  if (nearMisses.length > 0) {
    return {
      issue: null,
      confidence: "medium",
      why:
        `numer zamówienia pokrywa się z ${nearMisses.length === 1 ? "istniejącą sprawą" : `${nearMisses.length} sprawami`}, ` +
        "ale nadawca jest inny — zakładam osobną sprawę, żeby nie zmieszać dwóch wątków",
      nearMisses,
    };
  }

  return { issue: null, confidence: "none", why: "brak powiązania z istniejącymi sprawami", nearMisses: [] };
}

/**
 * Rozpoznawanie numerów zamówień mieszka w `order-refs.ts` i jest JEDNO
 * w całym systemie. Wcześniej stał tu własny wzorzec „każda liczba od czterech
 * cyfr" — i dokładnie to, przed czym ostrzegał komentarz obok, się stało:
 * dwa różne rozpoznawania numeru rozjechały się, bo jedno dostawało numery
 * wybrane wcześniej przez model, a drugie surowy tekst.
 */
export { extractOrderRefs, findOrderRefs, isOwnOrderShape, looksLikeYear } from "./order-refs.js";
