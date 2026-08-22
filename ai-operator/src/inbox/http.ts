import { z } from "zod";
import type { ContentMode } from "./contract.js";
import { channelFreshness } from "./health.js";
import { queryMessages, queryQueue } from "./query.js";
import type { InboxRuntime } from "./runtime.js";
import {
  cancelPrepared,
  prepareAttempt,
  resolveUncertain,
} from "./outbound/ledger.js";
import { metaTransport, resendTransport, sendReply, type SendOutcome } from "./outbound/send.js";
import { ingestMetaEvents } from "./providers/meta/ingest.js";
import {
  MetaWebhookPayload,
  metaVerificationChallenge,
  normalizeMetaPayload,
  verifyMetaSignature,
} from "./providers/meta/webhook.js";
import { applyDeliveryEvent } from "./outbound/ledger.js";
import { accountMatchesCase, resolveRecipient } from "./outbound/recipient.js";
import { resendDeliveryState, verifyResendWebhook } from "./outbound/webhooks.js";

/**
 * Kontrakt HTTP kanału obsługi klienta.
 *
 * Świadomie NIE są to narzędzia MCP. Rejestr narzędzi jest tym, co widzi model,
 * a wysyłka do klienta nie ma prawa się tam znaleźć — nawet omyłkowo, nawet
 * jako narzędzie „tylko do przygotowania". Odczyt też jest osobno, bo czat
 * potrzebuje pełnych danych sprawy, a model wariantu zredagowanego.
 */

export const INBOX_READ_PREFIX = "/internal/inbox";
export const INBOX_REPLY_PATH = "/internal/inbox/reply";
export const META_WEBHOOK_PATH = "/webhook/meta";
export const RESEND_WEBHOOK_PATH = "/webhook/resend";

export const INBOX_REPLY_CONFIRMATION = "SEND_CUSTOMER_REPLY";
export const INBOX_REPLY_CANCEL_CONFIRMATION = "CANCEL_CUSTOMER_REPLY";
export const INBOX_REPLY_RESOLVE_SENT = "CONFIRM_CUSTOMER_REPLY_WAS_SENT";
export const INBOX_REPLY_RESOLVE_NOT_SENT = "CONFIRM_CUSTOMER_REPLY_WAS_NOT_SENT";
export const HUMAN_CONFIRMATION_HEADER = "x-bht-human-confirmation";
export const HUMAN_CONFIRMATION_VALUE = "confirmed";

const RequestId = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

const ReplyBase = {
  requestId: RequestId,
  caseId: z.string().min(1).max(128),
  expectedLastIncomingMessageId: z.string().max(512).nullable(),
};

/**
 * Ładunek wysyłki. `.strict()` odrzuca każde nieznane pole, w tym `attachments`:
 * brak załączników jest częścią kontraktu, a nie zwyczajem interfejsu.
 */
export const InboxReplyRequest = z.discriminatedUnion("operation", [
  z
    .object({
      ...ReplyBase,
      operation: z.literal("send"),
      confirmation: z.literal(INBOX_REPLY_CONFIRMATION),
      text: z
        .string()
        .min(1)
        .max(4_000)
        .refine((value) => value === value.trim() && !value.includes("\u0000")),
      /*
       * `recipient` NIE jest polem żądania i `.strict()` odrzuca próbę jego
       * podania. Odbiorca jest funkcją `caseId` i wynika z trwałej wiadomości,
       * bo inaczej jedno spreparowane żądanie wysyłałoby treść przygotowaną
       * dla klienta pod dowolny adres, z naszej zweryfikowanej domeny.
       */
    })
    .strict(),
  z
    .object({
      ...ReplyBase,
      operation: z.literal("cancel"),
      confirmation: z.literal(INBOX_REPLY_CANCEL_CONFIRMATION),
    })
    .strict(),
  z
    .object({
      ...ReplyBase,
      operation: z.literal("resolve_sent"),
      confirmation: z.literal(INBOX_REPLY_RESOLVE_SENT),
    })
    .strict(),
  z
    .object({
      ...ReplyBase,
      operation: z.literal("resolve_not_sent"),
      confirmation: z.literal(INBOX_REPLY_RESOLVE_NOT_SENT),
    })
    .strict(),
]);
export type InboxReplyRequest = z.infer<typeof InboxReplyRequest>;

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  /** Odpowiedź tekstowa (challenge Meta), zamiast JSON. */
  readonly text?: string;
}

