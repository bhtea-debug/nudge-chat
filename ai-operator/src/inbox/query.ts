import type { ContentMode, InboxCase, InboxMessage } from "./contract.js";
import { channelFreshness, mayReportEmptyQueue, type ChannelFreshness } from "./health.js";
import type { InboxStore, StoredCase } from "./store.js";
import { evaluateSla, type Priority, type SlaState } from "./sla.js";
import { resolveRecipient } from "./outbound/recipient.js";
import { metaSendWindow } from "./providers/meta/webhook.js";

/**
 * Odczyt kolejki dla firmowego czatu.
 *
 * Domyślnie BEZ treści. Temat i podgląd wiadomości są danymi klienta, więc
 * jadą tylko wtedy, gdy odbiorca jawnie o nie poprosi i poda tryb. Zwykłe
 * odświeżanie listy nie ma prawa przenosić korespondencji przez sieć.
 */

export interface CaseDto {
  readonly caseId: string;
  readonly provider: string;
  readonly accountKey: string;
  readonly sourceLabel: string;
  readonly participantLabel: string | null;
  readonly orderRef: string | null;
  readonly subject: string | null;
  readonly preview: string | null;
  readonly firstSeenAt: number;
  readonly lastMessageAt: number | null;
  readonly lastIncomingAt: number | null;
  readonly lastIncomingMessageId: string | null;
  readonly waitingMs: number | null;
  readonly messageCount: number;
  readonly requiresResponse: boolean;
  readonly pendingAction: boolean;
  readonly hasAttachments: boolean;
  readonly sourceClosed: boolean;
  readonly classifierVersion: number;
  readonly classificationReason: string;
  /** Sprawa niejednoznaczna — do potwierdzenia przez człowieka. */
  readonly needsReview: boolean;
  readonly priority: Priority | null;
  readonly slaState: SlaState | null;
  readonly responseDueAt: number | null;
  readonly serviceMaxAt: number | null;
  /**
   * Odbiorca i konto nadawcze wyliczone SERWEROWO.
   *
   * Interfejs ma pokazać człowiekowi, dokąd i z czego pójdzie odpowiedź,
   * zanim ją zatwierdzi — a wartości muszą pochodzić z tego samego źródła,
   * którego użyje wysyłka. Podgląd liczony osobno w przeglądarce mógłby
   * pokazać co innego, niż faktycznie poleci.
   */
  readonly replyTo: string | null;
  readonly replyFrom: string | null;
  readonly replyWindowClosesAt: number | null;
}

export interface QueueResult {
  readonly cases: CaseDto[];
  readonly count: number;
  readonly truncated: boolean;
  /**
   * Nieprzezroczysty kursor następnej strony. `null` znaczy koniec listy —
   * i tylko wtedy odbiorca ma prawo uznać widok za kompletny.
   */
  readonly nextCursor: string | null;
  readonly freshness: ChannelFreshness;
  /**
   * false = nie wolno napisać „brak spraw". Pusta lista przy zepsutym źródle
   * to brak wiedzy, nie brak pracy.
   */
  readonly completeView: boolean;
  readonly contentMode: ContentMode;
}

export interface QueueOptions {
  readonly now: number;
  /** Adresy skrzynek: potrzebne do podglądu konta nadawczego. */
  readonly mailboxes?: ReadonlyMap<string, string>;
  readonly state?: "actionable" | "all";
  readonly providers?: readonly string[];
  readonly accountKeys?: readonly string[];
  readonly limit?: number;
  readonly contentMode?: ContentMode;
  readonly cursor?: string | null;
}

const DEFAULT_LIMIT = 200;
const PREVIEW_CHARS = 140;

