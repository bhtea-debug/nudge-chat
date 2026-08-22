import { createHash } from "node:crypto";
import { contentSha256 } from "../ids.js";
import type { InboxStore, OutboundAttempt } from "../store.js";

/**
 * Ledger odpowiedzi.
 *
 * Zadanie jest jedno: żeby jedno kliknięcie „Wyślij" nigdy nie stało się dwiema
 * wiadomościami u klienta, a żadna awaria transportu nie zamieniła się w cichy
 * duplikat. Wszystko poniżej wynika z tego jednego zdania.
 *
 * Kolejność jest nienegocjowalna: wpis do ledgera powstaje PRZED pierwszym
 * requestem. Restart po zapisie, a przed requestem, zostawia stan `sending`,
 * który blokuje kolejne próby do czasu jawnego sprawdzenia wyniku. Restart
 * bez wpisu zostawia stan, w którym nic nie poszło — i to też wiemy na pewno.
 */

const IDEMPOTENCY_NS = "bht-inbox-idempotency-v1";

export type PrepareRejection =
  | { readonly ok: false; readonly code: "active_attempt_exists"; readonly requestId: string }
  | { readonly ok: false; readonly code: "stale_marker" }
  | { readonly ok: false; readonly code: "request_id_reused" }
  | { readonly ok: false; readonly code: "case_not_found" };

export interface PrepareInput {
  readonly store: InboxStore;
  readonly requestId: string;
  readonly caseId: string;
  readonly text: string;
  /**
   * Marker widziany przez człowieka w chwili zatwierdzania. Jeżeli w międzyczasie
   * klient napisał coś jeszcze, zatwierdzona treść odpowiada na nieaktualny stan
   * i wysyłka musi zostać odrzucona, a nie „poprawiona" automatycznie.
   */
  readonly expectedLastIncomingMessageId: string | null;
  readonly now: number;
}

/**
 * Deterministyczny klucz idempotencji.
 *
 * Wyliczany z requestId i hasha treści, nigdy losowany przy ponowieniu.
 * Klucz losowany na każdą próbę nie jest kluczem idempotencji, tylko ozdobą:
 * dostawca widzi wtedy dwa różne żądania i grzecznie wysyła dwie wiadomości.
 */
export function deriveIdempotencyKey(requestId: string, caseId: string, sha256: string): string {
  return createHash("sha256")
    .update([IDEMPOTENCY_NS, requestId, caseId, sha256].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 48);
}

export function prepareAttempt(
  input: PrepareInput,
): { readonly ok: true; readonly attempt: OutboundAttempt } | PrepareRejection {
  const { store, requestId, caseId, text, now } = input;

  const record = store.getCase(caseId);
  if (!record) return { ok: false, code: "case_not_found" };

  // Ten sam requestId z INNĄ treścią albo inną sprawą to nie ponowienie, tylko
  // pomyłka wołającego. Przepuszczenie jej rozjeżdża ledger z rzeczywistością.
  const sha256 = contentSha256(text);
  const existing = store.getAttempt(requestId);
  if (existing) {
    if (
      existing.caseId !== caseId ||
      existing.contentSha256 !== sha256 ||
      existing.contentLength !== text.length
    ) {
      return { ok: false, code: "request_id_reused" };
    }
    return { ok: true, attempt: existing };
  }

  if (record.lastIncomingMessageId !== input.expectedLastIncomingMessageId) {
    return { ok: false, code: "stale_marker" };
  }

  const active = store.activeAttemptForCase(caseId);
  if (active) return { ok: false, code: "active_attempt_exists", requestId: active.requestId };

  const attempt: OutboundAttempt = {
    requestId,
    caseId,
    provider: record.provider,
    accountKey: record.accountKey,
    externalConversationId: record.externalConversationId,
    contentSha256: sha256,
    contentLength: text.length,
    expectedLastIncomingMessageId: record.lastIncomingMessageId,
    expectedLastIncomingAt: record.lastIncomingAt,
    idempotencyKey: deriveIdempotencyKey(requestId, caseId, sha256),
    status: "prepared",
    externalMessageId: null,
    postStartedAt: null,
    completedAt: null,
    failureCode: null,
    createdAt: now,
    deliveryState: "unknown",
  };
  store.putAttempt(attempt);
  return { ok: true, attempt };
}

/**
 * Anulowanie przygotowanej odpowiedzi („Wróć do edycji").
 *
 * Anuluje WYŁĄCZNIE stan `prepared`. Próba w locie albo niepewna zostaje —
 * inaczej przycisk edycji zdejmowałby blokadę z wysyłki, o której nie wiemy,
 * czy doszła, i pozwalał wysłać drugą.
 */
export function cancelPrepared(
  store: InboxStore,
  requestId: string,
  now: number,
): { readonly ok: boolean; readonly code: string | null } {
  const attempt = store.getAttempt(requestId);
  if (!attempt) return { ok: false, code: "not_found" };
  if (attempt.status !== "prepared") return { ok: false, code: `not_cancellable:${attempt.status}` };
  store.putAttempt({ ...attempt, status: "cancelled", completedAt: now });
  return { ok: true, code: null };
}

