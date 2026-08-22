import type { OutboundAttempt } from "../store.js";
import { metaSendWindow } from "../providers/meta/webhook.js";

/**
 * Wysyłka przez Meta Send API (Messenger i Instagram).
 *
 * Meta nie udostępnia dla tego endpointu wiarygodnego klucza idempotencji.
 * Konsekwencja jest twarda i celowa: po timeout albo 5xx wynik jest
 * `uncertain`, a automatycznego ponowienia NIE MA. Ponowienie bez gwarancji
 * dostawcy jest rzutem monetą między zgubioną a podwójną wiadomością,
 * a podwójna wiadomość u klienta jest gorsza.
 *
 * Dokumentacja:
 * https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api
 * https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api
 */

const DEFAULT_GRAPH_VERSION = "v21.0";
const DEFAULT_TIMEOUT_MS = 20_000;

export interface MetaSendAccount {
  readonly provider: "instagram" | "facebook";
  readonly accountKey: string;
  readonly accessToken: string;
  readonly graphVersion?: string;
}

export interface MetaSendInput {
  readonly account: MetaSendAccount;
  readonly recipientId: string;
  readonly text: string;
  readonly attempt: OutboundAttempt;
  readonly lastIncomingAt: number | null;
  readonly now: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

export type MetaSendResult =
  | { readonly status: "sent"; readonly externalMessageId: string }
  | { readonly status: "failed"; readonly code: string; readonly message: string }
  | { readonly status: "uncertain"; readonly code: string; readonly message: string };

export async function sendViaMeta(input: MetaSendInput): Promise<MetaSendResult> {
  // Okno sprawdzamy PRZED requestem. Wysyłka po jego wygaśnięciu i tak zostanie
  // odrzucona, a każde niepotrzebne żądanie do bramy wysyłki jest okazją do
  // niepewnego wyniku.
  const window = metaSendWindow(input.lastIncomingAt, input.now);
  if (!window.open) {
    return {
      status: "failed",
      code: window.reason ?? "window_closed",
      message:
        window.reason === "customer_never_wrote"
          ? "Klient nie rozpoczal jeszcze rozmowy"
          : "Minelo okno odpowiedzi Meta",
    };
  }

  const version = input.account.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(input.account.accountKey)}/messages`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  input.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: input.recipientId },
        message: { text: input.text },
        messaging_type: "RESPONSE",
      }),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        status: "failed",
        code: "reconnect_required",
        message: "Token konta wygasl albo brakuje uprawnien",
      };
    }
    if (response.status === 429) {
      return { status: "failed", code: "rate_limited", message: "Meta ograniczyla tempo wysylki" };
    }
    if (response.status >= 500) {
      return { status: "uncertain", code: `http_${response.status}`, message: "Meta nie potwierdzila wysylki" };
    }
    if (!response.ok) {
      return { status: "failed", code: `http_${response.status}`, message: "Meta odrzucila wysylke" };
    }

    const payload = (await response.json()) as { message_id?: unknown };
    const id = typeof payload.message_id === "string" ? payload.message_id : null;
    if (!id) {
      return { status: "uncertain", code: "missing_message_id", message: "Meta nie zwrocila identyfikatora" };
    }
    return { status: "sent", externalMessageId: id };
  } catch {
    const code = controller.signal.aborted ? "timeout" : "network_error";
    return {
      status: "uncertain",
      code,
      message: code === "timeout" ? "Przekroczono czas oczekiwania na Meta" : "Nie udalo sie polaczyc z Meta",
    };
  } finally {
    clearTimeout(timeout);
  }
}
