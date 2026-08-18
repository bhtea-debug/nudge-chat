import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { matchIssue } from "../state/correlate.js";
import { findOrderRefs, isOwnOrderShape } from "../state/order-refs.js";
import type { CopilotStore } from "../state/store.js";
import type { FirmowyChatSourceRef } from "../state/types.js";

const shortText = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "znaki sterujące są niedozwolone");

export const FirmowyChatEvent = z
  .object({
    type: z.literal("bht.chat.message-created.v1"),
    eventId: shortText,
    occurredAt: z.number().int().min(1_577_836_800_000).max(4_102_444_800_000),
    source: z
      .object({
        app: z.literal("firmowy-czat"),
        conversationId: shortText,
        messageId: shortText,
      })
      .strict(),
    actor: z
      .object({
        userId: shortText,
        displayName: z.string().trim().min(1).max(100),
        department: z.enum(["hala", "biuro", "zarzad"]),
        roleTier: z.enum(["pracownik", "kierownik", "admin"]),
        aiAccess: z.enum(["none", "basic", "full"]),
        scopeKeys: z.array(shortText).min(1).max(12),
      })
      .strict(),
    conversation: z
      .object({
        type: z.enum(["direct", "team", "channel"]),
        title: z.string().trim().min(1).max(240).optional(),
      })
      .strict(),
    message: z
      .object({
        body: z.string().max(12_000),
        importance: z.enum(["normal", "important", "urgent"]),
        replyToMessageId: shortText.optional(),
        linkedRef: z
          .object({
            kind: z.enum(["order", "lot", "productionOrder"]),
            id: z.string().trim().min(1).max(180),
            label: z.string().trim().min(1).max(240),
          })
          .strict()
          .optional(),
        attachments: z
          .array(
            z
              .object({
                name: z.string().trim().min(1).max(240),
                mime: z.string().trim().min(1).max(160),
                size: z.number().int().nonnegative().max(25 * 1024 * 1024),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
  })
  .strict();

export type FirmowyChatEvent = z.infer<typeof FirmowyChatEvent>;

export type SignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_configured" | "missing" | "stale" | "invalid" };

/**
 * Podpis obejmuje znacznik czasu i dokładne bajty JSON. Okno czasu blokuje
 * przechwycony request; idempotencja eventId/messageId blokuje retry.
 */
export function verifyFirmowyChatSignature(input: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret: string | null;
  nowMs?: number;
}): SignatureVerdict {
  if (!input.secret || input.secret.length < 32) return { ok: false, reason: "not_configured" };
  if (!input.timestampHeader || !input.signatureHeader) return { ok: false, reason: "missing" };
  if (!/^\d{10}$/.test(input.timestampHeader)) return { ok: false, reason: "invalid" };
  const timestampMs = Number(input.timestampHeader) * 1000;
  if (Math.abs((input.nowMs ?? Date.now()) - timestampMs) > 5 * 60 * 1000) {
    return { ok: false, reason: "stale" };
  }

  const provided = input.signatureHeader.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) return { ok: false, reason: "invalid" };
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestampHeader}.${input.rawBody}`, "utf8")
    .digest("hex");
  const left = Buffer.from(provided, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && timingSafeEqual(left, right)
    ? { ok: true }
    : { ok: false, reason: "invalid" };
}

export function firmowyChatMessageId(conversationId: string, messageId: string): string {
  return `fc:${encodeURIComponent(conversationId)}:${encodeURIComponent(messageId)}`;
}

export interface FirmowyChatIngestResult {
  readonly accepted: boolean;
  readonly outcome: "created" | "merged" | "duplicate" | "ignored";
  readonly issueId: string | null;
  readonly why: string;
}

export function ingestFirmowyChatEvent(
  store: CopilotStore,
  event: FirmowyChatEvent,
): FirmowyChatIngestResult {
  const canonicalId = firmowyChatMessageId(
    event.source.conversationId,
    event.source.messageId,
  );
  if (store.hasSeen(canonicalId)) {
    return {
      accepted: true,
      outcome: "duplicate",
      issueId: store.seenEntry(canonicalId)?.issueId ?? null,
      why: "to zdarzenie zostało już przetworzone",
    };
  }

  const ref: FirmowyChatSourceRef = {
    kind: "firmowy_chat",
    messageId: canonicalId,
    eventId: event.eventId,
    conversationId: event.source.conversationId,
    conversationName: event.conversation.title ?? null,
    conversationType: event.conversation.type,
    date: new Date(event.occurredAt).toISOString(),
    authorUserId: event.actor.userId,
    authorName: event.actor.displayName,
    department: event.actor.department,
    roleTier: event.actor.roleTier,
    aiAccess: event.actor.aiAccess,
    scopeKeys: [...new Set(event.actor.scopeKeys)],
    importance: event.message.importance,
    replyToMessageId: event.message.replyToMessageId ?? null,
    linkedRef: event.message.linkedRef ?? null,
    preview: event.message.body.trim().slice(0, 400),
  };

  const detected = [
    ...findOrderRefs(event.message.body),
    ...findOrderRefs(event.conversation.title ?? ""),
  ];
  if (event.message.linkedRef?.kind === "order") {
    detected.push({ ref: event.message.linkedRef.id, why: "prefiks" });
  }
  const orderRefs = [
    ...new Set(detected.map((item) => item.ref).filter(isOwnOrderShape)),
  ];
  const parentIds = event.message.replyToMessageId
    ? [firmowyChatMessageId(event.source.conversationId, event.message.replyToMessageId)]
    : [];
  const match = matchIssue(store.all(), { ref, parentIds, orderRefs });
  const notificationReason =
    event.message.importance === "urgent"
      ? `pilna wiadomość w Czat Firmowy od ${event.actor.displayName}`
      : null;

  if (match.issue && match.confidence === "high") {
    store.addSource(match.issue.id, ref, `Czat Firmowy: ${match.why}`);
    const mergedOrders = [...new Set([...match.issue.relatedOrderRefs, ...orderRefs])];
    store.patchIssue(
      match.issue.id,
      {
        relatedOrderRefs: mergedOrders,
        ...(notificationReason
          ? {
              category: "urgent",
              priority: "high",
              status: "needs_attention",
              notificationCandidate: true,
              notificationReason,
            }
          : {}),
      },
      "nowa wiadomość z Czatu Firmowego",
    );
    store.markMessageSeen(canonicalId, `firmowy-chat:${event.source.conversationId}`, match.issue.id);
    return { accepted: true, outcome: "merged", issueId: match.issue.id, why: match.why };
  }

  const actionable =
    event.message.importance !== "normal" ||
    orderRefs.length > 0 ||
    event.message.linkedRef !== undefined;
  if (!actionable) {
    store.markMessageSeen(canonicalId, `firmowy-chat:${event.source.conversationId}`, null);
    return {
      accepted: true,
      outcome: "ignored",
      issueId: null,
      why: "zwykła wiadomość bez numeru ani powiązania operacyjnego",
    };
  }

  const urgent = event.message.importance === "urgent";
  const important = event.message.importance === "important";
  const title = (
    event.conversation.title
      ? `${event.conversation.title} — ${event.actor.displayName}`
      : `Czat Firmowy — ${event.actor.displayName}`
  ).slice(0, 120);
  const whyListed = urgent
    ? notificationReason!
    : important
      ? `wiadomość oznaczona jako ważna przez ${event.actor.displayName}`
      : `wiadomość w Czat Firmowy z numerem ${orderRefs.join(", ")}`;
  const issue = store.createIssue({
    title,
    summary:
      ref.preview ||
      (event.message.attachments.length > 0
        ? `(wiadomość zawiera ${event.message.attachments.length} załącznik(i))`
        : "(brak treści wiadomości)"),
    category: urgent ? "urgent" : important ? "decision" : "reply",
    priority: urgent || important ? "high" : "normal",
    status: urgent ? "needs_attention" : "new",
    classifier: "deterministic",
    whyListed,
    likelyIrrelevant: false,
    ref,
    source: "firmowy_chat",
    relatedOrderRefs: orderRefs,
    waitingFor: null,
    notificationCandidate: urgent,
    notificationReason,
  });
  store.markMessageSeen(canonicalId, `firmowy-chat:${event.source.conversationId}`, issue.id);

  if (match.confidence === "medium") {
    store.patchIssue(
      issue.id,
      {
        summary: `${issue.summary}\n\nPodobne sprawy: ${match.nearMisses.map((near) => near.title).join("; ")}`,
      },
      match.why,
    );
  }
  return { accepted: true, outcome: "created", issueId: issue.id, why: match.why };
}
