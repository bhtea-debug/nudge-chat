import { CLASSIFIER_VERSION, type InboxMessage } from "./contract.js";
import { classifyCase, failOpenClassification } from "./classify.js";
import type { InboxStore, StoredCase } from "./store.js";

/**
 * Projekcja sprawy z zapisanych wiadomości.
 *
 * Sprawa jest wyliczana, a nie przyjmowana od dostawcy: dzięki temu późny
 * webhook, powtórka partii i zmiana kolejności zdarzeń dają ten sam wynik.
 * Kolejność zdarzeń w sieci nie jest gwarantowana przez nikogo, więc opieranie
 * stanu na "ostatnim, co przyszło" jest opieraniem go na przypadku.
 */

export interface ProjectOptions {
  readonly internalSenders?: readonly string[];
  readonly companyDomains?: readonly string[];
  readonly bulkHint?: boolean;
  readonly sourceClosed?: boolean;
  readonly orderRef?: string | null;
}

export function projectCase(
  store: InboxStore,
  caseId: string,
  options: ProjectOptions = {},
): StoredCase | null {
  const messages = store.messagesForCase(caseId);
  if (messages.length === 0) return null;

  const first = messages[0]!;
  const previous = store.getCase(caseId);
  const incoming = messages.filter((message) => message.direction === "incoming" && !message.isEcho);
  const lastIncoming = incoming[incoming.length - 1] ?? null;
  const sourceClosed = options.sourceClosed ?? previous?.sourceClosed ?? false;

  let classification;
  try {
    classification = classifyCase({
      messages,
      sourceClosed,
      internalSenders: options.internalSenders,
      companyDomains: options.companyDomains,
      bulkHint: options.bulkHint,
    });
  } catch {
    // Awaria oceny nie ma prawa ukryć sprawy. Fail-open i tyle.
    classification = failOpenClassification();
  }

  const subject =
    messages.find((message) => message.subject !== null && message.subject.trim().length > 0)?.subject ??
    previous?.subject ??
    null;

  return {
    caseId,
    provider: first.provider,
    accountKey: first.accountKey,
    externalConversationId: first.externalConversationId,
    subject,
    participantLabel: lastIncoming?.authorLabel ?? first.authorLabel ?? previous?.participantLabel ?? null,
    orderRef: options.orderRef ?? previous?.orderRef ?? null,
    firstSeenAt: previous?.firstSeenAt ?? messageTime(first),
    lastMessageAt: latest(messages),
    lastIncomingMessageId: lastIncoming?.externalMessageId ?? null,
    lastIncomingAt: lastIncoming ? messageTime(lastIncoming) : null,
    messageCount: messages.length,
    requiresResponse: classification.requiresResponse,
    pendingAction: classification.pendingAction,
    classifierVersion: CLASSIFIER_VERSION,
    classificationReason: classification.reason,
    needsReview: classification.needsReview,
    sourceClosed,
    hasAttachments: messages.some((message) => message.attachments.length > 0),
  };
}

function messageTime(message: InboxMessage): number {
  return message.sourceCreatedAt ?? message.receivedAt;
}

function latest(messages: readonly InboxMessage[]): number | null {
  let value: number | null = null;
  for (const message of messages) {
    const time = messageTime(message);
    if (value === null || time > value) value = time;
  }
  return value;
}
