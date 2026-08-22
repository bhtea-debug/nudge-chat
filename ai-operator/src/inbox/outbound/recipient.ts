import type { InboxMessage } from "../contract.js";
import type { InboxStore, StoredCase } from "../store.js";

/**
 * Odbiorca odpowiedzi wyliczany WYŁĄCZNIE z trwałego stanu.
 *
 * Przeglądarka nie może wskazać adresu e-mail ani identyfikatora rozmowy Meta.
 * Gdyby mogła, jedno spreparowane żądanie z przejętej sesji wysyłałoby treść
 * przygotowaną dla klienta A pod adres napastnika — z naszej zweryfikowanej
 * domeny, z pełnym audytem mówiącym, że wszystko było w porządku.
 *
 * Dlatego odbiorca jest FUNKCJĄ `caseId`, a nie parametrem żądania.
 */

export type RecipientResolution =
  | {
      readonly ok: true;
      readonly recipient: string;
      readonly provider: string;
      readonly accountKey: string;
      /** Wiadomość, na którą odpowiadamy — do nagłówków wątkowania. */
      readonly inReplyTo: InboxMessage | null;
    }
  | { readonly ok: false; readonly code: string };

/** Adres nadawcy w kopercie e-mail bywa inny niż w nagłówku From. */
function isPlausibleAddress(value: string | null): value is string {
  if (!value) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function resolveRecipient(store: InboxStore, record: StoredCase): RecipientResolution {
  const messages = store.messagesForCase(record.caseId);
  const incoming = messages.filter((message) => message.direction === "incoming" && !message.isEcho);
  const last = incoming[incoming.length - 1] ?? null;

  if (record.provider === "email") {
    // Adres bierzemy z OSTATNIEJ wiadomości klienta, nie z pola sprawy:
    // `participantLabel` jest polem prezentacyjnym i mogłoby zostać nadpisane
    // przez projekcję, a odbiorca musi wynikać z konkretnej wiadomości.
    const address = last?.authorLabel ?? null;
    if (!isPlausibleAddress(address)) return { ok: false, code: "recipient_unknown" };
    return {
      ok: true,
      recipient: address.toLowerCase(),
      provider: record.provider,
      accountKey: record.accountKey,
      inReplyTo: last,
    };
  }

  if (record.provider === "instagram" || record.provider === "facebook") {
    // Rozmowa Meta jest identyfikowana przez klienta; to jest jednocześnie
    // identyfikator odbiorcy Send API.
    const counterpart = record.externalConversationId.trim();
    if (!counterpart) return { ok: false, code: "recipient_unknown" };
    return {
      ok: true,
      recipient: counterpart,
      provider: record.provider,
      accountKey: record.accountKey,
      inReplyTo: last,
    };
  }

  // Allegro ma własną bramę w TeaBrew i nie przechodzi tą drogą.
  return { ok: false, code: "provider_uses_dedicated_bridge" };
}

/**
 * Czy konto nadawcze naprawdę należy do źródła sprawy.
 *
 * Bez tej kontroli odpowiedź na wiadomość wysłaną do `hurt@` mogłaby wyjść
 * z `sklep@`, a klient dostałby ją od kogoś, do kogo nie pisał.
 */
export function accountMatchesCase(
  record: Pick<StoredCase, "provider" | "accountKey">,
  account: { readonly accountKey: string },
): boolean {
  return record.accountKey === account.accountKey;
}
