'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Channel, Message } from '@/types';

interface Props {
  message: Message;
  channels: Channel[];
  onClose: () => void;
}

export default function ForwardModal({ message, channels, onClose }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<Channel | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return channels
      .filter(c => c.id !== message.channel_id)
      .filter(c => {
        if (!q) return true;
        const name = c.type === 'dm' ? c.other_user?.name || '' : c.name;
        return name.toLowerCase().includes(q);
      })
      .slice(0, 50);
  }, [channels, message.channel_id, query]);

  useEffect(() => { setTarget(null); }, [query]);

  async function forward() {
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      const senderName = message.user?.name || 'Ktoś';
      const quoted = message.content.split('\n').map(l => `> ${l}`).join('\n');
      const body = `${note.trim() ? note.trim() + '\n\n' : ''}**Przesłane od ${senderName}:**\n${quoted}`;
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: target.id, content: body }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Wysyłka nieudana');
      }
      onClose();
      if (target.type === 'dm' && target.other_user) {
        router.push(`/chat/dm/${target.other_user.id}`);
      } else {
        router.push(`/chat/${target.slug}`);
      }
    } catch (e: any) {
      setError(e?.message || 'Coś poszło nie tak');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[80vh]">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between shrink-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">Prześlij dalej</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 border-b border-slate-100 dark:border-slate-800 shrink-0">
          <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-2.5 text-xs">
            <p className="font-semibold text-slate-700 dark:text-slate-200">{message.user?.name}</p>
            <p className="text-slate-500 dark:text-slate-400 line-clamp-3 whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>

        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Wyszukaj kanał lub osobę..."
          autoFocus
          className="mx-4 mt-3 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
          {filtered.length === 0 ? (
            <p className="text-center text-xs text-slate-400 py-6">Brak konwersacji</p>
          ) : (
            filtered.map(c => {
              const name = c.type === 'dm' ? (c.other_user?.name || 'Użytkownik') : c.name;
              const active = target?.id === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => setTarget(c)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors ${
                    active
                      ? 'bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-indigo-300 dark:ring-indigo-500/40'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <div className={`w-7 h-7 shrink-0 flex items-center justify-center text-white text-xs font-semibold ${c.type === 'dm' ? 'rounded-full bg-gradient-to-br from-indigo-400 to-violet-500' : 'rounded-lg bg-slate-400 dark:bg-slate-600'}`}>
                    {c.type === 'dm' ? name.charAt(0).toUpperCase() : (c.icon || '#')}
                  </div>
                  <span className="text-sm text-slate-800 dark:text-slate-100 truncate">{name}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="p-4 border-t border-slate-100 dark:border-slate-800 shrink-0 space-y-2">
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Dodaj komentarz (opcjonalnie)"
            className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          {error && <p className="text-xs text-red-500">⚠ {error}</p>}
          <button
            onClick={forward}
            disabled={!target || sending}
            className="w-full py-2 text-sm font-medium bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50"
          >
            {sending ? 'Wysyłanie…' : target ? `Prześlij do ${target.type === 'dm' ? target.other_user?.name : '#' + target.name}` : 'Wybierz konwersację'}
          </button>
        </div>
      </div>
    </div>
  );
}