function envelope(data: unknown, now: number): HttpResult {
  return { status: 200, body: { ok: true, ts: now, contractVersion: "v1", data } };
}

function failure(status: number, error: string): HttpResult {
  return { status, body: { ok: false, error } };
}

// ── odczyt ───────────────────────────────────────────────────────────────────

export interface ReadRequest {
  readonly runtime: InboxRuntime;
  readonly path: string;
  readonly params: URLSearchParams;
  readonly now: number;
  /** Zaufany principal firmowego czatu widzi `display`; inni najwyżej `model`. */
  readonly trustedChat: boolean;
}

export function handleInboxRead(request: ReadRequest): HttpResult {
  const { runtime, params, now } = request;
  const mode = contentModeOf(params.get("contentMode"), request.trustedChat);

  switch (request.path) {
    case `${INBOX_READ_PREFIX}/health`:
      return envelope(channelFreshness(runtime.store, now), now);

    case `${INBOX_READ_PREFIX}/cases`: {
      const providers = splitList(params.get("providers"));
      const accountKeys = splitList(params.get("accounts"));
      const limit = Number(params.get("limit") ?? "200");
      return envelope(
        queryQueue(runtime.store, {
          now,
          state: params.get("state") === "all" ? "all" : "actionable",
          providers: providers.length ? providers : undefined,
          accountKeys: accountKeys.length ? accountKeys : undefined,
          limit: Number.isFinite(limit) ? limit : 200,
          contentMode: mode,
          cursor: params.get("cursor"),
        }),
        now,
      );
    }

    case `${INBOX_READ_PREFIX}/case`: {
      const caseId = params.get("id");
      if (!caseId) return failure(400, "missing_id");
      const record = runtime.store.getCase(caseId);
      if (!record) return failure(404, "case_not_found");
      const page = queryQueue(runtime.store, { now, state: "all", limit: 500, contentMode: mode });
      const dto = page.cases.find((entry) => entry.caseId === caseId);
      if (!dto) return failure(404, "case_not_found");
      return envelope({ case: dto, freshness: page.freshness }, now);
    }

    case `${INBOX_READ_PREFIX}/messages`: {
      const caseId = params.get("id");
      if (!caseId) return failure(400, "missing_id");
      if (mode === "none") return failure(400, "content_mode_required");
      if (!runtime.store.getCase(caseId)) return failure(404, "case_not_found");
      return envelope(queryMessages(runtime.store, caseId, mode), now);
    }

    default:
      return failure(404, "unknown_inbox_route");
  }
}

function contentModeOf(raw: string | null, trustedChat: boolean): ContentMode {
  if (raw === "display") {
    // Niezredagowany widok jest zastrzeżony dla firmowego czatu. Model nigdy
    // nie może go wybrać sam, bo wtedy redakcja byłaby tylko sugestią.
    return trustedChat ? "display" : "model";
  }
  if (raw === "model") return "model";
  return "none";
}

function splitList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// ── wysyłka ──────────────────────────────────────────────────────────────────

export interface ReplyRequestContext {
  readonly runtime: InboxRuntime;
  readonly body: unknown;
  readonly humanConfirmation: string | null | undefined;
  readonly now: number;
  readonly fetchImpl?: typeof fetch;
}

export async function handleInboxReply(context: ReplyRequestContext): Promise<HttpResult> {
  if (context.humanConfirmation !== HUMAN_CONFIRMATION_VALUE) {
    return failure(428, "human_confirmation_required");
  }

  const parsed = InboxReplyRequest.safeParse(context.body);
  if (!parsed.success) {
    // Bez szczegółów walidacji: mogą zawierać fragment treści klienta.
    return failure(422, "invalid_reply_request");
  }
  const request = parsed.data;
  const { runtime, now } = context;
  const record = runtime.store.getCase(request.caseId);
  if (!record) return failure(404, "case_not_found");

  if (request.operation === "cancel") {
    const result = cancelPrepared(runtime.store, request.requestId, now);
    return result.ok
      ? envelope({ status: "cancelled", requestId: request.requestId }, now)
      : failure(409, result.code ?? "cannot_cancel");
  }

  if (request.operation === "resolve_sent" || request.operation === "resolve_not_sent") {
    const result = resolveUncertain(
      runtime.store,
      request.requestId,
      request.operation === "resolve_sent" ? "sent" : "not_sent",
      now,
    );
    return result.ok
      ? envelope(
          {
            status: request.operation === "resolve_sent" ? "sent" : "failed",
            requestId: request.requestId,
            manuallyResolved: true,
          },
          now,
        )
      : failure(409, result.code ?? "cannot_resolve");
  }

  const transport = buildTransport(context, request);
  if (!transport.ok) return failure(transport.status, transport.error);

  const outcome = await sendReply({
    store: runtime.store,
    requestId: request.requestId,
    caseId: request.caseId,
    text: request.text,
    expectedLastIncomingMessageId: request.expectedLastIncomingMessageId,
    transport: transport.transport,
    now: () => context.now,
  });

  return envelope(toReplyDto(outcome), now);
}

