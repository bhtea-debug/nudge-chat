'use client';

import { useState } from 'react';
import type { Channel } from '@/types';

interface ChannelHeaderProps {
  channel: Channel;
  isDM?: boolean;
}

export default function ChannelHeader({ channel, isDM }: ChannelHeaderProps) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const displayName = isDM || channel.type === 'dm'
    ? (channel.other_user?.name || 'Użytkownik')
    : channel.name;

  return (
    <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200 bg-white shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        {channel.type === 'dm' || isDM ? (
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-sm shrink-0">
            {displayName.charAt(0).toUpperCase()}
          </div>
        ) : (
          <div className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center text-slate-600 font-semibold text-sm shrink-0">
            {channel.icon || '#'}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="font-semibold text-slate-900 truncate">{displayName}</h3>
          {channel.description && (
            <p className="text-xs text-slate-400 truncate">{channel.description}</p>
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
              className="w-48 px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button onClick={() => { setShowSearch(false); setSearchQuery(''); }} className="text-slate-400 hover:text-slate-600">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ) : (
          <>
            <button onClick={() => setShowSearch(true)} className="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 flex items-center justify-center transition-colors">
              <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <button className="w-8 h-8 rounded-lg text-slate-400 hover:bg-slate-50 hover:text-slate-600 flex items-center justify-center transition-colors">
              <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 12.75a.75.75 0 110-1.5.75.75 0 010 1.5zM12 18.75a.75.75 0 110-1.5.75.75 0 010 1.5z" />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
