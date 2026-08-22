import type { InboxStore, OutboundAttempt } from "../store.js";
import {
  beginSending,
  finishFailed,
  finishSent,
  markUncertain,
  markerStillValid,
  prepareAttempt,
} from "./ledger.js";
import { recordOutgoingMessage } from "./record.js";
import { replySubject, sendViaResend, type ResendMailbox, type ResendResult } from "./resend.js";
import { sendViaMeta, type MetaSendAccount, type MetaSendResult } from "./meta-send.js";

/**
 * Jedna droga wysyłki dla wszystkich dostawców.
 *
 * Kolejność kroków jest identyczna niezależnie od kanału, bo niezależne od
 * kanału są też sposoby, na jakie wysyłka może pójść źle: podwójne kliknięcie,
 * nowa wiadomość klienta w międzyczasie, timeout w połowie, restart procesu.
 * Różni się wyłącznie ostatni krok — samo wywołanie API dostawcy.
 */

export type SendOutcome =
  | { readonly status: "sent"; readonly requestId: string; readonly externalMessageId: string | null }
  | { readonly status: "failed"; readonly requestId: string; readonly code: string; readonly message: string }
  | { readonly status: "uncertain"; readonly requestId: string; readonly code: string; readonly message: string }
  | { readonly status: "rejected"; readonly requestId: string; readonly code: string; readonly message: string };

export interface SendTransport {
  /** Wysyła i zwraca wynik. Nie wolno mu ponawiać samodzielnie. */
  send(attempt: OutboundAttempt): Promise<ResendResult | MetaSendResult>;
}

export interface SendRequest {
  readonly store: InboxStore;
  readonly requestId: string;
  readonly caseId: string;
  readonly text: string;
  readonly expectedLastIncomingMessageId: string | null;
  readonly transport: SendTransport;
  readonly now: () => number;
}

export async function sendReply(request: SendRequest): Promise<SendOutcome> {
  const { store, requestId } = request;

  const prepared = prepareAttempt({
    store,
    requestId,
    caseId: request.caseId,
    text: request.text,
    expectedLastIncomingMessageId: request.expectedLastIncomingMessageId,
    now: request.now(),
  });
  if (!prepared.ok) {
    return {
      status: "rejected",
      requestId,
      code: prepared.code,
      message: rejectionMessage(prepared.code),
    };
  }

  // Idempotencja na poziomie naszego API: powtórzone żądanie z tym samym
  // requestId dostaje wynik pierwotnej próby, a nie drugą wysyłkę.
  const existing = prepared.attempt;
  if (existing.status === "sent") {
    return { status: "sent", requestId, externalMessageId: existing.externalMessageId };
  }
  if (existing.status === "failed") {
    return {
      status: "failed",
      requestId,
      code: existing.failureCode ?? "failed",
      message: "Wiadomosc nie zostala wyslana",
    };
  }
  if (existing.status === "uncertain") {
    return {
      status: "uncertain",
      requestId,
      code: existing.failureCode ?? "uncertain",
      message: "Wynik poprzedniej proby jest nieznany",
    };
  }
  if (existing.status === "cancelled") {
    return { status: "rejected", requestId, code: "cancelled", message: "Proba zostala anulowana" };
  }

  const started = beginSending(store, requestId, request.now());
  if (!started.ok) {
    return { status: "rejected", requestId, code: started.code, message: "Wysylka jest juz w toku" };
  }

  // Ostatnia bramka przed POST-em: klient mógł napisać między potwierdzeniem
  // a tym momentem, a wtedy zatwierdzona treść odpowiada na nieaktualny stan.
  if (!markerStillValid(store, started.attempt)) {
    finishFailed(store, requestId, "stale_marker", request.now());
    return {
      status: "failed",
      requestId,
      code: "stale_marker",
      message: "Klient napisal ponownie, potwierdz odpowiedz jeszcze raz",
    };
  }

  let result: ResendResult | MetaSendResult;
  try {
    result = await request.transport.send(started.attempt);
  } catch {
    // Wyjątek transportu jest nieodróżnialny od timeoutu: nie wiemy, czy
    // request doszedł. Bez gwarancji dostawcy nie wolno ponowić.
    markUncertain(store, requestId, "transport_exception");
    return {
      status: "uncertain",
      requestId,
      code: "transport_exception",
      message: "Nie udalo sie potwierdzic wyniku wysylki",
    };
  }

  if (result.status === "sent") {
    finishSent(store, requestId, result.externalMessageId, request.now());
    /*
     * Odpowiedź staje się częścią wątku.
     *
     * Bez tego kroku ledger wiedział o wysyłce, a wątek nie: sprawa dalej
     * „wymagała reakcji", w historii nie było naszej wiadomości, a kolejny
     * odczyt wyglądał jak klient bez odpowiedzi. Późniejsze echo albo kopia
     * z folderu wysłanych trafia w ten sam identyfikator i jest wchłaniana
     * przez dedup zamiast tworzyć duplikat.
     */
    recordOutgoingMessage({
      store,
      attempt: started.attempt,
      text: request.text,
      externalMessageId: result.externalMessageId,
      now: request.now(),
    });
    return { status: "sent", requestId, externalMessageId: result.externalMessageId };
  }
  if (result.status === "failed") {
    finishFailed(store, requestId, result.code, request.now());
    return { status: "failed", requestId, code: result.code, message: result.message };
  }
  markUncertain(store, requestId, result.code);
  return { status: "uncertain", requestId, code: result.code, message: result.message };
}

function rejectionMessage(code: string): string {
  switch (code) {
    case "active_attempt_exists":
      return "Dla tej sprawy trwa juz inna wysylka";
    case "stale_marker":
      return "Klient napisal ponownie, potwierdz odpowiedz jeszcze raz";
    case "request_id_reused":
      return "Ten sam identyfikator zadania uzyty z inna trescia";
    case "case_not_found":
      return "Nie znaleziono sprawy";
    default:
      return "Wysylka odrzucona";
  }
}

/** Transport e-mail: Resend z deterministycznym kluczem idempotencji. */
export function resendTransport(input: {
  readonly apiKey: string;
  readonly mailbox: ResendMailbox;
  readonly to: string;
  readonly subject: string | null;
  readonly text: string;
  readonly inReplyTo: Parameters<typeof sendViaResend>[0]["inReplyTo"];
  readonly fetchImpl?: typeof fetch;
}): SendTransport {
  return {
    send: (attempt) =>
      sendViaResend({
        apiKey: input.apiKey,
        mailbox: input.mailbox,
        to: input.to,
        subject: replySubject(input.subject),
        text: input.text,
        attempt,
        inReplyTo: input.inReplyTo,
        fetchImpl: input.fetchImpl,
      }),
  };
}

/** Transport Meta: bez idempotencji dostawcy, więc bez automatycznych retry. */
export function metaTransport(input: {
  readonly account: MetaSendAccount;
  readonly recipientId: string;
  readonly text: string;
  readonly lastIncomingAt: number | null;
  readonly now: number;
  readonly fetchImpl?: typeof fetch;
}): SendTransport {
  return {
    send: (attempt) =>
      sendViaMeta({
        account: input.account,
        recipientId: input.recipientId,
        text: input.text,
        attempt,
        lastIncomingAt: input.lastIncomingAt,
        now: input.now,
        fetchImpl: input.fetchImpl,
      }),
  };
}
