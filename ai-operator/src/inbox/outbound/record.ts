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
    replyToAddress: null,
    rfcMessageId: null,
    rfcInReplyTo: null,
    rfcReferences: [],
    isEcho: false,
    bulkHint: false,
    contentFingerprint: contentSha256(input.text).slice(0, 32),
  };

  /*
   * Zapis TRWAŁY, nie zwykły.
   *
   * Ledger jest już w stanie `sent` i wymuszony na dysk. Gdyby wiadomość
   * czekała w buforze, restart zostawiłby stan, w którym ledger mówi
   * „wysłano", a wątek tego nie potwierdza — i przy powtórzeniu żądania
   * dostalibyśmy wczesny zwrot `sent` bez odtworzenia historii.
   */
  if (!store.claimMessageDurable(message)) return null;

  // Przeliczenie sprawy: po naszej odpowiedzi kolejka nie ma już powodu
  // pokazywać jej jako czekającej na reakcję.
  const projected = projectCase(store, attempt.caseId);
  if (projected) store.upsertCase(projected);
  store.flush();
  return message;
}

/**
 * Naprawa historii dla próby, która JUŻ jest w stanie `sent`.
 *
 * Scenariusz: dostawca potwierdził wysyłkę, ledger zapisał `sent`, a proces
 * padł przed zapisem wiadomości do wątku. Powtórzenie tego samego żądania
 * musi uzupełnić brakującą wiadomość i przeliczyć sprawę — BEZ drugiego
 * POST-u do dostawcy, bo wiadomość u klienta już jest.
 *
 * Zwraca `true`, gdy czegoś brakowało i zostało uzupełnione.
 */
export function repairOutgoingMessage(
  store: InboxStore,
  attempt: OutboundAttempt,
  now: number,
): boolean {
  if (attempt.status !== "sent") return false;
  const expectedId = attempt.externalMessageId
    ? outgoingId(attempt.provider, attempt.externalMessageId)
    : `attempt:${attempt.requestId}`;
  const key = { provider: attempt.provider, accountKey: attempt.accountKey };
  if (store.hasMessage(key, expectedId)) return false;

  /*
   * Treść odpowiedzi NIE jest przechowywana w ledgerze (jest tam tylko hash
   * i długość), więc odtworzona wiadomość nie może udawać, że zna tekst.
   * Zapisujemy wpis oznaczony jako odtworzony: wątek pokazuje, że odpowiedź
   * poszła, i mówi wprost, że treść trzeba sprawdzić u dostawcy.
   */
  const restored = recordOutgoingMessage({
    store,
    attempt,
    text: `[Odpowiedź wysłana ${new Date(attempt.completedAt ?? now).toLocaleString("pl-PL")}. ` +
      `Treść odtworzona z ledgera: ${attempt.contentLength} znaków, SHA-256 ${attempt.contentSha256.slice(0, 12)}…]`,
    externalMessageId: attempt.externalMessageId,
    now,
  });
  return restored !== null;
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
