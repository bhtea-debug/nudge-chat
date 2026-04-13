'use client';

import { useRef, useEffect, useCallback } from 'react';
import { format, isToday, isYesterday } from 'date-fns';
import { pl } from 'date-fns/locale';
import type { Message } from '@/types';
import MessageBubble from './MessageBubble';

interface MessageListProps {
  messages: Message[];
  currentUserId: string;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onReaction: (messageId: string, emoji: string) => void;
  onThreadOpen: (message: Message) => void;
}

function formatDateDivider(dateStr: string): string {
  const date = new Date(dateStr);
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
      className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 bg-slate-50"
    >
      {loading && (
        <div className="flex justify-center py-4">
          <svg className="animate-spin h-6 w-6 text-indigo-400" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}

      {messages.map((message, index) => {
        const messageDate = format(new Date(message.created_at), 'yyyy-MM-dd');
        const showDateDivider = messageDate !== lastDate;
        lastDate = messageDate;

        const prevMessage = index > 0 ? messages[index - 1] : null;
        const isConsecutive = prevMessage?.user_id === message.user_id && !showDateDivider &&
          (new Date(message.created_at).getTime() - new Date(prevMessage.created_at).getTime()) < 120000;

        return (
          <div key={message.id}>
            {showDateDivider && (
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-xs font-medium text-slate-400 px-2">
                  {formatDateDivider(message.created_at)}
                </span>
                <div className="flex-1 h-px bg-slate-200" />
              </div>
            )}
            <MessageBubble
              message={message}
              isOwn={message.user_id === currentUserId}
              isConsecutive={isConsecutive}
              onReaction={onReaction}
              onThreadOpen={() => onThreadOpen(message)}
              currentUserId={currentUserId}
            />
          </div>
        );
      })}

      <div ref={bottomRef} />
    </div>
  );
}
