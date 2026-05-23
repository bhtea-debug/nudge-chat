// Slash-command parser. Returns null if the input is not a recognized command
// — caller should fall through to a normal message send. Each command returns
// an "intent" the composer turns into an API call.

export type SlashIntent =
  | { kind: 'message'; content: string }
  | { kind: 'poll'; question: string; options: string[]; multiple: boolean }
  | { kind: 'remind'; remindAt: Date; text: string }
  | { kind: 'unknown'; command: string; hint: string };

export interface SlashHelp {
  command: string;
  syntax: string;
  description: string;
  example: string;
}

export const SLASH_HELP: SlashHelp[] = [
  { command: '/poll',  syntax: '/poll Pytanie | opcja1 | opcja2 [| --multi]', description: 'Stwórz ankietę', example: '/poll Pizza dziś? | Tak | Nie | Może' },
  { command: '/remind', syntax: '/remind <kiedy> <treść>', description: 'Ustaw przypomnienie (np. 30m, 2h, 1d, 09:00)', example: '/remind 2h sprawdzić maila' },
  { command: '/me',    syntax: '/me <akcja>',         description: 'Wiadomość w trzeciej osobie',  example: '/me się cieszy' },
  { command: '/shrug', syntax: '/shrug',              description: 'Wstaw ¯\\_(ツ)_/¯',            example: '/shrug' },
];

function parseRemindOffset(token: string, now: Date): Date | null {
  // 30m, 2h, 1d
  const rel = /^(\d+)([mhdw])$/i.exec(token);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const minutes = unit === 'm' ? n : unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n * 10080;
    return new Date(now.getTime() + minutes * 60_000);
  }
  // HH:MM today (or tomorrow if past)
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (h > 23 || m > 59) return null;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
  }
  // "jutro" / "tomorrow"
  if (/^(jutro|tomorrow)$/i.test(token)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  return null;
}

export function parseSlash(input: string): SlashIntent | null {
  if (!input.startsWith('/')) return null;
  const space = input.indexOf(' ');
  const command = (space === -1 ? input : input.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : input.slice(space + 1);

  if (command === '/me') {
    if (!rest.trim()) return { kind: 'unknown', command, hint: 'Użyj: /me <akcja>' };
    return { kind: 'message', content: `_${rest.trim()}_` };
  }

  if (command === '/shrug') {
    return { kind: 'message', content: `¯\\_(ツ)_/¯ ${rest}`.trim() };
  }

  if (command === '/poll') {
    const parts = rest.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) {
      return { kind: 'unknown', command, hint: 'Użyj: /poll Pytanie | opcja1 | opcja2 [| --multi]' };
    }
    const multi = parts[parts.length - 1]!.toLowerCase() === '--multi';
    const question = parts[0]!;
    const options = (multi ? parts.slice(1, -1) : parts.slice(1)).filter(Boolean);
    if (options.length < 2) {
      return { kind: 'unknown', command, hint: 'Ankieta wymaga co najmniej 2 opcji' };
    }
    return { kind: 'poll', question, options, multiple: multi };
  }

  if (command === '/remind') {
    const restSpace = rest.indexOf(' ');
    if (restSpace === -1) return { kind: 'unknown', command, hint: 'Użyj: /remind <30m|2h|HH:MM|jutro> <treść>' };
    const when = rest.slice(0, restSpace).trim();
    const text = rest.slice(restSpace + 1).trim();
    const at = parseRemindOffset(when, new Date());
    if (!at || !text) return { kind: 'unknown', command, hint: 'Nie rozumiem daty/godziny. Spróbuj: 30m, 2h, 1d, 09:00, jutro' };
    return { kind: 'remind', remindAt: at, text };
  }

  return { kind: 'unknown', command, hint: 'Nieznane polecenie. Wpisz / aby zobaczyć listę.' };
}
