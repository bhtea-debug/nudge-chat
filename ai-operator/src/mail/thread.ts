/**
 * Rekonstrukcja wątków. Czysta funkcja, bez IMAP-a — dlatego da się ją
 * przetestować i użyć ponownie przy innym dostawcy poczty.
 *
 * Odzyskane z archiwalnego teabrew-calendar/src/lib/email-scanner-imap.ts:
 * nagłówek References plus In-Reply-To wyznaczają wątek, a mailparser zwraca
 * `references` raz jako string, a raz jako tablicę — to jest realna pułapka,
 * na której archiwalny kod się już potknął.
 */

export function normalizeReferences(
  raw: string | string[] | undefined | null,
  inReplyTo?: string | null,
): string[] {
  let refs: string[] = [];
  if (Array.isArray(raw)) {
    refs = raw.map((r) => String(r).trim()).filter(Boolean);
  } else if (typeof raw === "string") {
    refs = raw.split(/\s+/).map((r) => r.trim()).filter(Boolean);
  }
  const irt = inReplyTo?.trim();
  if (irt && !refs.includes(irt)) refs.push(irt);
  return [...new Set(refs)];
}

export interface ThreadableMessage {
  readonly id: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string;
  readonly date: string;
}

/**
 * Wyznacza threadId dla zbioru wiadomości przez union-find po Message-ID.
 * Reprezentantem wątku jest najstarsza znana wiadomość — stabilnie, bez
 * zależności od kolejności wejścia.
 */
export function assignThreadIds<T extends ThreadableMessage>(
  messages: readonly T[],
): Map<string, string> {
  const parent = new Map<string, string>();

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== undefined && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Kompresja ścieżki.
    let cur = x;
    while (parent.get(cur) !== undefined && parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const m of messages) {
    if (parent.get(m.id) === undefined) parent.set(m.id, m.id);
    for (const ref of [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])]) {
      if (parent.get(ref) === undefined) parent.set(ref, ref);
      union(ref, m.id);
    }
  }

  // Najstarsza faktycznie posiadana wiadomość w grupie zostaje identyfikatorem wątku.
  const oldestByRoot = new Map<string, { id: string; date: string }>();
  for (const m of messages) {
    const root = find(m.id);
    const cur = oldestByRoot.get(root);
    if (!cur || m.date < cur.date || (m.date === cur.date && m.id < cur.id)) {
      oldestByRoot.set(root, { id: m.id, date: m.date });
    }
  }

  const out = new Map<string, string>();
  for (const m of messages) {
    const root = find(m.id);
    out.set(m.id, oldestByRoot.get(root)?.id ?? m.id);
  }
  return out;
}

/** Wszystkie Message-ID, które trzeba dociągnąć, żeby zobaczyć cały wątek. */
export function threadMemberIds(
  seed: ThreadableMessage,
): string[] {
  return [...new Set([seed.id, ...seed.references, ...(seed.inReplyTo ? [seed.inReplyTo] : [])])];
}

const REPLY_PREFIX = /^\s*(re|odp|fwd|fw|pd)\s*(\[\d+\])?\s*:\s*/i;

/** Temat bez prefiksów odpowiedzi — do grupowania i do wyświetlania wątku. */
export function baseSubject(subject: string): string {
  let s = subject ?? "";
  let prev: string;
  do {
    prev = s;
    s = s.replace(REPLY_PREFIX, "");
  } while (s !== prev);
  return s.trim() || "(brak tematu)";
}
