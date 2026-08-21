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
export const CUSTOMER_CASE_REPLY_CHECK_CONFIRMATION = "CHECK_ALLEGRO_CUSTOMER_REPLY";
export const CUSTOMER_CASE_REPLY_RESOLVE_SENT_CONFIRMATION = "CONFIRM_ALLEGRO_REPLY_WAS_SENT";
export const CUSTOMER_CASE_REPLY_RESOLVE_NOT_SENT_CONFIRMATION =
  "CONFIRM_ALLEGRO_REPLY_WAS_NOT_SENT";
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
const CustomerCaseReplyBase = {
    requestId: RequestId,
    caseId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value === value.trim() && !/[\s\0]/.test(value)),
    text: z
      .string()
      .min(1)
      .max(2_000)
      .refine(
        (value) => value === value.trim() && value.length > 0 && !value.includes("\0"),
      ),
    expectedLastMessageAt: z.number().int().positive().nullable(),
};

export const CustomerCaseReplyRequest = z.discriminatedUnion("operation", [
  z.object({
    ...CustomerCaseReplyBase,
    operation: z.literal("send"),
    confirmation: z.literal(CUSTOMER_CASE_REPLY_CONFIRMATION),
  }).strict(),
  z.object({
    ...CustomerCaseReplyBase,
    operation: z.literal("check"),
    confirmation: z.literal(CUSTOMER_CASE_REPLY_CHECK_CONFIRMATION),
  }).strict(),
  z.object({
    ...CustomerCaseReplyBase,
    operation: z.literal("resolve_sent"),
    confirmation: z.literal(CUSTOMER_CASE_REPLY_RESOLVE_SENT_CONFIRMATION),
  }).strict(),
  z.object({
    ...CustomerCaseReplyBase,
    operation: z.literal("resolve_not_sent"),
    confirmation: z.literal(CUSTOMER_CASE_REPLY_RESOLVE_NOT_SENT_CONFIRMATION),
  }).strict(),
]);

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

function definitiveUpstreamError(request: CustomerCaseReplyRequest): ReplyBridgeOutcome {
  if (request.operation !== "send") {
    return ambiguous(502, "upstream_check_rejected");
  }
  return {
    status: 409,
    body: {
      ok: true,
      ts: Date.now(),
      contractVersion: "v1",
      data: {
        status: "failed",
        requestId: request.requestId,
        idempotent: false,
        externalMessageId: null,
        sentAt: null,
        code: "upstream_rejected",
        message: "TeaBrew odrzucił żądanie przed potwierdzoną wysyłką",
      },
    },
  };
}

async function discardResponse(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // Zamknięcie odrzuconego strumienia nie zmienia jednoznaczności wyniku.
  }
}

async function readLimitedJson(response: Response): Promise<unknown | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_RESPONSE) {
    await discardResponse(response);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM_RESPONSE) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Odrzucony strumień nie może zmienić wyniku na jednoznaczny.
    }
    return null;
  }
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
  // TeaBrew może najpierw poczekać na single-flight OAuth, potem sprawdzić
  // wszystkie źródła i dopiero wykonać jeden POST. Bridge ma większy budżet
  // niż pełny upstream, inaczej sam tworzyłby fałszywy wynik ambiguous.
  const timeout = AbortSignal.timeout(config.timeoutMs ?? 150_000);
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
    await discardResponse(response);
    return ambiguous(502, "upstream_server_error");
  }

  // Autoryzacja i walidacja po stronie TeaBrew kończą się przed próbą wysyłki.
  // Nie przekazujemy ich surowych odpowiedzi (mogą zawierać detale systemu),
  // ale zachowujemy jednoznaczną informację, że retry nie jest potrzebny.
  const definitePreActionStatuses = new Set([400, 401, 403, 404, 413, 415, 422]);
  if (definitePreActionStatuses.has(response.status)) {
    await discardResponse(response);
    return definitiveUpstreamError(request);
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 409) {
    await discardResponse(response);
    return ambiguous(502, "upstream_client_error_ambiguous");
  }

  const unknownBody = await readLimitedJson(response);
  if (unknownBody === null) {
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