export function queryQueue(store: InboxStore, options: QueueOptions): QueueResult {
  const contentMode = options.contentMode ?? "none";
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 500);
  const state = options.state ?? "actionable";

  let cases = store.listCases();
  if (options.providers?.length) {
    const allowed = new Set(options.providers);
    cases = cases.filter((entry) => allowed.has(entry.provider));
  }
  if (options.accountKeys?.length) {
    const allowed = new Set(options.accountKeys);
    cases = cases.filter((entry) => allowed.has(entry.accountKey));
  }
  if (state === "actionable") {
    cases = cases.filter((entry) => entry.requiresResponse || entry.pendingAction);
  }

  /*
   * Sortowanie musi być całkowite, inaczej kursor nie jest stabilny: dwie
   * sprawy z tym samym czasem mogłyby zamieniać się miejscami między stronami
   * i jedna z nich nie trafiłaby na żadną.
   */
  cases.sort((a, b) => {
    const byTime = sortKey(b) - sortKey(a);
    return byTime !== 0 ? byTime : a.caseId.localeCompare(b.caseId);
  });

  const total = cases.length;
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  /*
   * Keyset: bierzemy rekordy ostro „mniejsze" od kursora w porządku kolejki.
   * Żadnego szukania indeksu — pozycja jest określona samym kluczem, więc
   * zniknięcie rekordu z kursora niczego nie cofa.
   */
  const remaining = cursor ? cases.filter((entry) => isBelowCursor(entry, cursor)) : cases;
  const page = remaining.slice(0, limit);
  const truncated = page.length < remaining.length;

  return {
    cases: page.map((entry) => toDto(store, entry, options.now, contentMode, options.mailboxes)),
    count: total,
    truncated,
    /*
     * Postęp jest zagwarantowany: ostatni rekord strony jest ostro mniejszy od
     * kursora, którym go pobrano, a następna strona bierze tylko rekordy ostro
     * mniejsze od niego. Pusta strona nie ma następnika, więc pętla po stronach
     * zawsze się kończy.
     */
    nextCursor: truncated && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
    freshness: channelFreshness(store, options.now),
    completeView: mayReportEmptyQueue(channelFreshness(store, options.now)),
    contentMode,
  };
}


/**
 * Klucz porządku kolejki. Jedno miejsce, żeby sortowanie i kursor nie mogły
 * rozjechać się w interpretacji „kiedy ta sprawa ostatnio drgnęła".
 */
function sortKey(entry: StoredCase): number {
  return entry.lastMessageAt ?? entry.firstSeenAt;
}

/**
 * Kursor keyset: DOKŁADNIE klucz sortowania ostatniej sprawy wydanej strony,
 * czyli czas i caseId. Nie offset i nie „pozycja sprawy o tym identyfikatorze".
 *
 * Poprzednia wersja niosła te same dwie wartości, ale czas ignorowała i szukała
 * bieżącego indeksu po caseId. To był nazwany offset: gdy sprawa z kursora
 * zniknęła albo wypadła z filtra „do zrobienia", odczyt wracał na początek i
 * powtarzał niemal całą poprzednią stronę — przy stronie 200 do 199 slotów
 * zmarnowanych, a przy state="actionable" widok krążył po pierwszej stronie
 * przy wiecznie prawdziwym `truncated`.
 *
 * KONTRAKT wobec zmian w trakcie stronicowania (kolejka żyje pod czytającym):
 * - sprawa, która po wydaniu strony przesunęła się W GÓRĘ nad kursor (dostała
 *   nową wiadomość), nie wejdzie już do tego przewijania. Świadomie: żeby ją
 *   złapać, trzeba by cofnąć kursor, czyli zrezygnować z postępu. Klient
 *   zobaczy ją przy następnym odczycie od góry, bo wtedy jest na czele;
 * - sprawa, która przesunęła się W DÓŁ pod kursor, może wyjść drugi raz.
 *   Duplikat jest tani, luka nie jest;
 * - sprawa DODANA nad kursorem nie należy do tego przewijania, dodana pod
 *   kursorem — należy;
 * - sprawa z kursora może zniknąć albo wypaść z filtra bez żadnych skutków:
 *   kursor jest kluczem w porządku, nie wskaźnikiem na rekord;
 * - GWARANCJA: żadna sprawa, która przez cały czas przewijania siedzi pod
 *   kursorem, nie zostanie pominięta. Na tym stoi obietnica `nextCursor ===
 *   null` znaczy widok kompletny.
 */
