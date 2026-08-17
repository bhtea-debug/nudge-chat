import { z } from "zod";

/**
 * Connecteam jako ŹRÓDŁO KOMUNIKACJI — obok poczty, nie zamiast niej.
 *
 * Ten plik jest celowo ostrożny w jednej rzeczy: **nie zakłada, że umiemy czytać
 * wiadomości.** Publiczna dokumentacja dostawcy (sprawdzona 17.08.2026, szczegóły
 * w `docs/DECYZJA-CONNECTEAM.md`) opisuje w sekcji Chat metody WYSYŁANIA
 * wiadomości oraz metodę zwracającą informacje o konwersacjach. Nie opisuje
 * metody zwracającej treść wiadomości ani webhooka na nową wiadomość.
 *
 * Dlatego kształt jest taki: typy są gotowe na treść, a kod pyta konta, co
 * faktycznie potrafi (`probe`), i mówi to wprost. Zbudowanie tego na założeniu
 * „pewnie da się czytać" dałoby produkt, który wygląda na działający i po cichu
 * nie pokazuje połowy komunikacji firmy.
 */

/** Baza API. Stała, nie konfigurowalna — nie ma powodu, by ktoś ją podmieniał. */
export const CONNECTEAM_BASE_URL = "https://api.connecteam.com";

/**
 * Wiadomość z czatu w kształcie, którego potrzebuje reszta systemu.
 * Pola nullowalne są nullowalne NAPRAWDĘ — dostawca nie musi ich podać.
 */
export const ChatMessage = z.object({
  /** Identyfikator wiadomości u dostawcy. */
  id: z.string(),
  conversationId: z.string(),
  conversationName: z.string().nullable(),
  /** ISO 8601. */
  at: z.string(),
  authorName: z.string().nullable(),
  /** Treść albo podgląd. Pusty łańcuch = dostawca nie dał treści. */
  text: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const Conversation = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** `team`, `channel`, `private` — cokolwiek dostawca poda. Nie mapujemy na enum. */
  kind: z.string().nullable(),
});
export type Conversation = z.infer<typeof Conversation>;

/**
 * Co konto FAKTYCZNIE potrafi. Wynik pytania serwera, nie lektury dokumentacji.
 *
 * Każde pole ma wariant „nie wiem" (`null`), bo brak odpowiedzi i odpowiedź
 * negatywna to dwie różne rzeczy, a zlanie ich w `false` jest właśnie tym
 * sposobem, w jaki taki raport zaczyna kłamać.
 */
export interface ConnecteamProbe {
  /** Czy klucz API działa (`GET /me`). */
  readonly authOk: boolean;
  /** Nazwa konta z `/me`, jeśli podane. Do potwierdzenia „to właściwa firma". */
  readonly accountName: string | null;
  /** Czy da się wylistować konwersacje. `null` = nie udało się sprawdzić. */
  readonly canListConversations: boolean | null;
  readonly conversationCount: number | null;
  /**
   * Czy istnieje droga do ODCZYTU treści wiadomości. To jest pytanie
   * rozstrzygające dla całej integracji.
   */
  readonly canReadMessages: boolean;
  /** Ścieżki, które sprawdziłem, wraz z kodem odpowiedzi. Dowód, nie deklaracja. */
  readonly readAttempts: readonly { path: string; status: number | string }[];
  /** Czy webhooki są dostępne i jakie typy zdarzeń konto wymienia. */
  readonly webhooksAvailable: boolean | null;
  readonly webhookEventTypes: readonly string[];
  /** Czy wśród nich jest cokolwiek związanego z czatem. */
  readonly chatWebhookAvailable: boolean;
  /** Rzeczy, których nie dało się sprawdzić i dlaczego. */
  readonly notes: readonly string[];
}

/**
 * Dostawca czatu. Metody odczytu mogą LEGALNIE zwrócić „nie umiem" — i to jest
 * informacja, nie awaria. Dlatego zwracają `null`, a nie rzucają.
 */
export interface ChatProvider {
  /** Sprawdza, co to konto naprawdę udostępnia. */
  probe(): Promise<ConnecteamProbe>;
  /** Lista konwersacji albo `null`, gdy dostawca tego nie daje. */
  listConversations(): Promise<Conversation[] | null>;
  /**
   * Wiadomości od podanego momentu albo `null`, gdy odczyt jest niedostępny.
   * `null` NIE znaczy „brak nowych" — te dwie rzeczy nie mogą wyglądać tak samo.
   */
  messagesSince(since: string): Promise<ChatMessage[] | null>;
  close(): Promise<void>;
}
