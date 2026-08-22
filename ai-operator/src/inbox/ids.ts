import { createHash } from "node:crypto";
import type { SourceKey } from "./contract.js";

/**
 * Tożsamość rekordów w kolejce.
 *
 * Wersja jest częścią każdego hasha (przyrostek `-v1`), bo bez niej zmiana
 * sposobu liczenia po cichu rozdwaja historię: te same rozmowy dostają nowe
 * caseId i kolejka pokazuje duchy obok oryginałów.
 */

const CASE_NS = "bht-inbox-case-v1";
const MSG_NS = "bht-inbox-message-v1";
const FINGERPRINT_NS = "bht-inbox-fingerprint-v1";

function sha256Hex(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    // Długość przed wartością. Bez tego ("ab","c") i ("a","bc") dają ten sam hash.
    hash.update(String(part.length));
    hash.update(" ");
    hash.update(part);
    hash.update(" ");
  }
  return hash.digest("hex");
}

/**
 * Kanoniczny caseId nowego źródła. Allegro NIE przechodzi tą drogą: jego
 * caseId pochodzi z TeaBrew i musi zostać nietknięty, żeby nie zerwać
 * komentarzy, deep linków i audytu sprzed tej zmiany.
 */
export function deriveCaseId(key: SourceKey, externalConversationId: string): string {
  const digest = sha256Hex([CASE_NS, key.provider, key.accountKey, externalConversationId]);
  return `ic_${digest.slice(0, 32)}`;
}

/** Klucz deduplikacji wiadomości. Odporny na retry, restart i powtórzony webhook. */
export function messageDedupKey(key: SourceKey, externalMessageId: string): string {
  return sha256Hex([MSG_NS, key.provider, key.accountKey, externalMessageId]);
}

/**
 * Zastępczy identyfikator wiadomości, gdy źródło nie daje własnego.
 *
 * Dotyczy głównie poczty: `Message-ID` bywa pusty albo powtórzony przez
 * niechlujnego nadawcę, a wtedy dedup po samym nagłówku albo gubi wiadomość,
 * albo skleja dwie różne. Fingerprint dokłada skrzynkę, folder, UIDVALIDITY
 * i UID, czyli współrzędne jednoznaczne w obrębie danej wersji folderu.
 */
export function stableMessageFingerprint(input: {
  readonly key: SourceKey;
  readonly folder: string;
  readonly uidValidity: number;
  readonly uid: number;
  readonly rfcMessageId: string | null;
}): string {
  const digest = sha256Hex([
    FINGERPRINT_NS,
    input.key.provider,
    input.key.accountKey,
    input.folder,
    String(input.uidValidity),
    String(input.uid),
    input.rfcMessageId ?? "",
  ]);
  return `fp_${digest.slice(0, 40)}`;
}

/** SHA-256 treści odpowiedzi. Do ledgera i audytu, zamiast samej treści. */
export function contentSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