/**
 * Przejście `prepared -> sending`. Zwraca false, gdy ktoś już to zrobił.
 *
 * To jest brama przed pojedynczym POST-em. Dwa równoległe requestId nie mogą
 * jej przejść, bo drugie odbija się o `activeAttemptForCase` w `prepareAttempt`,
 * a to samo requestId wchodzi tu tylko raz.
 */
export function beginSending(
  store: InboxStore,
  requestId: string,
  now: number,
): { readonly ok: true; readonly attempt: OutboundAttempt } | { readonly ok: false; readonly code: string } {
  const attempt = store.getAttempt(requestId);
  if (!attempt) return { ok: false, code: "not_found" };
  if (attempt.status === "sending") return { ok: false, code: "already_sending" };
  if (attempt.status !== "prepared") return { ok: false, code: `not_sendable:${attempt.status}` };

  const updated: OutboundAttempt = { ...attempt, status: "sending", postStartedAt: now };
  store.putAttempt(updated);
  return { ok: true, attempt: updated };
}

/**
 * Ponowna walidacja tuż przed wysłaniem: czy klient nie napisał w międzyczasie.
 * Sprawdzenie przy przygotowaniu nie wystarcza, bo między potwierdzeniem
 * a POST-em mija czas, a to właśnie w nim przychodzi nowa wiadomość.
 */
export function markerStillValid(store: InboxStore, attempt: OutboundAttempt): boolean {
  const record = store.getCase(attempt.caseId);
  if (!record) return false;
  return record.lastIncomingMessageId === attempt.expectedLastIncomingMessageId;
}

export function finishSent(
  store: InboxStore,
  requestId: string,
  externalMessageId: string | null,
  now: number,
): void {
  const attempt = store.getAttempt(requestId);
  if (!attempt) return;
  store.putAttempt({ ...attempt, status: "sent", externalMessageId, completedAt: now });
}

export function finishFailed(store: InboxStore, requestId: string, code: string, now: number): void {
  const attempt = store.getAttempt(requestId);
  if (!attempt) return;
  store.putAttempt({ ...attempt, status: "failed", failureCode: code, completedAt: now });
}

/**
 * Wynik niepewny: timeout, 5xx, zerwane połączenie, nieczytelna odpowiedź.
 *
 * NIE ponawiamy automatycznie. Przy dostawcy bez wiarygodnej idempotencji
 * ponowienie jest równie prawdopodobnym sposobem wysłania drugiej wiadomości,
 * co pierwszej. Rozstrzyga człowiek albo odczyt statusu.
 */
export function markUncertain(store: InboxStore, requestId: string, code: string): void {
  const attempt = store.getAttempt(requestId);
  if (!attempt) return;
  store.putAttempt({ ...attempt, status: "uncertain", failureCode: code });
}

export type DeliveryState = OutboundAttempt["deliveryState"];

/** Aktualizacja z webhooka dostawcy. Nie zmienia statusu próby wstecz. */
export function applyDeliveryEvent(
  store: InboxStore,
  match: { readonly requestId?: string; readonly externalMessageId?: string },
  state: DeliveryState,
): boolean {
  const attempt = match.requestId
    ? store.getAttempt(match.requestId)
    : store.listAttempts().find((entry) => entry.externalMessageId === match.externalMessageId) ?? null;
  if (!attempt) return false;
  if (attempt.deliveryState === state) return false;
  store.putAttempt({ ...attempt, deliveryState: state });
  return true;
}

/**
 * Ręczne rozstrzygnięcie stanu niepewnego przez właściciela.
 *
 * Wolno wyłącznie po sprawdzeniu dokładnej wiadomości u dostawcy i nigdy nie
 * wymyśla zewnętrznego czasu wiadomości: `completedAt` to czas ROZSTRZYGNIĘCIA,
 * a nie czas rzekomej wysyłki. Prawdziwy marker uzupełnia kolejny sync.
 */
export function resolveUncertain(
  store: InboxStore,
  requestId: string,
  outcome: "sent" | "not_sent",
  now: number,
  minimumWaitMs = 120_000,
): { readonly ok: boolean; readonly code: string | null } {
  const attempt = store.getAttempt(requestId);
  if (!attempt) return { ok: false, code: "not_found" };
  if (attempt.status !== "uncertain") return { ok: false, code: `not_uncertain:${attempt.status}` };
  if (attempt.postStartedAt !== null && now - attempt.postStartedAt < minimumWaitMs) {
    return { ok: false, code: "too_early" };
  }
  store.putAttempt({
    ...attempt,
    status: outcome === "sent" ? "sent" : "failed",
    failureCode: outcome === "sent" ? null : "manually_resolved_not_sent",
    completedAt: now,
  });
  return { ok: true, code: null };
}
