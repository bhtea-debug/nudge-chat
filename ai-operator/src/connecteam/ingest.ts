import { createHmac, timingSafeEqual } from "node:crypto";
import { matchIssue } from "../state/correlate.js";
import { findOrderRefs, isOwnOrderShape } from "../state/order-refs.js";
import type { CopilotStore } from "../state/store.js";
import type { ConnecteamSourceRef } from "../state/types.js";
import { ChatMessage } from "./types.js";

/**
 * Wchłanianie wiadomości z Connecteam do TEGO SAMEGO stanu operacyjnego, co
 * poczta. Nie ma osobnego „Connecteam Copilota" i nie ma osobnej listy spraw —
 * to było wprost wymaganie (§8) i jest słuszne: właściciela nie interesuje,
 * z którego systemu przyszła informacja.
 *
 * Trzy własności, których nie wolno tu zepsuć:
 *
 *  1. **Idempotencja.** Webhook może przyjść dwa razy — przy retry dostawcy, przy
 *     restarcie kontenera, przy podwójnej konfiguracji. Rozstrzyga o tym zbiór
 *     `seen` w stanie, po kanonicznym identyfikatorze `ct:<konwersacja>:<id>`.
 *     Ten sam mechanizm chroni pocztę i jest przetestowany.
 *
 *  2. **Wiadomość NIE oznacza automatycznie nowej sprawy** (§13). Najpierw próba
 *     korelacji; osobna sprawa dopiero, gdy nic nie pasuje. Przy niejasności
 *     wygrywa duplikat, nie scalenie — sprawa, w której zmieszały się dwa
 *     tematy, podaje właścicielowi nieprawdę i nie widać tego, dopóki nie
 *     zaszkodzi.
 *
 *  3. **Zero zapisu do Connecteam.** Ten moduł czyta ładunek webhooka i pisze do
 *     naszej pamięci. Nie ma tu klienta wysyłającego wiadomości i nie może być —
 *     Connecteam pozostaje read-only na tym etapie (§23).
 */

/** Kanoniczny identyfikator wiadomości czatu w naszym systemie. */
export function chatMessageId(conversationId: string, messageId: string): string {
  return `ct:${conversationId}:${messageId}`;
}

/**
 * Weryfikacja podpisu ładunku.
 *
 * Wywołujemy ją tylko wtedy, gdy sekret jest skonfigurowany. Brak sekretu daje
 * `null` — „nie sprawdzam" — i wywołujący MUSI potraktować to inaczej niż
 * „sprawdziłem i się zgadza". Endpoint bez weryfikacji jest publicznym wejściem
 * do stanu firmy, więc różnica jest istotna i widoczna w logu.
 *
 * Kształt podpisu u dostawcy nie jest dziś przez nas potwierdzony (patrz
 * `docs/DECYZJA-CONNECTEAM.md`), dlatego obsługujemy najczęstszy wariant:
 * HMAC-SHA256 z surowego ciała, w postaci szesnastkowej, opcjonalnie
 * z prefiksem `sha256=`.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string | null,
): boolean | null {
  if (!secret) return null;
  if (!header) return false;
  const provided = header.trim().replace(/^sha256=/i, "");
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided.toLowerCase(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Zdarzenia, które obsługujemy.
 *
 * `message_created` jest wymaganym minimum (§11). Pozostałe dwa są rozpoznawane,
 * ale świadomie NIE zmieniają stanu: edycja i usunięcie wiadomości u źródła nie
 * powinny wymazywać sprawy, którą właściciel już zobaczył. Zamiast tego trafiają
 * do historii sprawy jako fakt. Ciche usunięcie dowodu jest gorsze niż dowód
 * nieaktualny.
 */
export const HANDLED_EVENTS = ["message_created", "message_updated", "message_deleted"] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export interface IngestResult {
  readonly accepted: boolean;
  /** `created` | `merged` | `duplicate` | `ignored` | `noted` */
  readonly outcome: "created" | "merged" | "duplicate" | "ignored" | "noted";
  readonly issueId: string | null;
  readonly why: string;
}

/**
 * Wyciąga wiadomość z ładunku webhooka.
 *
 * Ładunek jest parsowany defensywnie: schemat należy do dostawcy, nie do nas,
 * i nie mamy go zamkniętego kontraktem z fixture'ami po obu stronach. Wszystko,
 * czego nie rozumiemy, powoduje odrzucenie z czytelnym powodem — nie próbę
 * domyślenia się brakujących pól.
 */
export function messageFromWebhook(payload: unknown): ChatMessage | { error: string } {
  const rec = payload as Record<string, unknown> | null;
  if (typeof rec !== "object" || rec === null) return { error: "ładunek nie jest obiektem" };

  const data = (typeof rec["data"] === "object" && rec["data"] !== null
    ? (rec["data"] as Record<string, unknown>)
    : rec) as Record<string, unknown>;

  const id = data["id"] ?? data["messageId"];
  const conversationId = data["conversationId"] ?? data["chatId"] ?? data["channelId"];
  if (typeof id !== "string" && typeof id !== "number") return { error: "brak identyfikatora wiadomości" };
  if (typeof conversationId !== "string" && typeof conversationId !== "number") {
    return { error: "brak identyfikatora konwersacji" };
  }

  const rawAt =
    data["createdAt"] ?? data["timestamp"] ?? data["sentAt"] ?? rec["eventTimestamp"] ?? null;
  const at = normalizeTime(rawAt);
  if (at === null) return { error: "brak rozpoznawalnego znacznika czasu" };

  const text = ["text", "body", "message", "content"]
    .map((k) => (typeof data[k] === "string" ? (data[k] as string) : ""))
    .find((s) => s.trim().length > 0);

  return {
    id: String(id),
    conversationId: String(conversationId),
    conversationName: str(data["conversationName"]) ?? str(data["channelName"]),
    at,
    authorName:
      str(data["senderName"]) ??
      nested(data["sender"], ["name", "fullName"]) ??
      nested(data["author"], ["name", "fullName"]),
    text: (text ?? "").trim(),
  };
}

