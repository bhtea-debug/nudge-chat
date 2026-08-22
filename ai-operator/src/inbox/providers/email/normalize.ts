import type { ParsedRecord } from "../../../mail/imap.js";
import { stripQuotedHistory, truncateBody } from "../../../mail/text.js";
import { baseSubject } from "../../../mail/thread.js";
import type { InboxMessage, SourceKey } from "../../contract.js";
import { contentSha256, deriveCaseId, stableMessageFingerprint } from "../../ids.js";

/**
 * Twardy sufit treści w trwałym zapisie. `truncateBody` ma własny, mniejszy
 * limit; ten jest zabezpieczeniem dziennika przed wiadomością-potworem, która
 * jednym rekordem rozdmuchałaby plik stanu.
 */
const MAX_BODY = 32_000;

function clampBody(text: string): string {
  return text.length <= MAX_BODY ? text : text.slice(0, MAX_BODY);
}

export interface EmailAccount {
  readonly accountKey: string;
  readonly address: string;
  readonly label: string;
  readonly folder: string;
  /** Folder wysłanych — WYŁĄCZNIE do obserwacji, nigdy jako ledger wysyłki. */
  readonly sentFolder: string | null;
}

export interface NormalizeInput {
  readonly record: ParsedRecord;
  readonly account: EmailAccount;
  readonly uid: number;
  readonly uidValidity: number;
  readonly now: number;
  /**
   * Wątki znane wcześniej: Message-ID -> externalConversationId. Pozwala
   * dołączyć odpowiedź do istniejącej rozmowy zamiast zakładać nową.
   */
  readonly threadIndex: ReadonlyMap<string, string>;
  /** Fallback po znormalizowanym temacie i uczestnikach. */
  readonly subjectIndex: ReadonlyMap<string, string>;
}

/**
 * Znormalizowana wiadomość e-mail w kontrakcie generycznym.
 *
 * `externalMessageId` nie jest po prostu `Message-ID`. Nagłówek bywa pusty
 * (część klientów go nie stawia) i bywa powtórzony (nadawcy z zepsutą
 * konfiguracją wysyłają serię z jednym identyfikatorem). Dedup po samym
 * nagłówku wtedy albo gubi wiadomość, albo skleja dwie różne — więc gdy
 * nagłówek jest pusty, identyfikatorem staje się stabilny fingerprint
 * ze skrzynki, folderu, `uidValidity` i UID.
 */
export function normalizeEmail(input: NormalizeInput): {
  readonly message: InboxMessage;
  readonly conversationId: string;
  readonly threadKeys: string[];
  readonly subjectKey: string;
} {
  const { record, account, uid, uidValidity, now } = input;
  const key: SourceKey = { provider: "email", accountKey: account.accountKey };
  // `toRecord` podstawia "imap:<folder>:<uid>", gdy nagłówka Message-ID nie ma.
  const hasRealMessageId = !record.message.id.startsWith("imap:");
  const rfcMessageId = normalizeMessageId(record.message.id);

  /**
   * Identyfikator wiadomości NIE zawiera UID.
   *
   * Zawierał w pierwszej wersji i to był błąd: po zmianie `uidValidity` ta sama
   * wiadomość dostawała nowy identyfikator, więc uzgodnienie wstawiało ją drugi
   * raz. Kolizję powtórzonego `Message-ID` rozstrzyga odcisk treści niżej,
   * a nie numer, który zmienia się przy odbudowie folderu.
   */
  const externalMessageId = hasRealMessageId
    ? `mid:${rfcMessageId}`
    : stableMessageFingerprint({
        key,
        folder: account.folder,
        uidValidity,
        uid,
        rfcMessageId: null,
      });

  const from = record.message.from?.address?.toLowerCase() ?? null;
  const recipients = record.message.to.map((entry) => entry.address.toLowerCase());
  const direction = from === account.address.toLowerCase() ? "outgoing" : "incoming";

  const references = record.message.references.map(normalizeMessageId).filter((value) => value.length > 0);
  const inReplyTo = record.message.inReplyTo ? normalizeMessageId(record.message.inReplyTo) : null;

  const subjectKey = subjectFallbackKey(record.message.subject, [from, ...recipients]);
  const conversationId = resolveConversation({
    threadIndex: input.threadIndex,
    subjectIndex: input.subjectIndex,
    inReplyTo,
    references,
    rfcMessageId: hasRealMessageId ? rfcMessageId : null,
    subjectKey,
    fallback: externalMessageId,
  });

  const body = truncateBody(clampBody(stripQuotedHistory(record.body)));

  const message: InboxMessage = {
    provider: "email",
    accountKey: account.accountKey,
    externalConversationId: conversationId,
    externalMessageId,
    caseId: deriveCaseId(key, conversationId),
    direction,
    sourceCreatedAt: parseDate(record.message.date),
    receivedAt: now,
    authorLabel: from,
    subject: record.message.subject || null,
    body: body.body,
    bodyTruncated: body.truncated,
    attachments: record.message.attachments.map((attachment, index) => ({
      id: `${externalMessageId}#${index}`,
      fileName: attachment.filename,
      mimeType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    })),
    rfcMessageId: hasRealMessageId ? rfcMessageId : null,
    rfcInReplyTo: inReplyTo,
    rfcReferences: references,
    isEcho: false,
    contentFingerprint: contentSha256(
      [from ?? "", record.message.date, record.message.subject, body.body].join("\u0000"),
    ).slice(0, 32),
  };

  const threadKeys = hasRealMessageId ? [rfcMessageId] : [];
  return { message, conversationId, threadKeys, subjectKey };
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^</, "").replace(/>$/, "").trim();
}

function parseDate(iso: string): number | null {
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || time <= 0) return null;
  return time;
}

/**
 * Konserwatywny klucz zastępczy: znormalizowany temat + zbiór uczestników.
 *
 * Sam temat nie wystarcza. „Zamówienie" albo „Reklamacja" pisze w tym tygodniu
 * dwadzieścia różnych osób i sklejenie ich w jeden wątek pokazałoby jednemu
 * klientowi korespondencję drugiego. Dlatego uczestnicy są częścią klucza,
 * a sam fallback wchodzi dopiero, gdy nagłówki RFC nic nie dają.
 */
export function subjectFallbackKey(
  subject: string | null,
  participants: readonly (string | null)[],
): string {
  const normalizedSubject = baseSubject(subject ?? "").toLowerCase().trim();
  const people = [...new Set(participants.filter((value): value is string => Boolean(value)))]
    .map((value) => value.toLowerCase())
    .sort()
    .join(",");
  return `${normalizedSubject}|${people}`;
}

function resolveConversation(input: {
  readonly threadIndex: ReadonlyMap<string, string>;
  readonly subjectIndex: ReadonlyMap<string, string>;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly rfcMessageId: string | null;
  readonly subjectKey: string;
  readonly fallback: string;
}): string {
  if (input.inReplyTo) {
    const found = input.threadIndex.get(input.inReplyTo);
    if (found) return found;
  }
  // Od najbliższego przodka wstecz: References jest uporządkowane od korzenia.
  for (let index = input.references.length - 1; index >= 0; index -= 1) {
    const found = input.threadIndex.get(input.references[index]!);
    if (found) return found;
  }
  if (input.rfcMessageId) {
    const self = input.threadIndex.get(input.rfcMessageId);
    if (self) return self;
  }
  const bySubject = input.subjectIndex.get(input.subjectKey);
  if (bySubject) return bySubject;
  return input.rfcMessageId ?? input.fallback;
}