function toReplyDto(outcome: SendOutcome): Record<string, unknown> {
  return {
    status: outcome.status === "rejected" ? "failed" : outcome.status,
    rejected: outcome.status === "rejected",
    requestId: outcome.requestId,
    externalMessageId: outcome.status === "sent" ? outcome.externalMessageId : null,
    code: "code" in outcome ? outcome.code : null,
    message: "message" in outcome ? outcome.message : "Wiadomosc zostala wyslana",
  };
}

type TransportResolution =
  | { readonly ok: true; readonly transport: Parameters<typeof sendReply>[0]["transport"] }
  | { readonly ok: false; readonly status: number; readonly error: string };

function buildTransport(
  context: ReplyRequestContext,
  request: Extract<InboxReplyRequest, { operation: "send" }>,
): TransportResolution {
  const { runtime } = context;
  const record = runtime.store.getCase(request.caseId)!;

  // Odbiorca, dostawca i konto wynikają ze sprawy, nie z żądania.
  const resolved = resolveRecipient(runtime.store, record);
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.code === "provider_uses_dedicated_bridge" ? 409 : 422,
      error: resolved.code,
    };
  }

  if (record.provider === "email") {
    const mailbox = runtime.config.email.find((entry) => entry.accountKey === record.accountKey);
    const apiKey = runtime.config.outbound.resendApiKey;
    // Fail-closed: bez klucza i bez zweryfikowanej skrzynki nie próbujemy.
    // Odpowiedź z cudzego adresu jest gorsza od braku odpowiedzi.
    if (!mailbox || !apiKey) return { ok: false, status: 503, error: "email_outbound_not_configured" };
    // Konto nadawcze musi należeć do źródła sprawy: odpowiedź na wiadomość
    // wysłaną do `hurt@` nie ma prawa wyjść z `sklep@`.
    if (!accountMatchesCase(record, mailbox)) {
      return { ok: false, status: 409, error: "account_does_not_match_case" };
    }
    return {
      ok: true,
      transport: resendTransport({
        apiKey,
        mailbox: { accountKey: mailbox.accountKey, fromAddress: mailbox.address, fromName: mailbox.label },
        to: resolved.recipient,
        subject: record.subject,
        text: request.text,
        inReplyTo: resolved.inReplyTo,
        fetchImpl: context.fetchImpl,
      }),
    };
  }

  if (record.provider === "instagram" || record.provider === "facebook") {
    const account = runtime.config.meta.find((entry) => entry.accountKey === record.accountKey);
    if (!account) return { ok: false, status: 503, error: "meta_outbound_not_configured" };
    if (!accountMatchesCase(record, account)) {
      return { ok: false, status: 409, error: "account_does_not_match_case" };
    }
    return {
      ok: true,
      transport: metaTransport({
        account: {
          provider: account.provider,
          accountKey: account.accountKey,
          accessToken: account.accessToken,
        },
        recipientId: resolved.recipient,
        text: request.text,
        lastIncomingAt: record.lastIncomingAt,
        now: context.now,
        fetchImpl: context.fetchImpl,
      }),
    };
  }

  // Allegro ma własną, przetestowaną bramę w TeaBrew i nie przechodzi tędy.
  return { ok: false, status: 409, error: "provider_uses_dedicated_bridge" };
}

