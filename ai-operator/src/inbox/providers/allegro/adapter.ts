import { z } from "zod";
import {
  CustomerCase as CustomerCaseSchema,
  CustomerCaseMessage as CustomerCaseMessageSchema,
  CustomerCasesFreshness as CustomerCasesFreshnessSchema,
} from "../../../teabrew/contract.js";

import type { HealthState, InboxCase, InboxMessage, SourceHealth } from "../../contract.js";
import { CLASSIFIER_VERSION } from "../../contract.js";
import { contentSha256 } from "../../ids.js";

// Kontrakt TeaBrew eksportuje schematy zod bez aliasów typów. Wyprowadzamy je
// tutaj zamiast dopisywać eksporty w cudzym module.
type CustomerCase = z.infer<typeof CustomerCaseSchema>;
type CustomerCaseMessage = z.infer<typeof CustomerCaseMessageSchema>;
type CustomerCasesFreshness = z.infer<typeof CustomerCasesFreshnessSchema>;


/**
 * Allegro w kontrakcie generycznym.
 *
 * TeaBrew zostaje jedyną bramą do Allegro i nie zmienia się ani o linijkę:
 * ten plik tylko tłumaczy jego read model na wspólny kształt. Przepisywanie
 * działającej, przetestowanej integracji po to, żeby pasowała do nowych nazw,
 * byłoby ryzykiem bez zysku.
 *
 * `caseId` przechodzi BEZ ZMIAN. To nie jest szczegół: po nim wiszą komentarze
 * zespołu, deep linki i audyt sprzed tej zmiany.
 */

/** Allegro ma dwa źródła; każde dostaje własny klucz konta, zdrowie i kursor. */
export function allegroAccountKey(source: CustomerCase["source"]): string {
  return source === "sale_issue" ? "dyskusje" : "wiadomosci";
}

export function toInboxCase(input: CustomerCase): InboxCase {
  const requiresResponse = input.requiresResponse ?? true;
  return {
    caseId: input.id,
    provider: "allegro",
    accountKey: allegroAccountKey(input.source),
    externalConversationId: input.externalId,
    subject: input.subject,
    participantLabel: input.buyerLogin,
    orderRef: input.orderId,
    firstSeenAt: input.createdAt ?? input.lastMessageAt ?? Date.now(),
    lastMessageAt: input.lastMessageAt,
    // TeaBrew nie wystawia identyfikatora ostatniej wiadomości klienta na
    // liście, więc markerem jest jej czas. Jest to ten sam marker, którego
    // używa istniejąca brama odpowiedzi Allegro.
    lastIncomingMessageId: input.lastMessageAt === null ? null : `at:${input.lastMessageAt}`,
    lastIncomingAt: input.lastMessageAt,
    messageCount: 0,
    requiresResponse,
    pendingAction: input.pendingAction ?? false,
    classifierVersion: input.responseClassificationVersion ?? CLASSIFIER_VERSION,
    // Ocena pochodzi z TeaBrew i nie liczymy jej drugi raz: dwa klasyfikatory
    // na jednym źródle to dwie różne prawdy o tej samej sprawie.
    classificationReason: requiresResponse ? "customer_message" : "answered",
    // TeaBrew ma własny, konserwatywny klasyfikator; nie dokładamy tu drugiej
    // oceny „do weryfikacji", bo dwie prawdy o jednej sprawie to żadna prawda.
    needsReview: false,
    sourceClosed: input.responseState === "closed",
    hasAttachments: input.hasAttachments,
  };
}

export function toInboxMessage(
  message: CustomerCaseMessage,
  caseRecord: CustomerCase,
  now: number,
): InboxMessage {
  const direction: InboxMessage["direction"] =
    message.direction === "incoming"
      ? "incoming"
      : message.direction === "outgoing"
        ? "outgoing"
        : "system";
  const body = message.text ?? "";
  return {
    provider: "allegro",
    accountKey: allegroAccountKey(caseRecord.source),
    externalConversationId: caseRecord.externalId,
    externalMessageId: message.id,
    caseId: caseRecord.id,
    direction,
    sourceCreatedAt: message.createdAt,
    receivedAt: now,
    authorLabel: message.authorLogin,
    subject: message.subject,
    body,
    bodyTruncated: false,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: null,
    })),
    rfcMessageId: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: contentSha256([message.id, String(message.createdAt ?? ""), body].join(" ")).slice(0, 32),
  };
}

/**
 * Zdrowie Allegro z `freshness` TeaBrew.
 *
 * Mapowanie jest zachowawcze: każdy stan, którego nie znamy, jest błędem.
 * Nieznany stan potraktowany jako „ok" to dokładnie ten przypadek, w którym
 * zielona kropka kłamie.
 */
export function toSourceHealth(
  freshness: CustomerCasesFreshness,
  accountKey: string,
  label: string,
  active: boolean,
): SourceHealth {
  const state: HealthState =
    freshness.status === "ready" || freshness.status === "syncing"
      ? "ok"
      : freshness.status === "rate_limited"
        ? "rate_limited"
        : freshness.status === "missing_scope"
          ? "missing_scope"
          : freshness.status === "reconnect_required" || freshness.status === "not_connected"
            ? "reconnect_required"
            : "error";

  return {
    provider: "allegro",
    accountKey,
    label,
    state,
    active,
    lastSuccessfulSyncAt: freshness.lastSuccessfulSyncAt,
    lastAttemptAt: freshness.lastSuccessfulSyncAt,
    nextAttemptAt: freshness.nextAttemptAt,
    consecutiveFailures: state === "ok" ? 0 : 1,
    message: freshness.message,
  };
}