export function eventTypeOf(payload: unknown): string | null {
  const rec = payload as Record<string, unknown> | null;
  if (typeof rec !== "object" || rec === null) return null;
  for (const key of ["eventType", "event", "type"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Wchłania jedną wiadomość czatu. Cała decyzyjność jest tutaj i jest
 * deterministyczna — bez modelu, bez kosztu (§17).
 */
export function ingestChatMessage(
  store: CopilotStore,
  msg: ChatMessage,
  event: string = "message_created",
): IngestResult {
  const canonicalId = chatMessageId(msg.conversationId, msg.id);

  if (store.hasSeen(canonicalId)) {
    const prior = store.seenEntry(canonicalId);
    return {
      accepted: true,
      outcome: "duplicate",
      issueId: prior?.issueId ?? null,
      why: "tę wiadomość już przetworzyłem — webhook przyszedł powtórnie",
    };
  }

  if (event === "message_updated" || event === "message_deleted") {
    // Świadomie nie zmieniamy sprawy. Powód w komentarzu przy HANDLED_EVENTS.
    return {
      accepted: true,
      outcome: "ignored",
      issueId: null,
      why: `zdarzenie ${event} zarejestrowane, ale nie zmienia sprawy — nie wymazuję dowodu, który właściciel mógł już widzieć`,
    };
  }

  if (event !== "message_created") {
    return { accepted: false, outcome: "ignored", issueId: null, why: `nieobsługiwane zdarzenie ${event}` };
  }

  const ref: ConnecteamSourceRef = {
    kind: "connecteam",
    messageId: canonicalId,
    conversationId: msg.conversationId,
    conversationName: msg.conversationName,
    date: msg.at,
    authorName: msg.authorName,
    preview: msg.text.slice(0, 400),
  };

  // Numery szukamy w treści I w nazwie konwersacji — kanał bywa nazwany numerem
  // zamówienia albo klientem, i to jest wtedy najmocniejszy sygnał w całej wiadomości.
  const found = [...findOrderRefs(msg.text), ...findOrderRefs(msg.conversationName ?? "")];
  const orderRefs = [...new Set(found.filter((f) => f.why !== "prefiks").map((f) => f.ref))];

  const match = matchIssue(store.all(), { ref, parentIds: [], orderRefs });

  if (match.issue && match.confidence === "high") {
    store.addSource(match.issue.id, ref, `Connecteam: ${match.why}`);
    const merged = [...new Set([...match.issue.relatedOrderRefs, ...orderRefs.filter(isOwnOrderShape)])];
    if (merged.length > match.issue.relatedOrderRefs.length) {
      store.patchIssue(match.issue.id, { relatedOrderRefs: merged }, "nowe numery z wiadomości Connecteam");
    }
    store.markMessageSeen(canonicalId, chatFolderLabel(msg), match.issue.id);
    return { accepted: true, outcome: "merged", issueId: match.issue.id, why: match.why };
  }

  const who = msg.authorName ?? "Connecteam";
  const where = msg.conversationName ? ` (${msg.conversationName})` : "";
  const issue = store.createIssue({
    title: `${who}${where}`.slice(0, 120),
    summary: msg.text || "(dostawca nie przekazał treści wiadomości — otwórz Connecteam)",
    // Wiadomość wewnętrzna to informacja dla właściciela, nie korespondencja
    // z klientem czekającym na odpowiedź. Kategorię może potem podnieść numer
    // zamówienia albo sam właściciel; nie zakładamy pilności z góry.
    category: orderRefs.some(isOwnOrderShape) ? "reply" : "informational",
    priority: orderRefs.some(isOwnOrderShape) ? "normal" : "low",
    status: "new",
    classifier: "deterministic",
    whyListed: orderRefs.some(isOwnOrderShape)
      ? `wiadomość w Connecteam z numerem zamówienia ${orderRefs.filter(isOwnOrderShape).join(", ")}`
      : `wiadomość w Connecteam${where}, bez numeru zamówienia`,
    likelyIrrelevant: false,
    ref,
    source: "connecteam",
    relatedOrderRefs: orderRefs.filter(isOwnOrderShape),
    waitingFor: null,
  });
  store.markMessageSeen(canonicalId, chatFolderLabel(msg), issue.id);

  if (match.confidence === "medium") {
    // Podobieństwo, którego nie użyłem do scalenia, musi być widoczne dla
    // człowieka — inaczej ostrożność wygląda jak przeoczenie.
    store.patchIssue(
      issue.id,
      { summary: `${issue.summary}\n\nPodobne sprawy: ${match.nearMisses.map((n) => n.title).join("; ")}` },
      match.why,
    );
  }

  return { accepted: true, outcome: "created", issueId: issue.id, why: match.why };
}

/** Etykieta „gdzie to leżało" do zbioru `seen`. Nie folder poczty, ale ta sama rola. */
function chatFolderLabel(msg: ChatMessage): string {
  return `connecteam:${msg.conversationName ?? msg.conversationId}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function nested(v: unknown, keys: readonly string[]): string | null {
  if (typeof v !== "object" || v === null) return null;
  const rec = v as Record<string, unknown>;
  for (const k of keys) {
    const found = str(rec[k]);
    if (found) return found;
  }
  return null;
}

function normalizeTime(v: unknown): string | null {
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v > 1e11 ? v : v * 1000);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}
