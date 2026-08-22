import type { InboxMessage } from "../contract.js";
import type { OutboundAttempt } from "../store.js";

/**
 * Wysyłka e-mail przez Resend.
 *
 * Odbiór zostaje na IMAP i MX domeny nie ruszamy: to dwie niezależne ścieżki
 * i mieszanie ich znaczyłoby przenoszenie odbioru firmy przy okazji dodawania
 * wysyłki. Źródłem prawdy dla wysyłki jest ledger plus identyfikator Resend,
 * a nie obecność kopii w folderze „Wysłane" — Resend tam nie zapisuje i nie
 * ma powodu, żeby zapisywał.
 *
 * Dokumentacja: https://resend.com/docs/api-reference/emails/send-email
 *               https://resend.com/docs/dashboard/emails/idempotency-keys
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** Kody, które mogą przyjść już PO przyjęciu wiadomości przez dostawcę. */
const AMBIGUOUS_STATUSES = new Set([408, 425, 429]);
const DEFAULT_TIMEOUT_MS = 20_000;

export interface ResendMailbox {
  readonly accountKey: string;
  /** Adres, z którego klient dostanie odpowiedź. Musi być zweryfikowany. */
  readonly fromAddress: string;
  readonly fromName: string | null;
}

export interface ResendSendInput {
  readonly apiKey: string;
  readonly mailbox: ResendMailbox;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly attempt: OutboundAttempt;
  /** Wiadomość, na którą odpowiadamy — do nagłówków wątkowania. */
  readonly inReplyTo: InboxMessage | null;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export type ResendResult =
  | { readonly status: "sent"; readonly externalMessageId: string }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
  | { readonly status: "uncertain"; readonly code: string; readonly message: string };

/**
 * Nagłówki wątkowania.
 *
 * Bez `In-Reply-To` i `References` klient dostaje odpowiedź jako nowy wątek,
 * a przy trzech skrzynkach i kilku wiadomościach dziennie to jest różnica
 * między rozmową a stosem luźnych maili.
 */
export function threadingHeaders(inReplyTo: InboxMessage | null): Record<string, string> {
  if (!inReplyTo?.rfcMessageId) return {};
  const references = [...inReplyTo.rfcReferences, inReplyTo.rfcMessageId]
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .map((value) => `<${value}>`)
    .join(" ");
  return {
    "In-Reply-To": `<${inReplyTo.rfcMessageId}>`,
    References: references,
  };
}

export function replySubject(original: string | null): string {
  const base = (original ?? "").trim();
  if (!base) return "Odpowiedz na Twoja wiadomosc";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

export async function sendViaResend(input: ResendSendInput): Promise<ResendResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  input.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const from = input.mailbox.fromName
    ? `${input.mailbox.fromName} <${input.mailbox.fromAddress}>`
    : input.mailbox.fromAddress;

  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        // Klucz deterministyczny z ledgera. Ponowienie tej samej próby trafia
        // w ten sam klucz, więc Resend zwraca pierwotny wynik zamiast wysyłać
        // drugą wiadomość.
        "Idempotency-Key": input.attempt.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        // Odpowiedź wychodzi z tej samej tożsamości, do której napisał klient.
        reply_to: input.mailbox.fromAddress,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        headers: threadingHeaders(input.inReplyTo),
      }),
      signal: controller.signal,
    });

    /*
     * Nie każdy kod poniżej 500 znaczy „na pewno nie wysłano".
     *
     * 408 (timeout żądania), 425 (za wcześnie) i 429 (limit tempa) mogą
     * przyjść po tym, jak serwer już przyjął wiadomość. Traktowanie ich jako
     * pewnej porażki prowadzi wprost do ponowienia i drugiej wiadomości
     * u klienta. Klucz idempotencji Resend chroni przed tym przy ponowieniu
     * tej samej próby, ale stan i tak jest niepewny, dopóki nie sprawdzimy.
     */
    if (response.status >= 500 || AMBIGUOUS_STATUSES.has(response.status)) {
      return {
        status: "uncertain",
        code: `http_${response.status}`,
        message: "Resend nie potwierdzil wyniku wysylki",
      };
    }
    if (!response.ok) {
      return {
        status: "failed",
        code: `http_${response.status}`,
        message: "Resend odrzucil wysylke",
      };
    }

    const payload = (await response.json()) as unknown;
    const id =
      payload && typeof payload === "object" && typeof (payload as { id?: unknown }).id === "string"
        ? (payload as { id: string }).id
        : null;
    if (!id) {
      // 200 bez identyfikatora: nie wiemy, czy poszło. Zgadywanie tutaj to
      // wybór między zgubioną odpowiedzią a duplikatem, więc nie zgadujemy.
      return { status: "uncertain", code: "missing_id", message: "Resend nie zwrocil identyfikatora" };
    }
    return { status: "sent", externalMessageId: id };
  } catch (error) {
    const code = controller.signal.aborted ? "timeout" : "network_error";
    return {
      status: "uncertain",
      code,
      message:
        code === "timeout"
          ? "Przekroczono czas oczekiwania na Resend"
          : "Nie udalo sie polaczyc z Resend",
    };
  } finally {
    clearTimeout(timeout);
  }
}
