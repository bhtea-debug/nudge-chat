import type { ClassificationReason, InboxMessage } from "./contract.js";

/**
 * Deterministyczna klasyfikacja: czy sprawa wymaga reakcji człowieka.
 *
 * Trzy zasady, w tej kolejności:
 *  1. Ocenia się CAŁY wątek, nie ostatnie zdanie. Podziękowanie po nieodebranej
 *     prośbie nie zamyka sprawy.
 *  2. Reguły deterministyczne mają pierwszeństwo dla oczywistych automatów.
 *     Model jest od przypadków niejednoznacznych i nie ma prawa nic usunąć.
 *  3. Każda niepewność jest fail-open: sprawa trafia do kolejki jako nowa.
 *     Fałszywy alarm kosztuje jedno spojrzenie, przeoczona reklamacja kosztuje
 *     klienta.
 */

export interface ClassificationInput {
  /** Chronologicznie, od najstarszej. */
  readonly messages: readonly InboxMessage[];
  readonly sourceClosed: boolean;
  /** Adresy/nadawcy uznani za wewnętrznych (własna domena, koledzy z firmy). */
  readonly internalSenders?: readonly string[];
  /** Nagłówki RFC wskazujące wysyłkę masową; ustawia je adapter poczty. */
  readonly bulkHint?: boolean;
}

export interface ClassificationResult {
  readonly requiresResponse: boolean;
  readonly pendingAction: boolean;
  readonly reason: ClassificationReason;
}

/** Całe, znane frazy potwierdzenia. Dopasowanie jest do CAŁEJ treści. */
const THANKS_ONLY = [
  "dziekuje",
  "dziekuje bardzo",
  "goraco dziekuje",
  "dzieki",
  "dziekujemy",
  "ok",
  "okej",
  "super",
  "swietnie",
  "rozumiem",
  "jasne",
  "pozdrawiam",
  "dziekuje pozdrawiam",
  "dziekuje za informacje",
  "dziekuje za odpowiedz",
  "thanks",
  "thank you",
];

/** Obietnica wysyłkowa firmy. Wystarczy do `pendingAction`, nie do SLA. */
const SHIPPING_PROMISE = [
  "wysylamy",
  "wysylam",
  "nadamy",
  "nadaje",
  "wyslemy",
  "zostanie wyslana",
  "zostanie nadana",
  "paczka wyjdzie",
  "wysylka jutro",
  "wysylka dzisiaj",
];

/** Deklaracja klienta, że czeka na przesyłkę. */
const CUSTOMER_WAITING = [
  "czekam na paczke",
  "czekam na przesylke",
  "bede czekac",
  "czekam wiec",
  "czekam",
];

const AUTOMATED_SUBJECT = [
  "newsletter",
  "no-reply",
  "noreply",
  "automatyczna odpowiedz",
  "automatic reply",
  "out of office",
  "delivery status notification",
  "undelivered mail",
  "mail delivery failed",
];

/**
 * Normalizacja do porównań: bez ogonków, bez interpunkcji, jedna spacja.
 * Bez tego "Dziękuję!" i "dziekuje" to dwie różne frazy, a lista wyjątków
 * rośnie w nieskończoność.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsQuestion(raw: string): boolean {
  if (raw.includes("?")) return true;
  const text = normalizeForMatch(raw);
  return /\b(czy|kiedy|dlaczego|jak|gdzie|ile|prosze o|prosze przeslac|mozecie|moglibyscie|potrzebuje|chcialbym|chcialabym|prosba)\b/.test(
    text,
  );
}

function isThanksOnly(message: InboxMessage): boolean {
  if (message.attachments.length > 0) return false;
  if (containsQuestion(message.body)) return false;
  const normalized = normalizeForMatch(message.body);
  if (!normalized) return false;
  // Dopasowanie do CAŁEJ treści. Fragment ("dziekuje, ale gdzie paczka")
  // nie zamyka sprawy, i o to chodzi.
  return THANKS_ONLY.includes(normalized);
}

function looksAutomated(message: InboxMessage): boolean {
  const subject = normalizeForMatch(message.subject ?? "");
  return AUTOMATED_SUBJECT.some((needle) => subject.includes(normalizeForMatch(needle)));
}

function matchesAny(text: string, needles: readonly string[]): boolean {
  const normalized = normalizeForMatch(text);
  return needles.some((needle) => normalized.includes(needle));
}

/**
 * Ocena wątku. Wynik nigdy nie usuwa rekordu i nigdy nie chowa sprawy do
 * osobnej, technicznej kolejki: `requiresResponse=false` znaczy tylko tyle,
 * że sprawa nie liczy się jako wymagająca reakcji.
 */
