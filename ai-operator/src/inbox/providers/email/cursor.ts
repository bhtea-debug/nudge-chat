/**
 * Kursor skrzynki IMAP.
 *
 * Para `uidValidity:uid`, nigdy sam UID. Serwer, który odtworzy folder z kopii,
 * zmienia `uidValidity` i te same numery zaczynają opisywać inne wiadomości.
 * Kursor bez tej wartości po takiej odbudowie przeskakuje całą skrzynkę,
 * a wygląda przy tym jak kursor działający.
 */

export interface ImapCursor {
  readonly uidValidity: number;
  readonly lastUid: number;
}

export function encodeCursor(cursor: ImapCursor): string {
  return `${cursor.uidValidity}:${cursor.lastUid}`;
}

export function decodeCursor(raw: string | null): ImapCursor | null {
  if (!raw) return null;
  const match = /^(\d+):(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const uidValidity = Number(match[1]);
  const lastUid = Number(match[2]);
  if (!Number.isSafeInteger(uidValidity) || !Number.isSafeInteger(lastUid)) return null;
  return { uidValidity, lastUid };
}

/**
 * Zakres do pobrania w zwykłym ticku.
 *
 * `overlap` cofa początek zakresu o kilka UID. Kosztuje tyle, co kilka
 * dodatkowych kopert (dedup i tak je odrzuci), a wyłapuje wiadomość, która
 * pojawiła się w folderze z UID niższym niż zapamiętany — co zdarza się po
 * przenosinach między folderami i przy narzędziach po stronie serwera.
 */
export function incrementalRange(cursor: ImapCursor | null, overlap: number): string {
  if (!cursor) return "1:*";
  const from = Math.max(1, cursor.lastUid + 1 - Math.max(0, overlap));
  return `${from}:*`;
}

/**
 * Zakres uzgodnienia: szeroki skan wstecz, niezależny od kursora.
 *
 * Istnieje po to, żeby luka, która jakimś sposobem powstała (przerwana partia
 * zapisana tylko częściowo, wiadomość doręczona podczas skanu, błąd parsera),
 * została ZNALEZIONA, a nie została na zawsze pod kursorem.
 */
export function reconciliationRange(cursor: ImapCursor | null, lookback: number): string {
  if (!cursor) return "1:*";
  const from = Math.max(1, cursor.lastUid - Math.max(1, lookback));
  return `${from}:*`;
}