/** Przygotowanie odpowiedzi bez wysyłki: wiąże treść, sprawę i marker. */
export function handleInboxPrepare(context: {
  readonly runtime: InboxRuntime;
  readonly requestId: string;
  readonly caseId: string;
  readonly text: string;
  readonly expectedLastIncomingMessageId: string | null;
  readonly now: number;
}): HttpResult {
  const result = prepareAttempt({
    store: context.runtime.store,
    requestId: context.requestId,
    caseId: context.caseId,
    text: context.text,
    expectedLastIncomingMessageId: context.expectedLastIncomingMessageId,
    now: context.now,
  });
  if (!result.ok) return failure(409, result.code);
  return envelope(
    {
      requestId: result.attempt.requestId,
      status: result.attempt.status,
      contentSha256: result.attempt.contentSha256,
      contentLength: result.attempt.contentLength,
    },
    context.now,
  );
}

// ── webhooki ─────────────────────────────────────────────────────────────────

export interface MetaWebhookContext {
  readonly runtime: InboxRuntime;
  readonly method: string;
  readonly params: URLSearchParams;
  readonly rawBody: string;
  readonly signatureHeader: string | null | undefined;
  readonly now: number;
}

export function handleMetaWebhook(context: MetaWebhookContext): HttpResult {
  const { runtime } = context;
  const appSecret = runtime.config.outbound.metaAppSecret;
  const verifyToken = runtime.config.outbound.metaVerifyToken;

  if (context.method === "GET") {
    if (!verifyToken) return failure(503, "meta_webhook_not_configured");
    const challenge = metaVerificationChallenge({
      mode: context.params.get("hub.mode"),
      token: context.params.get("hub.verify_token"),
      challenge: context.params.get("hub.challenge"),
      expectedToken: verifyToken,
    });
    if (challenge === null) return failure(403, "verification_failed");
    return { status: 200, body: null, text: challenge };
  }

  if (context.method !== "POST") return failure(405, "use_post");
  if (!appSecret) return failure(503, "meta_webhook_not_configured");

  // Podpis PRZED zapisem. Bez tego dowolny host w internecie wstawia sprawy
  // do kolejki obsługi klienta.
  if (!verifyMetaSignature({ rawBody: context.rawBody, header: context.signatureHeader, appSecret })) {
    return failure(401, "invalid_signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(context.rawBody);
  } catch {
    return failure(400, "invalid_json");
  }
  const parsed = MetaWebhookPayload.safeParse(payload);
  if (!parsed.success) {
    // 200, nie 4xx: Meta traktuje kod błędu jako sygnał do ponowienia, a
    // ładunku, którego nie rozumiemy, nie zrozumiemy też za piątym razem.
    return envelope({ accepted: false, reason: "unsupported_payload" }, context.now);
  }

  const events = normalizeMetaPayload(parsed.data, runtime.config.meta, context.now);
  const result = ingestMetaEvents(runtime.store, events);

  for (const mid of result.deliveries) {
    applyDeliveryEvent(runtime.store, { externalMessageId: mid }, "delivered");
  }

  return envelope(
    { accepted: true, stored: result.stored, duplicates: result.duplicates, echoes: result.echoes },
    context.now,
  );
}

export interface ResendWebhookContext {
  readonly runtime: InboxRuntime;
  readonly rawBody: string;
  readonly svixId: string | null | undefined;
  readonly svixTimestamp: string | null | undefined;
  readonly svixSignature: string | null | undefined;
  readonly now: number;
}

export function handleResendWebhook(context: ResendWebhookContext): HttpResult {
  const secret = context.runtime.config.outbound.resendWebhookSecret;
  if (!secret) return failure(503, "resend_webhook_not_configured");

  if (
    !verifyResendWebhook({
      rawBody: context.rawBody,
      svixId: context.svixId,
      svixTimestamp: context.svixTimestamp,
      svixSignature: context.svixSignature,
      secret,
      now: context.now,
    })
  ) {
    return failure(401, "invalid_signature");
  }

  if (!context.svixId || !context.runtime.webhookDedup.accept(context.svixId, context.now)) {
    return envelope({ accepted: true, duplicate: true }, context.now);
  }

  let payload: { type?: unknown; data?: { email_id?: unknown } };
  try {
    payload = JSON.parse(context.rawBody);
  } catch {
    return failure(400, "invalid_json");
  }

  const state = typeof payload.type === "string" ? resendDeliveryState(payload.type) : null;
  const emailId = typeof payload.data?.email_id === "string" ? payload.data.email_id : null;
  if (!state || !emailId) return envelope({ accepted: true, applied: false }, context.now);

  const applied = applyDeliveryEvent(context.runtime.store, { externalMessageId: emailId }, state);
  return envelope({ accepted: true, applied }, context.now);
}
