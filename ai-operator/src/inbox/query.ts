import type { ContentMode, InboxCase, InboxMessage } from "./contract.js";
import { channelFreshness, mayReportEmptyQueue, type ChannelFreshness } from "./health.js";
import type { InboxStore, StoredCase } from "./store.js";

/**
 * Odczyt kolejki dla firmowego czatu.
 *
 * Domyślnie BEZ treści. Temat i podgląd wiadomości są danymi klienta, więc
 * jadą tylko wtedy, gdy odbiorca jawnie o nie poprosi i poda tryb. Zwykłe
 * odświeżanie listy nie ma prawa przenosić korespondencji przez sieć.
 */

export interface CaseDto {
  readonly caseId: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly sourceLabel: string;
  readonly participantLabel: string | null;
  readonly orderRef: string | null;
  readonly subject: string | null;
  readonly preview: string | null;
  readonly firstSeenAt: number;
  readonly lastMessageAt: number | null;
  readonly lastIncomingAt: number | null;
  readonly lastIncomingMessageId: string | null;
  readonly waitingMs: number | null;
  readonly messageCount: number;
  readonly requiresResponse: boolean;
  readonly pendingAction: boolean;
  readonly hasAttachments: boolean;
  readonly sourceClosed: boolean;
  readonly classifierVersion: number;
  readonly classificationReason: string;
}

export interface QueueResult {
  readonly cases: CaseDto[];
  readonly count: number;
  readonly truncated: boolean;
  readonly freshness: ChannelFreshness;
  /**
   * false = nie wolno napisać „brak spraw". Pusta lista przy zepsutym źródle
   * to brak wiedzy, nie brak pracy.
   */
  readonly completeView: boolean;
  readonly contentMode: ContentMode;
}

export interface QueueOptions {
  readonly now: number;
  readonly state?: "actionable" | "all";
  readonly providers?: readonly string[];
  readonly accountKeys?: readonly string[];
  readonly limit?: number;
  readonly contentMode?: ContentMode;
}

const DEFAULT_LIMIT = 200;
const PREVIEW_CHARS = 140;

export function queryQueue(store: InboxStore, options: QueueOptions): QueueResult {
  const contentMode = options.contentMode ?? "none";
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 500);
  const state = options.state ?? "actionable";

  let cases = store.listCases();
  if (options.providers?.length) {
    const allowed = new Set(options.providers);
    cases = cases.filter((entry) => allowed.has(entry.provider));
  }
  if (options.accountKeys?.length) {
    const allowed = new Set(options.accountKeys);
    cases = cases.filter((entry) => allowed.has(entry.accountKey));
  }
  if (state === "actionable") {
    cases = cases.filter((entry) => entry.requiresResponse || entry.pendingAction);
  }

  cases.sort((a, b) => (b.lastMessageAt ?? b.firstSeenAt) - (a.lastMessageAt ?? a.firstSeenAt));
  const truncated = cases.length > limit;
  const page = cases.slice(0, limit);

  return {
    cases: page.map((entry) => toDto(store, entry, options.now, contentMode)),
    count: cases.length,
    truncated,
    freshness: channelFreshness(store, options.now),
    completeView: mayReportEmptyQueue(channelFreshness(store, options.now)),
    contentMode,
  };
}

function toDto(store: InboxStore, entry: StoredCase, now: number, mode: ContentMode): CaseDto {
  const showContent = mode !== "none";
  const preview = showContent ? buildPreview(store, entry, mode) : null;
  return {
    caseId: entry.caseId,
    provider: entry.provider,
    accountKey: entry.accountKey,
    sourceLabel: sourceLabel(entry),
    participantLabel: showContent ? entry.participantLabel : null,
    orderRef: entry.orderRef,
    subject: showContent ? entry.subject : null,
    preview,
    firstSeenAt: entry.firstSeenAt,
    lastMessageAt: entry.lastMessageAt,
    lastIncomingAt: entry.lastIncomingAt,
    lastIncomingMessageId: entry.lastIncomingMessageId,
    // Czas oczekiwania liczymy od ostatniej wiadomości KLIENTA. Od naszej
    // ostatniej odpowiedzi liczyłby czas, w którym piłka jest po jego stronie.
    waitingMs:
      entry.requiresResponse && entry.lastIncomingAt !== null
        ? Math.max(0, now - entry.lastIncomingAt)
        : null,
    messageCount: entry.messageCount,
    requiresResponse: entry.requiresResponse,
    pendingAction: entry.pendingAction,
    hasAttachments: entry.hasAttachments,
    sourceClosed: entry.sourceClosed,
    classifierVersion: entry.classifierVersion,
    classificationReason: entry.classificationReason,
  };
}

function buildPreview(store: InboxStore, entry: StoredCase, mode: ContentMode): string | null {
  const messages = store.messagesForCase(entry.caseId);
  const last = messages[messages.length - 1];
  if (!last) return null;
  const text = mode === "model" ? redactForModel(last.body) : last.body;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= PREVIEW_CHARS ? oneLine : `${oneLine.slice(0, PREVIEW_CHARS)}…`;
}

export function sourceLabel(entry: Pick<InboxCase, "provider" | "accountKey">): string {
  switch (entry.provider) {
    case "allegro":
      return entry.accountKey === "dyskusje" ? "Allegro Dyskusje" : "Allegro";
    case "email":
      return `E-mail ${entry.accountKey}`;
    case "instagram":
      return "Instagram";
    case "facebook":
      return "Facebook";
    default:
      return entry.provider;
  }
}

/**
 * Redakcja przed analizą AI: e-mail, telefon i kod pocztowy.
 *
 * Model dostaje sens sprawy, nie dane kontaktowe klienta. Redakcja jest tu,
 * a nie tylko po stronie czatu, bo pierwsza linia obrony ma stać przy danych,
 * a nie przy tym, kto o nie prosi.
 */
export function redactForModel(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
    .replace(/(?:\+?\d[\d\s-]{7,}\d)/g, "[telefon]")
    .replace(/\b\d{2}-\d{3}\b/g, "[kod pocztowy]");
}

export interface MessageDto {
  readonly externalMessageId: string;
  readonly direction: InboxMessage["direction"];
  readonly authorLabel: string | null;
  readonly subject: string | null;
  readonly text: string | null;
  readonly sourceCreatedAt: number | null;
  readonly isEcho: boolean;
  readonly attachments: Array<{ id: string; fileName: string | null; mimeType: string | null }>;
}

export function queryMessages(
  store: InboxStore,
  caseId: string,
  mode: Exclude<ContentMode, "none">,
): { readonly caseId: string; readonly messages: MessageDto[]; readonly attachmentsExcluded: true } {
  const messages = store.messagesForCase(caseId).map((message): MessageDto => ({
    externalMessageId: message.externalMessageId,
    direction: message.direction,
    authorLabel: mode === "model" ? null : message.authorLabel,
    subject: message.subject,
    text: mode === "model" ? redactForModel(message.body) : message.body,
    sourceCreatedAt: message.sourceCreatedAt,
    isEcho: message.isEcho,
    // Same metadane. Plik ani URL nigdy nie opuszczają adaptera.
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    })),
  }));
  return { caseId, messages, attachmentsExcluded: true };
}