function encodeCursor(entry: StoredCase): string {
  return Buffer.from(`${sortKey(entry)}|${entry.caseId}`, "utf8").toString("base64url");
}

interface QueueCursor {
  readonly sortKey: number;
  readonly caseId: string;
}

function decodeCursor(cursor: string): QueueCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.lastIndexOf("|");
  if (separator < 0) return null;
  const rawKey = decoded.slice(0, separator).trim();
  const caseId = decoded.slice(separator + 1);
  const key = Number(rawKey);
  /*
   * Kursor uszkodzony albo z kształtu, którego nie umiemy zinterpretować.
   * Czytamy od początku: powtórka jest niewygodna, ale przewidywalna, a pusty
   * wynik z NaN w porównaniach wyglądałby jak koniec listy i skłamałby
   * o kompletności widoku.
   */
  if (rawKey.length === 0 || caseId.length === 0 || !Number.isFinite(key)) return null;
  return { sortKey: key, caseId };
}

/**
 * Czy sprawa leży ostro PONIŻEJ kursora w porządku kolejki: malejąco po czasie,
 * a przy remisie rosnąco po caseId. Porównanie identyfikatorów musi być tym
 * samym, którego używa sortowanie, inaczej rekordy o identycznym czasie
 * wypadałyby po obu stronach granicy.
 */
function isBelowCursor(entry: StoredCase, cursor: QueueCursor): boolean {
  const key = sortKey(entry);
  if (key !== cursor.sortKey) return key < cursor.sortKey;
  return entry.caseId.localeCompare(cursor.caseId) > 0;
}

/**
 * Pojedyncza sprawa po identyfikatorze.
 *
 * Istnieje, bo poprzednia droga budowała pięćsetelementową stronę kolejki
 * wyłącznie po to, żeby wybrać z niej jeden rekord — a sprawa spoza tej setki
 * (starsza, zamknięta, spoza filtra) była wtedy nie do otwarcia mimo że
 * istnieje w magazynie. Odczyt po kluczu nie ma tego progu i nie zależy od
 * tego, jak duża jest kolejka.
 */
export function queryCase(
  store: InboxStore,
  caseId: string,
  now: number,
  contentMode: ContentMode = "none",
  mailboxes?: ReadonlyMap<string, string>,
): { case: CaseDto; freshness: ChannelFreshness } | null {
  const entry = store.getCase(caseId);
  if (!entry) return null;
  return {
    case: toDto(store, entry, now, contentMode, mailboxes),
    freshness: channelFreshness(store, now),
  };
}

