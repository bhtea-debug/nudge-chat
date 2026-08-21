import { z } from "zod";

/**
 * Wąska, serwisowa ścieżka odpowiedzi klientowi.
 *
 * Ten moduł celowo nie importuje rejestru capability ani MCP. Wywołuje go
 * wyłącznie dedykowany endpoint HTTP, po tym jak firmowy czat zebrał jawne
 * potwierdzenie człowieka. BHT Copilot/AI nie dostaje narzędzia wysyłki.
 */

export const CUSTOMER_CASE_REPLY_BRIDGE_PATH = "/internal/customer-cases/allegro/reply";
export const TEABREW_CUSTOMER_CASE_REPLY_PATH = "/ai-operator/customer-case-reply";
export const CUSTOMER_CASE_REPLY_CONFIRMATION = "SEND_ALLEGRO_CUSTOMER_REPLY";
export const HUMAN_CONFIRMATION_HEADER_VALUE = "confirmed";

const RequestId = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Brak `attachments` jest częścią kontraktu, nie konwencją UI: `.strict()`
 * odrzuca zarówno to pole, jak i każde inne nieznane pole.
 */
export const CustomerCaseReplyRequest = z
  .object({
    requestId: RequestId,
    caseId: z.string().trim().min(1).max(128),
    text: z
      .string()
      .min(1)
      .max(2_000)
      .refine((value) => value.trim().length > 0 && !value.includes("\0")),
    expectedLastMessageAt: z.number().int().positive().nullable(),
    confirmation: z.literal(CUSTOMER_CASE_REPLY_CONFIRMATION),
  })
  .strict();

export type CustomerCaseReplyRequest = z.infer<typeof CustomerCaseReplyRequest>;

const TeaBrewReplyResult = z
  .object({
    ok: z.literal(true),
    ts: z.number().int(),
    contractVersion: z.literal("v1"),
    data: z
      .object({
        status: z.enum(["sent", "failed", "uncertain"]),
        requestId: RequestId,
        idempotent: z.boolean(),
        externalMessageId: z.string().nullable(),
        sentAt: z.number().int().positive().nullable(),
        code: z.string().nullable(),
        message: z.string(),
      })
      .strict(),
  })
  .strict();

export interface ReplyBridgeUpstreamConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ReplyBridgeOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const MAX_UPSTREAM_RESPONSE = 64 * 1024;

function ambiguous(status: number, error: string): ReplyBridgeOutcome {
  return { status, body: { ok: false, error, ambiguous: true } };
}

function definitiveUpstreamError(): ReplyBridgeOutcome {
  return {
    status: 502,
    body: { ok: false, error: "upstream_rejected", ambiguous: false },
  };
}

/**
 * Dokładnie jedno wywołanie HTTP. Szczególnie timeoutu i 5xx nie wolno
 * automatycznie ponowić: po takim wyniku nie wiemy, czy Allegro przyjęło
 * wiadomość, więc retry mógłby wysłać ją drugi raz.
 */
export async function forwardCustomerCaseReply(
  request: CustomerCaseReplyRequest,
  config: ReplyBridgeUpstreamConfig,
): Promise<ReplyBridgeOutcome> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 15_000);
  const url = new URL(
    config.baseUrl.replace(/\/+$/, "") + TEABREW_CUSTOMER_CASE_REPLY_PATH,
  );

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/json",
        "content-type": "application/json",
        "x-bht-human-confirmation": HUMAN_CONFIRMATION_HEADER_VALUE,
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: timeout,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return name === "AbortError" || name === "TimeoutError"
      ? ambiguous(504, "upstream_timeout")
      : ambiguous(502, "upstream_unavailable");
  }

  // Każde 5xx jest niejednoznaczne, niezależnie od treści odpowiedzi.
  // Nie ufamy też jej jako komunikatowi dla użytkownika.
  if (response.status >= 500) {
    return ambiguous(502, "upstream_server_error");
  }

  // Autoryzacja i walidacja po stronie TeaBrew kończą się przed próbą wysyłki.
  // Nie przekazujemy ich surowych odpowiedzi (mogą zawierać detale systemu),
  // ale zachowujemy jednoznaczną informację, że retry nie jest potrzebny.
  if (response.status >= 400 && response.status < 500 && response.status !== 409) {
    return definitiveUpstreamError();
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE) {
    return ambiguous(502, "invalid_upstream_response");
  }

  let unknownBody: unknown;
  try {
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_UPSTREAM_RESPONSE) {
      return ambiguous(502, "invalid_upstream_response");
    }
    unknownBody = JSON.parse(raw);
  } catch {
    return ambiguous(502, "invalid_upstream_response");
  }

  const parsed = TeaBrewReplyResult.safeParse(unknownBody);
  if (!parsed.success || parsed.data.data.requestId !== request.requestId) {
    return ambiguous(502, "invalid_upstream_response");
  }

  const expectedStatus =
    response.status === 200
      ? "sent"
      : response.status === 202
        ? "uncertain"
        : response.status === 409
          ? "failed"
          : null;
  if (expectedStatus === null || parsed.data.data.status !== expectedStatus) {
    return ambiguous(502, "invalid_upstream_response");
  }

  // Budujemy odpowiedź od nowa. Nawet gdy upstream kiedyś doda pole, bridge
  // nie zacznie go automatycznie ujawniać firmowemu czatowi.
  return {
    status: response.status,
    body: {
      ok: true,
      ts: parsed.data.ts,
      contractVersion: parsed.data.contractVersion,
      data: {
        status: parsed.data.data.status,
        requestId: parsed.data.data.requestId,
        idempotent: parsed.data.data.idempotent,
        externalMessageId: parsed.data.data.externalMessageId,
        sentAt: parsed.data.data.sentAt,
        code: parsed.data.data.code,
        message: parsed.data.data.message,
      },
    },
  };
}
