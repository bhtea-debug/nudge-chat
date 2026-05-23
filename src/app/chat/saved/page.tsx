'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { pl } from 'date-fns/locale';
import { parseDbDate } from '@/lib/datetime';
import MessageContent from '@/components/MessageContent';

interface SavedItem {
  id: string;
  message_id: string;
  note?: string;
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

export default function SavedPage() {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const res = await fetch('/api/saved');
    if (res.ok) {
      const data = await res.json();
      setItems(data.saved);
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function unsave(messageId: string) {
    await fetch(`/api/saved?messageId=${encodeURIComponent(messageId)}`, { method: 'DELETE' });
    setItems(prev => prev.filter(i => i.message_id !== messageId));
  }

  function linkFor(channel: SavedItem['message']['channel']) {
    return channel.type === 'dm' && channel.other_user_id
      ? `/chat/dm/${channel.other_user_id}`
      : `/chat/${channel.slug}`;
  }

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-slate-950 overflow-hidden">
      <div className="h-16 px-6 flex items-center border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <span>🔖</span> Zapisane wiadomości
        </h1>
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
            <div className="text-5xl mb-3">🔖</div>
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Brak zapisanych wiadomości</h2>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Najedź na wiadomość → kliknij ⋯ → „Zapisz".</p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto p-4 space-y-3">
            {items.map(item => (
              <div key={item.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <Link href={linkFor(item.message.channel)} className="text-xs text-indigo-600 dark:text-indigo-300 font-medium hover:underline">
                    {item.message.channel.type === 'dm' ? `@${item.message.channel.name}` : `#${item.message.channel.name}`}
                  </Link>
                  <div className="flex items-center gap-2 text-[11px] text-slate-400">
                    <span>zapisano {formatDistanceToNow(parseDbDate(item.created_at), { addSuffix: true, locale: pl })}</span>
                    <button onClick={() => unsave(item.message_id)} className="text-slate-400 hover:text-red-500" title="Usuń z zapisanych">✕</button>
                  </div>
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
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
