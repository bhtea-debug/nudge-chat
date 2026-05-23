'use client';

import { useState } from 'react';
import type { PinnedEntry } from '@/hooks/usePinned';

interface Props {
  pinned: PinnedEntry[];
  onJumpTo?: (messageId: string) => void;
  onUnpin?: (messageId: string) => Promise<void> | void;
}

export default function PinnedBanner({ pinned, onJumpTo, onUnpin }: Props) {
  const [expanded, setExpanded] = useState(false);
  if (pinned.length === 0) return null;

  const visible = expanded ? pinned : pinned.slice(0, 1);

  return (
    <div className="border-b border-amber-200/60 dark:border-amber-500/20 bg-amber-50/70 dark:bg-amber-500/10 shrink-0">
      <button
        onClick={() => pinned.length > 1 && setExpanded(e => !e)}
        className="w-full px-4 py-1.5 flex items-center gap-2 text-[11px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide"
      >
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path d="M5 9V2a1 1 0 011-1h8a1 1 0 011 1v7l1.447 2.894A1 1 0 0114.553 13H12v5a1 1 0 11-2 0v-5H7.447a1 1 0 01-.894-1.106L5 9z" />
        </svg>
        <span>Przypięte ({pinned.length})</span>
        {pinned.length > 1 && (
          <svg className={`w-3 h-3 ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>
      <div className={`px-4 pb-2 space-y-1 ${expanded ? '' : ''}`}>
        {visible.map(p => (
          <div key={p.id} className="flex items-start gap-2 group">
            <button
              onClick={() => onJumpTo?.(p.message_id)}
              className="flex-1 min-w-0 text-left text-xs text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white"
            >
              <span className="font-medium">{p.message.user.name}: </span>
              <span className="text-slate-600 dark:text-slate-300">{p.message.content.length > 140 ? p.message.content.slice(0, 140) + '…' : p.message.content}</span>
            </button>
            {onUnpin && (
              <button
                onClick={() => onUnpin(p.message_id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 text-[11px] shrink-0"
                title="Odepnij"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
