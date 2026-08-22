import type { InboxMessage } from "../contract.js";
import { contentSha256 } from "../ids.js";
import { projectCase } from "../project.js";
import type { InboxStore, OutboundAttempt } from "../store.js";

/**
 * Zapis wysłanej odpowiedzi jako wiadomości w wątku.
 *
 * Bez tego kroku ledger wiedział o wysyłce, a wątek nie. Sprawa dalej
 * „wymagała reakcji", w historii brakowało naszej wiadomości, a każdy kolejny
 * odczyt wyglądał jak klient bez odpowiedzi — czyli system pokazywał pracę,
 * która została wykonana.
 *
 * Identyfikator bierzemy od dostawcy, żeby późniejsze echo (Meta) albo kopia
 * z folderu wysłanych (IMAP) trafiły w ten sam klucz i zostały wchłonięte
 * przez dedup zamiast utworzyć drugą, bliźniaczą wiadomość.
 */
export function recordOutgoingMessage(input: {
  readonly store: InboxStore;
  readonly attempt: OutboundAttempt;
  readonly text: string;
  readonly externalMessageId: string | null;
  readonly now: number;
}): InboxMessage | null {
  const { store, attempt } = input;
  const record = store.getCase(attempt.caseId);
  if (!record) return null;

  const externalMessageId = input.externalMessageId
    ? outgoingId(attempt.provider, input.externalMessageId)
    : // Dostawca nie zwrócił identyfikatora, ale wysyłka jest potwierdzona:
      // wiążemy wiadomość z próbą, żeby nie zginęła z historii wątku.
      `attempt:${attempt.requestId}`;

  const key = { provider: attempt.provider, accountKey: attempt.accountKey };
  if (store.hasMessage(key, externalMessageId)) return null;

  const message: InboxMessage = {
    provider: attempt.provider,
    accountKey: attempt.accountKey,
    externalConversationId: attempt.externalConversationId,
    externalMessageId,
    caseId: attempt.caseId,
    direction: "outgoing",
    // Czas potwierdzenia przez dostawcę. Nie wymyślamy czasu źródłowego —
    // prawdziwy uzupełni uzgodnienie albo echo.
    sourceCreatedAt: input.now,
    receivedAt: input.now,
    authorLabel: null,
    subject: record.subject,
    body: input.text,
    bodyTruncated: false,
    attachments: [],
    rfcMessageId: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: contentSha256(input.text).slice(0, 32),
  };

  if (!store.claimMessage(message)) return null;

  // Przeliczenie sprawy: po naszej odpowiedzi kolejka nie ma już powodu
  // pokazywać jej jako czekającej na reakcję.
  const projected = projectCase(store, attempt.caseId);
  if (projected) store.upsertCase(projected);
  return message;
}

/**
 * Identyfikator wiadomości wychodzącej w przestrzeni danego dostawcy.
 *
 * Meta zwraca `message_id`, który przyjdzie potem echem w webhooku — używamy
 * go wprost. Resend zwraca własny identyfikator wysyłki, który NIE jest
 * `Message-ID` widocznym potem w folderze wysłanych, więc jest prefiksowany,
 * żeby nie udawał nagłówka RFC.
 */
function outgoingId(provider: string, externalMessageId: string): string {
  if (provider === "instagram" || provider === "facebook") return externalMessageId;
  return `resend:${externalMessageId}`;
}