function toDto(
  store: InboxStore,
  entry: StoredCase,
  now: number,
  mode: ContentMode,
  mailboxes?: ReadonlyMap<string, string>,
): CaseDto {
  const showContent = mode !== "none";
  const preview = showContent ? buildPreview(store, entry, mode) : null;
  const sla = evaluateSla({
    waitingSince: entry.lastIncomingAt,
    requiresResponse: entry.requiresResponse,
    pendingAction: entry.pendingAction,
    needsReview: entry.needsReview,
    now,
  });
  const recipient = resolveRecipient(store, entry);
  const window =
    entry.provider === "instagram" || entry.provider === "facebook"
      ? metaSendWindow(entry.lastIncomingAt, now)
      : null;
  return {
    caseId: entry.caseId,
    provider: entry.provider,
    accountKey: entry.accountKey,
    sourceLabel: sourceLabel(entry),
    participantLabel: showContent ? entry.participantLabel : null,
    orderRef: entry.orderRef,
    subject: showContent ? entry.subject : null,
    preview,
    firstSeenAt: entry.firstSeenAt,
    lastMessageAt: entry.lastMessageAt,
    lastIncomingAt: entry.lastIncomingAt,
    lastIncomingMessageId: entry.lastIncomingMessageId,
    // Czas oczekiwania liczymy od ostatniej wiadomości KLIENTA. Od naszej
    // ostatniej odpowiedzi liczyłby czas, w którym piłka jest po jego stronie.
    waitingMs:
      entry.requiresResponse && entry.lastIncomingAt !== null
        ? Math.max(0, now - entry.lastIncomingAt)
        : null,
    messageCount: entry.messageCount,
    requiresResponse: entry.requiresResponse,
    pendingAction: entry.pendingAction,
    hasAttachments: entry.hasAttachments,
    sourceClosed: entry.sourceClosed,
    classifierVersion: entry.classifierVersion,
    classificationReason: entry.classificationReason,
    needsReview: entry.needsReview,
    priority: sla.priority,
    slaState: sla.state,
    responseDueAt: sla.responseDueAt,
    serviceMaxAt: sla.serviceMaxAt,
    // Odbiorca jest daną klienta: bez uprawnienia do treści pokazujemy null,
    // a nie adres „w celach informacyjnych".
    replyTo: showContent && recipient.ok ? recipient.recipient : null,
    replyFrom: mailboxes?.get(entry.accountKey) ?? null,
    replyWindowClosesAt: window?.expiresAt ?? null,
  };
}

function buildPreview(store: InboxStore, entry: StoredCase, mode: ContentMode): string | null {
  const messages = store.messagesForCase(entry.caseId);
  const last = messages[messages.length - 1];
  if (!last) return null;
  const text = mode === "model" ? redactForModel(last.body) : last.body;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= PREVIEW_CHARS ? oneLine : `${oneLine.slice(0, PREVIEW_CHARS)}…`;
}

export function sourceLabel(entry: Pick<InboxCase, "provider" | "accountKey">): string {
  switch (entry.provider) {
    case "allegro":
      return entry.accountKey === "dyskusje" ? "Allegro Dyskusje" : "Allegro";
    case "email":
      return `E-mail ${entry.accountKey}`;
    case "instagram":
      return "Instagram";
    case "facebook":
      return "Facebook";
    default:
      return entry.provider;
  }
}

/**
 * Redakcja przed analizą AI: e-mail, telefon i kod pocztowy.
 *
 * Model dostaje sens sprawy, nie dane kontaktowe klienta. Redakcja jest tu,
 * a nie tylko po stronie czatu, bo pierwsza linia obrony ma stać przy danych,
 * a nie przy tym, kto o nie prosi.
 */
export function redactForModel(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
    .replace(/(?:\+?\d[\d\s-]{7,}\d)/g, "[telefon]")
    .replace(/\b\d{2}-\d{3}\b/g, "[kod pocztowy]");
}

export interface MessageDto {
  readonly externalMessageId: string;
  readonly direction: InboxMessage["direction"];
  readonly authorLabel: string | null;
  readonly subject: string | null;
  readonly text: string | null;
  readonly sourceCreatedAt: number | null;
  readonly isEcho: boolean;
  readonly attachments: Array<{ id: string; fileName: string | null; mimeType: string | null }>;
}

export function queryMessages(
  store: InboxStore,
  caseId: string,
  mode: Exclude<ContentMode, "none">,
): { readonly caseId: string; readonly messages: MessageDto[]; readonly attachmentsExcluded: true } {
  const messages = store.messagesForCase(caseId).map((message): MessageDto => ({
    externalMessageId: message.externalMessageId,
    direction: message.direction,
    authorLabel: mode === "model" ? null : message.authorLabel,
    subject: message.subject,
    text: mode === "model" ? redactForModel(message.body) : message.body,
    sourceCreatedAt: message.sourceCreatedAt,
    isEcho: message.isEcho,
    // Same metadane. Plik ani URL nigdy nie opuszczają adaptera.
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    })),
  }));
  return { caseId, messages, attachmentsExcluded: true };
}
