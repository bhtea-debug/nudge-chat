'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { pl } from 'date-fns/locale';
import type { Channel, User } from '@/types';
import { parseDbDate } from '@/lib/datetime';
import { usePresence } from '@/hooks/usePresence';
import NewChannelModal from './NewChannelModal';

interface ChannelListProps {
  channels: Channel[];
  activeChannelId: string | null;
  filter: 'all' | 'unread' | 'dm' | 'group';
  onFilterChange: (filter: 'all' | 'unread' | 'dm' | 'group') => void;
  onChannelSelect: (channel: Channel) => void;
  onRefresh: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  user: User;
  onOpenQuickSwitcher?: () => void;
}

const filters = [
  { key: 'all' as const, label: 'Wszystkie' },
  { key: 'unread' as const, label: 'Nieprz.' },
  { key: 'group' as const, label: 'Kanały' },
  { key: 'dm' as const, label: 'Prywatne' },
];

function emptyMessage(filter: ChannelListProps['filter'], hasSearch: boolean): { title: string; subtitle: string } {
  if (hasSearch) return { title: 'Brak wyników', subtitle: 'Spróbuj innej frazy lub stwórz nową konwersację.' };
  switch (filter) {
    case 'unread': return { title: 'Wszystko przeczytane', subtitle: 'Nie masz żadnych nieprzeczytanych wiadomości.' };
    case 'dm': return { title: 'Brak wiadomości prywatnych', subtitle: 'Wybierz osobę z listy kontaktów aby zacząć.' };
    case 'group': return { title: 'Brak kanałów', subtitle: 'Stwórz pierwszy kanał i zaproś zespół.' };
    default: return { title: 'Brak konwersacji', subtitle: 'Naciśnij + aby stworzyć pierwszą rozmowę.' };
  }
}

export default function ChannelList({
  channels,
  activeChannelId,
  filter,
  onFilterChange,
  onChannelSelect,
  onRefresh,
  searchQuery,
  onSearchChange,
  user,
  onOpenQuickSwitcher,
}: ChannelListProps) {
  const [showNewChannel, setShowNewChannel] = useState(false);
  const { onlineUserIds } = usePresence();

  const totalUnread = channels.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0);

  const filtered = channels.filter((c) => {
    if (!searchQuery) return true;
    const name = c.type === 'dm' ? (c.other_user?.name || '') : c.name;
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const empty = emptyMessage(filter, !!searchQuery);

  return (
    <>
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Wiadomości</h2>
            {totalUnread > 0 && (
              <span className="bg-indigo-500 text-white text-xs font-bold px-2 py-0.5 rounded-full min-w-[20px] text-center">
                {totalUnread}
              </span>
            )}
          </div>
          <button
            onClick={() => setShowNewChannel(true)}
            className="w-8 h-8 rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 flex items-center justify-center hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors"
            title="Nowa konwersacja"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        <button
          onClick={onOpenQuickSwitcher}
          className="w-full flex items-center gap-2 px-3 py-2 mb-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-left text-sm text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700/60 transition-colors"
        >
          <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <span className="flex-1">Szukaj wszędzie...</span>
          <kbd className="text-[10px] font-mono px-1.5 py-0.5 border border-slate-200 dark:border-slate-700 rounded">⌘K</kbd>
        </button>

        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filtruj konwersacje na liście..."
          className="w-full px-3 py-1.5 mb-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder:text-slate-400"
        />

        <div className="flex gap-1 overflow-x-auto scrollbar-thin">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => onFilterChange(f.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors shrink-0 whitespace-nowrap ${
                filter === f.key
                  ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300'
                  : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-1">
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">{empty.title}</p>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{empty.subtitle}</p>
          </div>
        ) : (
          filtered.map((channel) => {
            const isActive = channel.id === activeChannelId;
            const name = channel.type === 'dm'
              ? (channel.other_user?.name || 'Użytkownik')
              : channel.name;
            const unread = Number(channel.unread_count) || 0;
            const initial = name.charAt(0).toUpperCase();
            const otherUserId = channel.other_user?.id;
            const isOnline = channel.type === 'dm' && otherUserId ? onlineUserIds.has(otherUserId) : false;

            return (
              <button
                key={channel.id}
                onClick={() => onChannelSelect(channel)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all mb-0.5 text-left ${
                  isActive
                    ? 'bg-indigo-50 dark:bg-indigo-500/15 border border-indigo-100 dark:border-indigo-500/30'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800 border border-transparent'
                }`}
              >
                <div className="relative shrink-0">
                  {channel.type === 'dm' ? (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-sm">
                      {initial}
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-700 dark:to-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 font-semibold text-sm">
                      {channel.icon || '#'}
                    </div>
                  )}
                  {isOnline && (
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={`text-sm truncate ${unread > 0 ? 'font-bold text-slate-900 dark:text-slate-50' : 'font-medium text-slate-700 dark:text-slate-200'}`}>
                      {name}
                    </span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 shrink-0 ml-2">
                      {channel.last_message_at
                        ? formatDistanceToNow(parseDbDate(channel.last_message_at as string), { addSuffix: false, locale: pl })
                        : ''}
                    </span>
                  </div>
                  <p className={`text-xs truncate mt-0.5 ${unread > 0 ? 'text-slate-600 dark:text-slate-300 font-medium' : 'text-slate-400 dark:text-slate-500'}`}>
                    {channel.last_message_content as string || 'Brak wiadomości'}
                  </p>
                </div>

                {unread > 0 && (
                  <span className="shrink-0 bg-indigo-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>

      {showNewChannel && (
        <NewChannelModal
          onClose={() => setShowNewChannel(false)}
          onCreated={() => {
            setShowNewChannel(false);
            onRefresh();
          }}
        />
      )}
    </>
  );
}
