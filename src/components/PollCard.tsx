'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import { pl } from 'date-fns/locale';
import { parseDbDate } from '@/lib/datetime';
import type { Poll } from '@/types';

interface Props {
  poll: Poll;
  currentUserId: string;
  isOwn?: boolean;
}

export default function PollCard({ poll, currentUserId, isOwn }: Props) {
  const [localVotes, setLocalVotes] = useState(poll.votes || []);
  const [voting, setVoting] = useState<number | null>(null);

  const closed = !!(poll.closes_at && parseDbDate(poll.closes_at).getTime() < Date.now());
  const totalVotes = localVotes.length;
  const myVotes = new Set(localVotes.filter(v => v.user_id === currentUserId).map(v => v.option_idx));

  // Group votes per option.
  const counts: number[] = poll.options.map((_, idx) => localVotes.filter(v => v.option_idx === idx).length);
  const max = Math.max(...counts, 1);

  async function vote(idx: number) {
    if (closed || voting !== null) return;
    setVoting(idx);
    // Optimistic toggle — replace any existing my-votes for single-choice.
    setLocalVotes(prev => {
      const mine = prev.filter(v => v.user_id === currentUserId);
      const alreadyPicked = mine.some(m => m.option_idx === idx);
      if (alreadyPicked) {
        return prev.filter(v => !(v.user_id === currentUserId && v.option_idx === idx));
      }
      const others = poll.multiple_choice ? prev : prev.filter(v => v.user_id !== currentUserId);
      return [...others, { user_id: currentUserId, user_name: 'Ty', option_idx: idx }];
    });
    try {
      const res = await fetch(`/api/polls/${poll.id}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionIdx: idx }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.votes) setLocalVotes(data.votes);
      }
    } finally {
      setVoting(null);
    }
  }

  return (
    <div className={`rounded-2xl p-3 ${
      isOwn
        ? 'bg-white/10 text-white'
        : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700'
    }`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base">📊</span>
        <p className="font-semibold text-sm leading-tight flex-1">{poll.question}</p>
      </div>

      <div className="space-y-1.5">
        {poll.options.map((opt, idx) => {
          const count = counts[idx]!;
          const pct = totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
          const widthPct = totalVotes === 0 ? 0 : Math.max(2, Math.round((count / max) * 100));
          const picked = myVotes.has(idx);

          return (
            <button
              key={idx}
              onClick={() => vote(idx)}
              disabled={closed}
              className={`w-full text-left relative overflow-hidden rounded-xl px-3 py-2 text-xs font-medium transition-all ${
                closed ? 'cursor-default opacity-80' : 'hover:scale-[1.01]'
              } ${
                picked
                  ? isOwn
                    ? 'bg-white/30 ring-1 ring-white/60'
                    : 'bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-indigo-400 dark:ring-indigo-500/60'
                  : isOwn
                    ? 'bg-white/10 hover:bg-white/15'
                    : 'bg-slate-50 dark:bg-slate-900/40 hover:bg-slate-100 dark:hover:bg-slate-900/70'
              }`}
            >
              <span
                className={`absolute inset-y-0 left-0 ${
                  picked
                    ? isOwn ? 'bg-white/15' : 'bg-indigo-200/60 dark:bg-indigo-500/30'
                    : isOwn ? 'bg-white/8' : 'bg-slate-200/60 dark:bg-slate-700/50'
                }`}
                style={{ width: `${widthPct}%` }}
              />
              <span className="relative flex items-center justify-between gap-2">
                <span className="truncate">{picked && '✓ '}{opt}</span>
                <span className="text-[10px] opacity-80 shrink-0">{count} · {pct}%</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className={`flex items-center justify-between gap-2 mt-2 text-[11px] ${isOwn ? 'text-white/70' : 'text-slate-400 dark:text-slate-500'}`}>
        <span>{totalVotes} {totalVotes === 1 ? 'głos' : totalVotes < 5 ? 'głosy' : 'głosów'}{poll.multiple_choice ? ' · wielokrotny wybór' : ''}</span>
        {poll.closes_at && (
          <span>{closed ? 'Zamknięta ' : 'Do '}{format(parseDbDate(poll.closes_at), 'd MMM, HH:mm', { locale: pl })}</span>
        )}
      </div>
    </div>
  );
}