export function classifyCase(input: ClassificationInput): ClassificationResult {
  const { messages } = input;
  if (messages.length === 0) {
    return { requiresResponse: false, pendingAction: false, reason: "customer_message" };
  }

  const incoming = messages.filter((message) => message.direction === "incoming" && !message.isEcho);
  if (incoming.length === 0) {
    return { requiresResponse: false, pendingAction: false, reason: "customer_message" };
  }

  const internal = new Set((input.internalSenders ?? []).map((value) => value.toLowerCase()));
  const external = incoming.filter(
    (message) => !message.authorLabel || !internal.has(message.authorLabel.toLowerCase()),
  );
  if (external.length === 0) {
    return { requiresResponse: false, pendingAction: false, reason: "internal_sender" };
  }

  const last = external[external.length - 1]!;

  // Automat rozpoznajemy z nagłówków i tematu, nigdy z nazwy nadawcy: firma
  // z jednym adresem "biuro@" pisze i marketing, i reklamacje.
  if (input.bulkHint === true && !containsQuestion(last.body)) {
    return { requiresResponse: false, pendingAction: false, reason: "bulk_or_marketing" };
  }
  if (looksAutomated(last) && !containsQuestion(last.body)) {
    return { requiresResponse: false, pendingAction: false, reason: "automated_report" };
  }

  const pendingAction = detectPendingAction(messages);

  if (input.sourceClosed) {
    return { requiresResponse: false, pendingAction, reason: "source_closed" };
  }

  /**
   * Otwarte zobowiązanie firmy wyłącza zegar ODPOWIEDZI, ale nie zamyka sprawy.
   * Piłka jest po naszej stronie: klient nie czeka na słowa, tylko na paczkę.
   * `detectPendingAction` dopuszcza tu wyłącznie bezpieczne deklaracje
   * czekania, więc pytanie ani załącznik nie wpadną w tę gałąź.
   */
  if (pendingAction) {
    return { requiresResponse: false, pendingAction: true, reason: "pending_action" };
  }

  /**
   * Sedno oceny: czy po NASZEJ ostatniej odpowiedzi klient odezwał się
   * ponownie. Sama obecność pytania w wątku nie wystarcza — inaczej każda
   * zamknięta sprawa świeciłaby się w kolejce na zawsze.
   */
  const lastOutgoingAt = lastTimestamp(messages.filter((message) => message.direction === "outgoing"));
  const afterOurReply =
    lastOutgoingAt === null
      ? external
      : external.filter((message) => messageTime(message) > lastOutgoingAt);

  if (afterOurReply.length === 0) {
    return { requiresResponse: false, pendingAction, reason: "answered" };
  }

  // Klient odezwał się po odpowiedzi. Sprawa zostaje zamknięta tylko wtedy,
  // gdy KAŻDA z tych wiadomości jest całą, znaną frazą potwierdzenia.
  // Podziękowanie z doklejonym pytaniem nie jest podziękowaniem.
  if (lastOutgoingAt !== null && afterOurReply.every(isThanksOnly)) {
    return { requiresResponse: false, pendingAction, reason: "thanks_only" };
  }

  return { requiresResponse: true, pendingAction, reason: "customer_message" };
}

function messageTime(message: InboxMessage): number {
  return message.sourceCreatedAt ?? message.receivedAt;
}

function lastTimestamp(messages: readonly InboxMessage[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    const time = messageTime(message);
    if (latest === null || time > latest) latest = time;
  }
  return latest;
}

/**
 * Otwarte zobowiązanie firmy: obiecaliśmy wysyłkę, klient czeka. Sprawa
 * zostaje otwarta, ale bez zegara odpowiedzi, bo piłka jest po naszej stronie.
 */
function detectPendingAction(messages: readonly InboxMessage[]): boolean {
  const lastOutgoing = [...messages].reverse().find((message) => message.direction === "outgoing");
  if (!lastOutgoing) return false;
  if (!matchesAny(lastOutgoing.body, SHIPPING_PROMISE)) return false;
  const after = messages.filter(
    (message) =>
      message.direction === "incoming" &&
      !message.isEcho &&
      messageTime(message) >= messageTime(lastOutgoing),
  );
  if (after.length === 0) return true;
  // Klient odezwał się po obietnicy. Zobowiązanie trwa tylko wtedy, gdy każda
  // późniejsza wiadomość to bezpieczna deklaracja czekania: pytanie, załącznik
  // albo nieznany tekst pozostają fail-open i wracają do zwykłej kolejki.
  return after.every(
    (message) =>
      message.attachments.length === 0 &&
      !containsQuestion(message.body) &&
      (matchesAny(message.body, CUSTOMER_WAITING) || isThanksOnly(message)),
  );
}

/**
 * Awaria oceny. Osobna funkcja, żeby wywołanie z `catch` było widoczne
 * w kodzie: timeout modelu ma dawać sprawę w kolejce, nie ciszę.
 */
export function failOpenClassification(): ClassificationResult {
  return {
    requiresResponse: true,
    pendingAction: false,
    reason: "classifier_error_fail_open",
  };
}
