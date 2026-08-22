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
  return writeOutgoingMessage(input).message;
}

/**
 * Tożsamość wpisu historii dla JEDNEJ próby wysyłki.
 *
 * To jest jedyny dopuszczalny sposób rozpoznania „czy odpowiedź z tej próby
 * jest już w wątku". Identyfikator pochodzi z ledgera, a gdy dostawca go nie
 * zwrócił — jest wyprowadzony deterministycznie z `requestId`, więc ta sama
 * próba daje ten sam klucz przy każdym przebiegu, także po restarcie procesu.
 *
 * Rozpoznawanie po samym KIERUNKU („czy w sprawie jest jakakolwiek wiadomość
 * wychodząca") jest błędem, który kosztował drugą wiadomość u klienta:
 * w sprawie ze starszą odpowiedzią zawsze wychodziło „historia kompletna",
 * więc brakujący wpis nie powstawał już nigdy.
 */
export function outgoingMessageIdFor(attempt: OutboundAttempt): string {
  return attempt.externalMessageId
    ? outgoingId(attempt.provider, attempt.externalMessageId)
    : // Dostawca nie zwrócił identyfikatora, ale wysyłka jest potwierdzona:
      // wiążemy wiadomość z próbą, żeby nie zginęła z historii wątku.
      `attempt:${attempt.requestId}`;
}

/**
 * Czy historia zawiera odpowiedź z TEJ próby.
 *
 * Sprawdzenie idzie po dokładnym identyfikatorze z `outgoingMessageIdFor`,
 * nigdy po kierunku wiadomości ani po ich liczbie. Odpowiedź na to pytanie
 * jest tym, co warstwa HTTP pokazuje jako „historia kompletna”.
 */
export function outgoingMessagePresent(store: InboxStore, attempt: OutboundAttempt): boolean {
  const key = { provider: attempt.provider, accountKey: attempt.accountKey };
  return store.hasMessage(key, outgoingMessageIdFor(attempt));
}

/**
 * Czy historia sprawy jest SPÓJNA z ledgerem dla tej próby.
 *
 * Dokładnie ta wartość jedzie do interfejsu jako „historia kompletna". Próba,
 * która nie jest `sent`, jest spójna z definicji: w wątku nie ma prawa być
 * odpowiedzi, o której nie wiemy, czy poszła. Reguła stoi TU, a nie w warstwie
 * HTTP, żeby nie rozjechała się z tym, co naprawia `restoreOutgoingMessage`.
 */
export function outgoingHistoryComplete(store: InboxStore, attempt: OutboundAttempt): boolean {
  if (attempt.status !== "sent") return true;
  return outgoingMessagePresent(store, attempt);
}

/** Wynik naprawy historii dla jednej próby. */
export interface OutgoingRepair {
  /** Czy wpis historii dla tej próby istnieje PO tym wywołaniu. */
  readonly present: boolean;
  /** Czy wpis trzeba było odtworzyć teraz. Drugi przebieg daje `false`. */
  readonly restoredMessage: boolean;
  /** Czy uzgodnienie zmieniło projekcję sprawy (np. zdjęło „wymaga reakcji"). */
  readonly reprojectedCase: boolean;
  /** Deterministyczny identyfikator wpisu historii dla tej próby. */
  readonly messageId: string;
  /** Niepuste, gdy naprawa nie była możliwa. Nie mylić z „nic nie brakowało". */
  readonly blockedBy: "not_sent" | "case_missing" | "write_failed" | null;
}

/**
 * Idempotentne ODTWORZENIE brakującego wpisu historii dla próby w stanie `sent`.
 *
 * Scenariusz: dostawca potwierdził wysyłkę, ledger zapisał `sent`, a proces
 * padł przed zapisem wiadomości do wątku albo przed przeliczeniem sprawy.
 * Naprawa NIE wykonuje żadnego żądania do dostawcy — wiadomość u klienta już
 * jest, brakuje wyłącznie naszej historii.
 *
 * Naprawiane są DWA osobne braki, bo psują się osobno:
 *  - brak wpisu w wątku (awaria między `finishSent` a zapisem wiadomości),
 *  - nieaktualna projekcja sprawy (awaria między zapisem wiadomości a zapisem
 *    sprawy: wątek ma odpowiedź, a kolejka dalej pokazuje „wymaga reakcji"
 *    i następna osoba pisze do klienta drugi raz).
 */
