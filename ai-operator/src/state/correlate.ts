import { isOwnOrderShape } from "./order-refs.js";
import { viewRef } from "./source-ref.js";
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

/**
 * Ta sama rozmowa — najmocniejszy dowód, jaki daje źródło komunikacji.
 *
 * Dla poczty to wątek (`threadId` / `In-Reply-To`), dla Connecteam ta sama
 * konwersacja. Warunek jest jednak WĘŻSZY niż „ta sama grupa": porównujemy
 * grupy tylko w obrębie tego samego systemu. Wątek poczty i konwersacja czatu
 * mogą mieć przypadkowo identyczny identyfikator, a sklejenie sprawy klienta ze
 * sprawą z czatu produkcji na podstawie kolizji łańcuchów byłoby błędem, którego
 * nikt później nie odtworzy.
 */
function sameThread(issue: Issue, msg: IncomingMessage): boolean {
  const known = new Set(issue.sourceRefs.map((r) => r.messageId));
  if (msg.parentIds.some((p) => known.has(p))) return true;
  const incoming = viewRef(msg.ref);
  // Grupa liczy się tylko wtedy, gdy naprawdę istnieje po obu stronach —
  // null === null nie jest dowodem na nic.
  if (incoming.groupId === null) return false;
  return issue.sourceRefs.some((r) => {
    const v = viewRef(r);
    return v.kind === incoming.kind && v.groupId === incoming.groupId;
  });
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
  const incomingDomain = domainOf(viewRef(msg.ref).author);
  const numberMatches: { issue: Issue; shared: string[] }[] = [];

  for (const issue of open) {
    const shared = msg.orderRefs.filter((r) => issue.relatedOrderRefs.includes(r));
    if (shared.length === 0) continue;
    numberMatches.push({ issue, shared });

    const issueDomains = new Set(
      issue.sourceRefs
        .map((r) => domainOf(viewRef(r).author))
        .filter((d): d is string => d !== null),
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

  // 2b. Komunikacja WEWNĘTRZNA o naszym numerze zamówienia.
  //
  //     Reguła 2 wymaga zgodnej domeny nadawcy i dla poczty jest to słuszne.
  //     Czat wewnętrzny domeny nie ma — pracownik ma imię, nie adres — więc bez
  //     tej reguły wiadomość „nie mamy etykiet do tego Rossmanna" zawsze
  //     zakładałaby osobną sprawę, obok sprawy klienta o tym samym zamówieniu.
  //     Dokładnie ten rozjazd miał zniknąć: jedna sprawa, wiele źródeł.
  //
  //     Dowodem jest tu UNIKALNOŚĆ, nie nadawca. Numer o kształcie naszego
  //     numeru zamówienia identyfikuje zamówienie, a nie stronę rozmowy: dwie
  //     sprawy dwóch różnych klientów nie mogą nosić tego samego. Dlatego
  //     scalamy tylko wtedy, gdy numer wskazuje DOKŁADNIE JEDNĄ otwartą sprawę.
  //     Gdy wskazuje kilka, jest niejednoznaczny i wraca do reguły ostrożnej.
  if (incomingDomain === null && numberMatches.length === 1) {
    const only = numberMatches[0]!;
    const ownShaped = only.shared.filter(isOwnOrderShape);
    if (ownShaped.length > 0) {
      return {
        issue: only.issue,
        confidence: "high",
        why:
          `wiadomość wewnętrzna o numerze ${ownShaped.join(", ")}, ` +
          "który wskazuje dokładnie jedną otwartą sprawę",
        nearMisses: [],
      };
    }
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
