'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { pl } from 'date-fns/locale';
import { parseDbDate } from '@/lib/datetime';
import MessageContent from '@/components/MessageContent';

interface MentionItem {
  id: string;
  message_id: string;
  read_at?: string | null;
  created_at: string;
  message: {
    id: string;
    content: string;
    created_at: string;
    user_id: string;
    user: { id: string; name: string };
    channel: { id: string; name: string; slug: string; type: 'dm' | 'group'; other_user_id?: string };
  };
}

export default function MentionsPage() {
  const [items, setItems] = useState<MentionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread'>('unread');

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/mentions${filter === 'unread' ? '?unread=1' : ''}`);
    if (res.ok) {
      const data = await res.json();
      setItems(data.mentions);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, [filter]);

  async function markAllRead() {
    await fetch('/api/mentions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setItems(prev => prev.map(i => ({ ...i, read_at: new Date().toISOString() })));
    if (filter === 'unread') setItems([]);
  }

  function linkFor(m: MentionItem) {
    const c = m.message.channel;
    return c.type === 'dm' && c.other_user_id ? `/chat/dm/${c.other_user_id}` : `/chat/${c.slug}`;
  }

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-slate-950 overflow-hidden">
      <div className="h-16 px-6 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0 gap-3">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <span>@</span> Wzmianki
        </h1>
        <div className="flex items-center gap-2">
          <div className="flex bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5">
            <button
              onClick={() => setFilter('unread')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'unread' ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
            >Nieprzeczytane</button>
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${filter === 'all' ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
            >Wszystkie</button>
          </div>
          <button
            onClick={markAllRead}
            className="text-xs px-3 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/25"
          >
            Oznacz wszystkie
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {loading ? (
          <div className="flex justify-center py-10">
            <svg className="animate-spin h-6 w-6 text-indigo-400" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-16 px-4">
            <div className="text-5xl mb-3">🎉</div>
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{filter === 'unread' ? 'Wszystko przeczytane' : 'Brak wzmianek'}</h2>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Pojawisz się tu gdy ktoś użyje <kbd className="font-mono px-1 border border-slate-200 dark:border-slate-700 rounded">@twoja_nazwa</kbd>.</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto p-4 space-y-3">
            {items.map(item => (
              <Link
                key={item.id}
                href={linkFor(item)}
                className={`block bg-white dark:bg-slate-900 border rounded-2xl p-4 transition-colors hover:border-indigo-200 dark:hover:border-indigo-500/40 ${
                  item.read_at ? 'border-slate-200 dark:border-slate-800' : 'border-indigo-200 dark:border-indigo-500/40 ring-1 ring-indigo-100 dark:ring-indigo-500/20'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-indigo-600 dark:text-indigo-300 font-medium">
                    {item.message.channel.type === 'dm' ? `@${item.message.channel.name}` : `#${item.message.channel.name}`}
                  </span>
                  {!item.read_at && <span className="w-2 h-2 rounded-full bg-indigo-500" />}
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-xs font-semibold shrink-0">
                    {item.message.user.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold text-slate-700 dark:text-slate-200">{item.message.user.name}</span>
                      <span className="text-slate-400">{formatDistanceToNow(parseDbDate(item.message.created_at), { addSuffix: true, locale: pl })}</span>
                    </div>
                    <div className="text-sm text-slate-700 dark:text-slate-200 mt-1">
                      <MessageContent content={item.message.content} />
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