export function restoreOutgoingMessage(
  store: InboxStore,
  attempt: OutboundAttempt,
  now: number,
): OutgoingRepair {
  const messageId = outgoingMessageIdFor(attempt);
  const nic = { restoredMessage: false, reprojectedCase: false, messageId } as const;

  // Tylko `sent` jest dowodem, że wiadomość u klienta jest. Przy każdym innym
  // stanie dopisanie odpowiedzi do wątku udawałoby wiedzę, której nie mamy.
  // `present` mówi o faktach, nie o statusie: raportujemy realną obecność wpisu.
  if (attempt.status !== "sent") {
    return { ...nic, present: outgoingMessagePresent(store, attempt), blockedBy: "not_sent" };
  }

  // Brak sprawy to nie jest „historia kompletna": nie mamy gdzie zapisać wpisu
  // i trzeba to powiedzieć wprost, zamiast zwracać ciche „nic nie brakowało".
  if (!store.getCase(attempt.caseId)) {
    return { ...nic, present: outgoingMessagePresent(store, attempt), blockedBy: "case_missing" };
  }

  if (outgoingMessagePresent(store, attempt)) {
    // Wpis jest, ale zapis sprawy następował PO nim i mógł nie dojść.
    // Uzgodnienie projekcji jest tanie i zapisuje tylko wtedy, gdy coś się
    // faktycznie zmienia, więc powtórzona naprawa nie miga w interfejsie.
    return {
      ...nic,
      present: true,
      reprojectedCase: reconcileCase(store, attempt.caseId),
      blockedBy: null,
    };
  }

  /*
   * Treść odpowiedzi NIE jest przechowywana w ledgerze (jest tam tylko hash
   * i długość), więc odtworzona wiadomość nie może udawać, że zna tekst.
   * Zapisujemy wpis oznaczony jako odtworzony: wątek pokazuje, że odpowiedź
   * poszła, i mówi wprost, że treść trzeba sprawdzić u dostawcy.
   */
  const written = writeOutgoingMessage({
    store,
    attempt,
    text: `[Odpowiedź wysłana ${new Date(attempt.completedAt ?? now).toLocaleString("pl-PL")}. ` +
      `Treść odtworzona z ledgera: ${attempt.contentLength} znaków, SHA-256 ${attempt.contentSha256.slice(0, 12)}…]`,
    externalMessageId: attempt.externalMessageId,
    now,
  });

  if (!written.message) {
    // Zapis odbity mimo wcześniejszego sprawdzenia: równoległy proces zdążył
    // przed nami albo store odmówił. Stan mówimy taki, jaki jest naprawdę.
    return {
      ...nic,
      present: outgoingMessagePresent(store, attempt),
      blockedBy: "write_failed",
    };
  }
  return {
    present: true,
    restoredMessage: true,
    reprojectedCase: written.reprojectedCase,
    messageId,
    blockedBy: null,
  };
}

/**
 * Naprawa historii dla próby, która JUŻ jest w stanie `sent`.
 *
 * Zwraca `true`, gdy cokolwiek zostało uzupełnione: brakujący wpis w wątku
 * albo nieaktualna projekcja sprawy. `false` znaczy „nie było czego naprawiać”
 * ALBO „nie dało się” — kto potrzebuje tej różnicy, woła `restoreOutgoingMessage`
 * i czyta `blockedBy`.
 */
export function repairOutgoingMessage(
  store: InboxStore,
  attempt: OutboundAttempt,
  now: number,
): boolean {
  const repair = restoreOutgoingMessage(store, attempt, now);
  return repair.restoredMessage || repair.reprojectedCase;
}

// ── zapis ────────────────────────────────────────────────────────────────────

function writeOutgoingMessage(input: {
  readonly store: InboxStore;
  readonly attempt: OutboundAttempt;
  readonly text: string;
  readonly externalMessageId: string | null;
  readonly now: number;
}): { readonly message: InboxMessage | null; readonly reprojectedCase: boolean } {
  const { store, attempt } = input;
  const record = store.getCase(attempt.caseId);
  if (!record) return { message: null, reprojectedCase: false };

  // Ten sam klucz, po którym naprawa rozpoznaje brak: zapis i rozpoznanie
  // muszą liczyć identyfikator w JEDNYM miejscu, inaczej naprawa szuka wpisu,
  // którego zapis nigdy pod tym kluczem nie robił.
  const externalMessageId = input.externalMessageId
    ? outgoingId(attempt.provider, input.externalMessageId)
    : `attempt:${attempt.requestId}`;

  const key = { provider: attempt.provider, accountKey: attempt.accountKey };
  if (store.hasMessage(key, externalMessageId)) return { message: null, reprojectedCase: false };

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
  if (!store.claimMessageDurable(message)) return { message: null, reprojectedCase: false };

  return { message, reprojectedCase: reconcileCase(store, attempt.caseId) };
}

/**
 * Uzgodnienie projekcji sprawy z zapisanymi wiadomościami.
 *
 * Po naszej odpowiedzi kolejka nie ma już powodu pokazywać sprawy jako
 * czekającej na reakcję. Wywołanie jest idempotentne: `upsertCase` zapisuje
 * zdarzenie tylko wtedy, gdy projekcja różni się od zapisanej, więc powtórka
 * nie rozdyma dziennika ani nie miga w interfejsie.
 *
 * Zmianę wykrywamy po TOŻSAMOŚCI rekordu: gdy `upsertCase` pominął zapis,
 * store oddaje ten sam obiekt, co przed wywołaniem. To jest dokładnie
 * odpowiedź na pytanie „czy powstało nowe zdarzenie sprawy", a nie jego
 * przybliżenie porównaniem wybranych pól.
 */
function reconcileCase(store: InboxStore, caseId: string): boolean {
  const projected = projectCase(store, caseId);
  if (!projected) return false;
  const before = store.getCase(caseId);
  store.upsertCase(projected);
  const changed = store.getCase(caseId) !== before;
  store.flush();
  return changed;
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
