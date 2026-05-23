'use client';

import { useState } from 'react';
import type { Channel } from '@/types';

interface ChannelHeaderProps {
  channel: Channel;
  isDM?: boolean;
  isOnline?: boolean;
}

export default function ChannelHeader({ channel, isDM, isOnline }: ChannelHeaderProps) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const dm = isDM || channel.type === 'dm';
  const displayName = dm
    ? (channel.other_user?.name || 'Użytkownik')
    : channel.name;
  const subtitle = dm
    ? (isOnline ? 'Online' : 'Offline')
    : channel.description;

  return (
    <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        {dm ? (
          <div className="relative shrink-0">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-sm">
              {displayName.charAt(0).toUpperCase()}
            </div>
            {isOnline && (
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-slate-900" />
            )}
          </div>
        ) : (
          <div className="w-9 h-9 rounded-xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-600 dark:text-slate-300 font-semibold text-sm shrink-0">
            {channel.icon || '#'}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100 truncate">{displayName}</h3>
          {subtitle && (
            <p className={`text-xs truncate ${dm && isOnline ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}`}>
              {subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {showSearch ? (
          <div className="flex items-center gap-2">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Szukaj w konwersacji..."
              autoFocus
              className="w-48 px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button onClick={() => { setShowSearch(false); setSearchQuery(''); }} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowSearch(true)}
            className="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 flex items-center justify-center transition-colors"
            title="Szukaj w konwersacji"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
