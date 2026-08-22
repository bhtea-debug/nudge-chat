import { z } from "zod";

/**
 * Znormalizowany model poczty. Kształt jest celowo niezależny od dostawcy:
 * kanonicznym identyfikatorem jest RFC Message-ID, a nie IMAP UID.
 *
 * Dzięki temu zamiana hostingu poczty (IMAP -> API dostawcy) nie zmienia
 * schematów narzędzi, których używa AI. Rzeczy specyficzne dla dostawcy
 * (uid, ścieżka folderu) siedzą w nieprzejrzystym `providerRef`.
 */

export const MailAddress = z.object({
  name: z.string().nullable(),
  address: z.string(),
});
export type MailAddress = z.infer<typeof MailAddress>;

export const MailAttachmentMeta = z.object({
  filename: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
});
export type MailAttachmentMeta = z.infer<typeof MailAttachmentMeta>;

export const MailMessage = z.object({
  /** RFC Message-ID. Stabilny między dostawcami. */
  id: z.string(),
  /** Nieprzejrzysty uchwyt dostawcy (np. "imap:INBOX:1234"). Nie interpretować. */
  providerRef: z.string(),
  threadId: z.string(),
  subject: z.string(),
  from: MailAddress.nullable(),
  to: z.array(MailAddress),
  cc: z.array(MailAddress),
  /**
   * Nagłówek `Reply-To`, jeżeli jest JEDNOZNACZNY.
   *
   * Formularze kontaktowe i systemy zgłoszeniowe wysyłają z `From: no-reply`,
   * a prawdziwy adres klienta wkładają właśnie tutaj. Odpowiedź na `From`
   * trafiłaby wtedy w czarną dziurę, a my zapisalibyśmy ją jako wysłaną.
   *
   * `null`, gdy nagłówka nie ma ALBO gdy zawiera więcej niż jeden adres:
   * wybieranie jednego z wielu byłoby zgadywaniem, do kogo pisze klient.
   */
  replyTo: MailAddress.nullable(),
  date: z.string().describe("ISO 8601"),
  /** Folder / etykieta w rozumieniu dostawcy, np. "INBOX". */
  folder: z.string(),
  seen: z.boolean(),
  answered: z.boolean(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  attachments: z.array(MailAttachmentMeta),
  /**
   * Wiadomość masowa / automatyczna według NAGŁÓWKÓW RFC, nie według nazwy
   * nadawcy: `List-Unsubscribe`, `Precedence: bulk|list|junk`, `Auto-Submitted`.
   *
   * Istnieje po to, żeby filtr przed modelem był deterministyczny. Zgadywanie
   * po adresie („zawiera noreply") odrzuca prawdziwą korespondencję od firm,
   * które tak mają skonfigurowaną skrzynkę.
   */
  bulk: z.boolean().default(false),
  /** Skrócony podgląd treści. Pełna treść tylko przez mail_get_thread. */
  snippet: z.string(),
});
export type MailMessage = z.infer<typeof MailMessage>;

/** Wiadomość z pełną treścią tekstową — zwracana tylko dla wskazanego wątku. */
export const MailMessageFull = MailMessage.extend({
  body: z.string().describe("Treść tekstowa, po usunięciu HTML, przycięta"),
  bodyTruncated: z.boolean(),
});
export type MailMessageFull = z.infer<typeof MailMessageFull>;

export const MailThread = z.object({
  threadId: z.string(),
  subject: z.string(),
  messageCount: z.number().int().nonnegative(),
  /** Chronologicznie, od najstarszej. */
  messages: z.array(MailMessageFull),
  /**
   * true = wątek jest NIEPEŁNY: część wiadomości, na które wskazują nagłówki,
   * została znaleziona, ale nie dała się odczytać.
   *
   * Istnieje, bo cicho przycięty wątek jest groźniejszy od błędu. Agent nie
   * wymyśli brakującej wiadomości — ale bez tej flagi wyciągnie z braku wniosek
   * „klient nie dostał odpowiedzi", czyli fałsz oparty na zgubionym dowodzie.
   */
  incomplete: z.boolean(),
  /** Na czym polegał brak. null, gdy wątek jest kompletny. */
  incompleteNote: z.string().nullable(),
});
export type MailThread = z.infer<typeof MailThread>;

export interface ListRecentOptions {
  /** Ile wiadomości maksymalnie. */
  readonly limit: number;
  /** Nie starsze niż ta data. */
  readonly since: Date;
  readonly folder?: string;
  readonly unreadOnly?: boolean;
  readonly signal?: AbortSignal;
}

export interface SearchOptions {
  /** Fraza szukana w temacie, nadawcy i treści. */
  readonly query: string;
  readonly limit: number;
  readonly since?: Date;
  readonly folder?: string;
  readonly signal?: AbortSignal;
}

export interface GetThreadOptions {
  /** Message-ID dowolnej wiadomości z wątku. */
  readonly messageId: string;
  readonly maxMessages: number;
  readonly signal?: AbortSignal;
}

/**
 * Wynik listowania i wyszukiwania.
 *
 * `matched` to liczba wiadomości spełniających kryteria PRZED przycięciem do
 * limitu — i jest tu, bo bez niej nie da się odróżnić „w oknie było tyle" od
 * „tyle zmieściło się w limicie".
 *
 * Znalezione na żywo: model poprosił o 30 wiadomości, dostał 30 i napisał, że
 * pobrał „pełne 30 z 7 dni". Nie miał z czego tego wiedzieć — a to jest właśnie
 * twierdzenie bez pokrycia, któremu ma zapobiegać cała reszta tego systemu.
 * Kontrola dowodów tego nie wyłapie, bo wywołanie się odbyło i zwróciło dane.
 *
 * `null` znaczy „ten dostawca nie potrafi podać liczby" — wtedy agent też nie
 * może twierdzić, że ma wszystko. Nie zgaduj zera.
 */
export interface MailListResult {
  readonly messages: MailMessage[];
  readonly matched: number | null;
}

/**
 * Kontrakt dostawcy poczty. MVP dostarcza dwie implementacje: `imap` i `fixture`.
 * Nie ma tu żadnej metody zapisu — ani wysyłki, ani zmiany flag, ani przenoszenia.
 * To jest granica, na której "read-only" jest wymuszone typem, nie zapisem w promptcie.
 */
export interface MailProvider {
  /** Krótki identyfikator do audytu, np. "imap" / "fixture". */
  readonly id: string;
  /** Co ten dostawca realnie potrafi — agent musi umieć powiedzieć "nie umiem". */
  readonly features: {
    readonly serverSideSearch: boolean;
    readonly fullTextSearch: boolean;
    readonly threads: boolean;
  };
  listRecent(opts: ListRecentOptions): Promise<MailListResult>;
  search(opts: SearchOptions): Promise<MailListResult>;
  getThread(opts: GetThreadOptions): Promise<MailThread | null>;
  close(): Promise<void>;
}
