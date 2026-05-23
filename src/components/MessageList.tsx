'use client';

import { useRef, useEffect, useCallback } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { pl } from 'date-fns/locale';
import type { Message } from '@/types';
import { parseDbDate } from '@/lib/datetime';
import MessageBubble from './MessageBubble';

interface MessageListProps {
  messages: Message[];
  currentUserId: string;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onReaction: (messageId: string, emoji: string) => void;
  onThreadOpen: (message: Message) => void;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onPinToggle?: (messageId: string, pinned: boolean) => Promise<void>;
  onSaveToggle?: (messageId: string, saved: boolean) => Promise<void>;
  onRemindMe?: (message: Message) => void;
  onForward?: (message: Message) => void;
  emptyState?: { title: string; subtitle?: string };
}

function formatDateDivider(dateStr: string): string {
  const date = parseDbDate(dateStr);
  if (isToday(date)) return 'Dzisiaj';
  if (isYesterday(date)) return 'Wczoraj';
  return format(date, 'd MMMM yyyy', { locale: pl });
}

export default function MessageList({
  messages,
  currentUserId,
  loading,
  hasMore,
  onLoadMore,
  onReaction,
  onThreadOpen,
  onEdit,
  onDelete,
  onPinToggle,
  onSaveToggle,
  onRemindMe,
  onForward,
  emptyState,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(messages.length);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > prevLengthRef.current) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.user_id === currentUserId || isNearBottom()) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
    prevLengthRef.current = messages.length;
  }, [messages, currentUserId]);

  // Initial scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, []);

  function isNearBottom() {
    const container = containerRef.current;
    if (!container) return true;
    return container.scrollHeight - container.scrollTop - container.clientHeight < 200;
  }

  // Infinite scroll for loading older messages
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || loading || !hasMore) return;
    if (container.scrollTop < 100) {
      onLoadMore();
    }
  }, [loading, hasMore, onLoadMore]);

  // Group messages by date
  let lastDate = '';

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 bg-slate-50 dark:bg-slate-950"
    >
      {loading && (
        <div className="flex justify-center py-4">
          <svg className="animate-spin h-6 w-6 text-indigo-400" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}

      {!loading && messages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
          <div className="w-14 h-14 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center mb-3">
            <svg className="w-7 h-7 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{emptyState?.title || 'Zacznij rozmowę'}</h3>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-xs">{emptyState?.subtitle || 'Napisz pierwszą wiadomość poniżej.'}</p>
        </div>
      )}

      {messages.map((message, index) => {
        const parsed = parseDbDate(message.created_at);
        const messageDate = isNaN(parsed.getTime()) ? '' : format(parsed, 'yyyy-MM-dd');
        const showDateDivider = !!messageDate && messageDate !== lastDate;
        if (messageDate) lastDate = messageDate;

        const prevMessage = index > 0 ? messages[index - 1] : null;
        const isConsecutive = prevMessage?.user_id === message.user_id && !showDateDivider &&
          (parseDbDate(message.created_at).getTime() - parseDbDate(prevMessage.created_at).getTime()) < 120000;

        return (
          <div key={message.id}>
            {showDateDivider && (
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
                <span className="text-xs font-medium text-slate-400 dark:text-slate-500 px-2">
                  {formatDateDivider(message.created_at)}
                </span>
                <div className="flex-1 h-px bg-slate-200 dark:bg-slate-800" />
              </div>
            )}
            <MessageBubble
              message={message}
              isOwn={message.user_id === currentUserId}
              isConsecutive={isConsecutive}
              onReaction={onReaction}
              onThreadOpen={() => onThreadOpen(message)}
              onEdit={onEdit}
              onDelete={onDelete}
              onPinToggle={onPinToggle}
              onSaveToggle={onSaveToggle}
              onRemindMe={onRemindMe}
              onForward={onForward}
              currentUserId={currentUserId}
            />
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
