/**
 * Ucieczka i formatowanie dla widoków.
 *
 * `esc` jest tu osobno i obejmuje także apostrof — inaczej wartość wstawiona
 * w atrybut w pojedynczych cudzysłowach dałaby wyjście z atrybutu. Treść
 * w tym UI pochodzi z poczty i z czatu, czyli od osób z zewnątrz firmy, więc
 * każde miejsce wstawienia musi zakładać, że ktoś próbuje.
 */
export const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** „18.08 09:14" — bez sekund i bez strefy, bo właściciel czyta to, nie parsuje. */
export const when = (iso: string): string =>
  `${iso.slice(8, 10)}.${iso.slice(5, 7)} ${iso.slice(11, 16)}`;

export const minutesSince = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 60_000;

/**
 * Wiek w języku, w którym ludzie mówią o czasie. „4 min temu" jest użyteczne,
 * „2026-08-18T09:14:22.031Z" nie jest.
 */
export const age = (iso: string): string => {
  const m = minutesSince(iso);
  if (m < 1) return "teraz";
  if (m < 60) return `${Math.round(m)} min temu`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} godz. temu`;
  const d = h / 24;
  if (d < 14) return `${Math.round(d)} dni temu`;
  return when(iso);
};

export const PRIO_LABEL: Record<string, string> = {
  high: "pilne",
  normal: "zwykłe",
  low: "spokojnie",
};
