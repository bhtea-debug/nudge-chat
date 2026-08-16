/**
 * Normalizacja treści maila do postaci nadającej się do podania modelowi.
 *
 * Dwie osobne rzeczy:
 *  - `toPlainText` / `snippet` — to, co model widzi (musi być użyteczne),
 *  - `redactForAudit` — to, co trafia do logu (musi być bezużyteczne jako
 *    kopia treści; w audycie zostawiamy wyłącznie identyfikatory i liczniki).
 */

const MAX_BODY_CHARS = 8_000;
const SNIPPET_CHARS = 320;

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toPlainText(text?: string | null, html?: string | null): string {
  const t = (text ?? "").trim();
  if (t) return collapse(t);
  if (html) return htmlToPlainText(html);
  return "";
}

function collapse(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function truncateBody(body: string): { body: string; truncated: boolean } {
  if (body.length <= MAX_BODY_CHARS) return { body, truncated: false };
  return { body: body.slice(0, MAX_BODY_CHARS) + "\n[...treść przycięta...]", truncated: true };
}

export function makeSnippet(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length <= SNIPPET_CHARS ? oneLine : oneLine.slice(0, SNIPPET_CHARS) + "…";
}

/**
 * Odcina cytowaną historię z dołu wiadomości. Model dostaje wtedy to, co
 * autor faktycznie napisał teraz, a nie pięć poprzednich odpowiedzi.
 */
const QUOTE_MARKERS: readonly RegExp[] = [
  // Najczęstszy sposób cytowania w ogóle: linia zaczynająca się od ">".
  // Bez tego cała poprzednia korespondencja trafiała do modelu jako nowa treść.
  /^[ \t]*>/m,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*-{2,}\s*Wiadomość oryginalna\s*-{2,}/im,
  /^\s*On .{3,80} wrote:\s*$/im,
  /^\s*W dniu .{3,80}(napisał|pisze).*:\s*$/im,
  /^\s*Od:\s.+\n\s*Wysłano:\s/im,
  /^\s*From:\s.+\n\s*Sent:\s/im,
  /^\s*_{10,}\s*$/m,
];

export function stripQuotedHistory(body: string): string {
  let cut = body.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  const head = body.slice(0, cut).trim();
  // Jeśli po odcięciu nie zostało nic sensownego, lepiej zwrócić całość.
  return head.length >= 20 ? head : body.trim();
}

/**
 * Co wolno zapisać w audycie o wiadomości: identyfikator i rozmiary.
 * Nigdy temat ani treść — temat też bywa danymi klienta.
 */
export function redactForAudit(msg: {
  id: string;
  bodyLength?: number;
}): Record<string, string | number> {
  return {
    messageId: hashShort(msg.id),
    ...(msg.bodyLength !== undefined ? { bodyChars: msg.bodyLength } : {}),
  };
}

/**
 * Maskuje adresy e-mail w tekście przeznaczonym do audytu.
 *
 * Frazę wyszukiwania logujemy, bo to działanie agenta i bez niej nie da się
 * odpowiedzieć, czego szukał. Ale model może szukać po adresie nadawcy —
 * a adresy nadawców do logu nie trafiają. Domena zostaje, bo po niej widać
 * sens zapytania; część lokalna nie.
 */
export function maskAddressesInText(text: string): string {
  return text.replace(/[\w.+-]+@[\w.-]+\.\w+/g, (addr) => {
    const at = addr.indexOf("@");
    return `${addr[0]}***${addr.slice(at)}`;
  });
}

/** Skrót identyfikatora, żeby log dawał się korelować bez ujawniania adresów. */
export function hashShort(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
