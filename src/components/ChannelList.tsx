'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { pl } from 'date-fns/locale';
import type { Channel, User } from '@/types';
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
}

const filters = [
  { key: 'all' as const, label: 'Wszystkie' },
  { key: 'unread' as const, label: 'Nieprzeczytane' },
  { key: 'group' as const, label: 'Kanały' },
  { key: 'dm' as const, label: 'DM' },
];

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
}: ChannelListProps) {
  const [showNewChannel, setShowNewChannel] = useState(false);

  const totalUnread = channels.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0);

  const filtered = channels.filter((c) => {
    if (!searchQuery) return true;
    const name = c.type === 'dm' ? (c.other_user?.name || '') : c.name;
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  return (
    <>
      {/* Header */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-slate-900">Wiadomości</h2>
            {totalUnread > 0 && (
              <span className="bg-indigo-500 text-white text-xs font-bold px-2 py-0.5 rounded-full min-w-[20px] text-center">
                {totalUnread}
              </span>
            )}
          </div>
          <button
            onClick={() => setShowNewChannel(true)}
            className="w-8 h-8 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center hover:bg-indigo-100 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-3">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Szukaj konwersacji..."
            className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        {/* Filter tabs */}
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => onFilterChange(f.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                filter === f.key
                  ? 'bg-indigo-50 text-indigo-600'
                  : 'text-slate-500 hover:bg-slate-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Channel list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-1">
        {filtered.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">
            Brak konwersacji
          </div>
        ) : (
          filtered.map((channel) => {
            const isActive = channel.id === activeChannelId;
            const name = channel.type === 'dm'
              ? (channel.other_user?.name || 'Użytkownik')
              : channel.name;
            const unread = Number(channel.unread_count) || 0;
            const initial = name.charAt(0).toUpperCase();

            return (
              <button
                key={channel.id}
                onClick={() => onChannelSelect(channel)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all mb-0.5 ${
                  isActive
                    ? 'bg-indigo-50 border border-indigo-100'
                    : 'hover:bg-slate-50 border border-transparent'
                }`}
              >
                {/* Avatar */}
                <div className="relative shrink-0">
                  {channel.type === 'dm' ? (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-sm">
                      {initial}
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-slate-600 font-semibold text-sm">
                      {channel.icon || '#'}
                    </div>
                  )}
                </div>

                {/* Name + last message */}
                <div className="flex-1 min-w-0 text-left">
                  <div className="flex items-center justify-between">
                    <span className={`text-sm truncate ${unread > 0 ? 'font-bold text-slate-900' : 'font-medium text-slate-700'}`}>
                      {name}
                    </span>
                    <span className="text-[10px] text-slate-400 shrink-0 ml-2">
                      {channel.last_message_at
                        ? formatDistanceToNow(new Date(channel.last_message_at as string), { addSuffix: false, locale: pl })
                        : ''}
                    </span>
                  </div>
                  <p className={`text-xs truncate mt-0.5 ${unread > 0 ? 'text-slate-600 font-medium' : 'text-slate-400'}`}>
                    {channel.last_message_content as string || 'Brak wiadomości'}
                  </p>
                </div>

                {/* Unread badge */}
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

      {/* New channel modal */}
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
