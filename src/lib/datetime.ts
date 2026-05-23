// SQLite's CURRENT_TIMESTAMP yields "YYYY-MM-DD HH:MM:SS" in UTC, but without a
// `Z` suffix. Safari (and historically some Chrome versions) parse such strings
// as *local* time, which shifts displayed clock times by the user's offset and
// can land messages on the wrong calendar day.
//
// Normalize anything looking like the SQLite shape to ISO UTC before handing it
// to `Date`. Strings that already include `T` and a timezone marker pass through.
export function parseDbDate(value: string | null | undefined): Date {
  if (!value) return new Date(NaN);
  // Already ISO with timezone? Trust it.
  if (/T.*(Z|[+-]\d{2}:?\d{2})$/.test(value)) return new Date(value);
  // SQLite default: "YYYY-MM-DD HH:MM:SS[.fff]"
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  if (m) return new Date(`${m[1]}T${m[2]}Z`);
  // Fallback — let Date try.
  return new Date(value);
}
