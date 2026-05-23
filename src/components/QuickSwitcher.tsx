'use client';

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { Channel } from '@/types';

interface QuickItem {
  type: 'channel' | 'dm' | 'person';
  id: string;
  title: string;
  subtitle?: string;
  icon: string;
  href: string;
}

interface Props {
  channels: Channel[];
  open: boolean;
  onClose: () => void;
}

// Cheap fuzzy match — every query char must appear in target in order. Returns
// a score (lower = better) so we can rank exact prefixes above scattered matches.
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return -100 + (t.length - q.length);
  let score = 0;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi]!, ti);
    if (idx === -1) return null;
    score += idx - ti;
    ti = idx + 1;
  }
  return score;
}

export default function QuickSwitcher({ channels, open, onClose }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const [people, setPeople] = useState<{ id: string; name: string; email?: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      // Defer focus a tick so the modal is in the DOM.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Lightweight people search — only when the user actually starts typing.
  useEffect(() => {
    if (!open || query.length < 1) {
      setPeople([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?type=people&q=${encodeURIComponent(query)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPeople(data.results?.people || []);
      } catch { /* swallow — search is best-effort */ }
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, query]);

  const items: QuickItem[] = useMemo(() => {
    const channelItems: QuickItem[] = channels.map(c => {
      if (c.type === 'dm') {
        const name = c.other_user?.name || 'Użytkownik';
        return {
          type: 'dm',
          id: c.id,
          title: name,
          subtitle: 'Wiadomość prywatna',
          icon: name.charAt(0).toUpperCase(),
          href: `/chat/dm/${c.other_user?.id || c.id}`,
        };
      }
      return {
        type: 'channel',
        id: c.id,
        title: c.name,
        subtitle: c.description || 'Kanał',
        icon: c.icon || '#',
        href: `/chat/${c.slug}`,
      };
    });

    const peopleItems: QuickItem[] = people
      .filter(p => !channels.some(c => c.type === 'dm' && c.other_user?.id === p.id))
      .map(p => ({
        type: 'person',
        id: p.id,
        title: p.name,
        subtitle: 'Rozpocznij konwersację',
        icon: p.name.charAt(0).toUpperCase(),
        href: `/chat/dm/${p.id}`,
      }));

    const all = [...channelItems, ...peopleItems];

    if (!query) return all.slice(0, 20);

    return all
      .map(it => ({ it, score: fuzzyScore(query, it.title) }))
      .filter(x => x.score !== null)
      .sort((a, b) => (a.score! - b.score!))
      .slice(0, 20)
      .map(x => x.it);
  }, [channels, query, people]);

  const pickItem = useCallback((item: QuickItem) => {
    router.push(item.href);
    onClose();
  }, [router, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, items.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter') { e.preventDefault(); const it = items[activeIdx]; if (it) pickItem(it); return; }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, items, activeIdx, pickItem, onClose]);

  // Clamp active index when list shrinks.
  useEffect(() => { setActiveIdx(i => Math.min(i, Math.max(0, items.length - 1))); }, [items.length]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-slate-900/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Szukaj kanału, osoby, wiadomości prywatnej..."
            className="flex-1 bg-transparent outline-none text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
          />
          <kbd className="text-[10px] font-mono text-slate-400 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        <div className="max-h-[50vh] overflow-y-auto scrollbar-thin py-1">
          {items.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">Nic nie znaleziono</div>
          ) : (
            items.map((item, idx) => (
              <button
                key={`${item.type}-${item.id}`}
                onClick={() => pickItem(item)}
                onMouseEnter={() => setActiveIdx(idx)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                  idx === activeIdx
                    ? 'bg-indigo-50 dark:bg-indigo-500/10'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                }`}
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-semibold shrink-0 ${
                  item.type === 'channel'
                    ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                    : 'bg-gradient-to-br from-indigo-400 to-violet-500 text-white'
                }`}>
                  {item.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{item.title}</p>
                  {item.subtitle && (
                    <p className="text-xs text-slate-400 truncate">{item.subtitle}</p>
                  )}
                </div>
                {idx === activeIdx && (
                  <kbd className="text-[10px] font-mono text-slate-400 border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5">↵</kbd>
                )}
              </button>
            ))
          )}
        </div>

        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 text-[11px] text-slate-400">
          <span><kbd className="font-mono px-1">↑↓</kbd> nawigacja</span>
          <span><kbd className="font-mono px-1">↵</kbd> otwórz</span>
          <span className="ml-auto"><kbd className="font-mono px-1">⌘</kbd>+<kbd className="font-mono px-1">K</kbd></span>
        </div>
      </div>
    </div>
  );
}
