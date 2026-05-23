'use client';

import { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';
import type { Message } from '@/types';
import { parseDbDate } from '@/lib/datetime';
import { usePusherEvent } from '@/hooks/usePusher';
import MessageBubble from './MessageBubble';

interface ThreadPanelProps {
  message: Message;
  channelId: string;
  currentUserId: string;
  onClose: () => void;
}

export default function ThreadPanel({ message, channelId, currentUserId, onClose }: ThreadPanelProps) {
  const [replies, setReplies] = useState<Message[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/messages?channelId=${channelId}&replyTo=${message.id}`);
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setReplies(data.messages);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [message.id, channelId]);

  // Real-time reply delivery — previously polled every 5s, which hammered Turso
  // and gave 0-5s lag. Server already broadcasts `new-message` on the channel.
  usePusherEvent(
    `presence-channel-${channelId}`,
    'new-message',
    (incoming: Message) => {
      if (incoming.reply_to !== message.id) return;
      setReplies(prev => (prev.some(r => r.id === incoming.id) ? prev : [...prev, incoming]));
    }
  );

  usePusherEvent(
    `presence-channel-${channelId}`,
    'message-deleted',
    (data: { messageId: string }) => {
      setReplies(prev => prev.filter(r => r.id !== data.messageId));
    }
  );

  async function sendReply() {
    if (!content.trim() || sending) return;
    const toSend = content.trim();
    setContent('');
    setSendError(null);
    setSending(true);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, content: toSend, replyTo: message.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Wysyłka nieudana (HTTP ${res.status})`);
      }
      const data = await res.json();
      // Optimistic insert — Pusher echo will be deduped by id.
      if (data.message) {
        setReplies(prev => (prev.some(r => r.id === data.message.id) ? prev : [...prev, data.message]));
      }
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } catch (e: any) {
      setContent(toSend);
      setSendError(e?.message || 'Nie udało się wysłać odpowiedzi');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="w-80 border-l border-slate-200 bg-white flex flex-col shrink-0">
      {/* Header */}
      <div className="h-16 px-4 flex items-center justify-between border-b border-slate-200 shrink-0">
        <h3 className="font-semibold text-slate-900 text-sm">Wątek</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Original message */}
      <div className="p-4 border-b border-slate-100 bg-slate-50">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-[10px]">
            {message.user?.name?.charAt(0).toUpperCase() || '?'}
          </div>
          <span className="text-xs font-semibold text-slate-700">{message.user?.name}</span>
          <span className="text-[10px] text-slate-400">{format(parseDbDate(message.created_at), 'HH:mm')}</span>
        </div>
        <p className="text-sm text-slate-700 whitespace-pre-wrap">{message.content}</p>
      </div>

      {/* Replies */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
        {loading ? (
          <div className="flex justify-center py-4">
            <svg className="animate-spin h-5 w-5 text-indigo-400" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : replies.length === 0 ? (
          <p className="text-center text-xs text-slate-400 py-4">Brak odpowiedzi</p>
        ) : (
          replies.map(reply => (
            <div key={reply.id} className="flex gap-2">
              <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-[9px] shrink-0 mt-0.5">
                {reply.user?.name?.charAt(0).toUpperCase() || '?'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-700">{reply.user?.name}</span>
                  <span className="text-[10px] text-slate-400">{format(parseDbDate(reply.created_at), 'HH:mm')}</span>
                </div>
                <p className="text-sm text-slate-700 whitespace-pre-wrap mt-0.5">{reply.content}</p>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply input */}
      <div className="border-t border-slate-200 p-3">
        {sendError && (
          <div className="flex items-center justify-between bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-2.5 py-1.5 mb-2">
            <span className="truncate">⚠ {sendError}</span>
            <button onClick={() => setSendError(null)} className="ml-2 shrink-0 text-red-500 hover:text-red-700">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
            placeholder="Odpowiedz..."
            rows={1}
            className="flex-1 px-3 py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 max-h-[80px]"
          />
          <button
            onClick={sendReply}
            disabled={!content.trim() || sending}
            className="w-8 h-8 rounded-xl bg-indigo-500 text-white flex items-center justify-center hover:bg-indigo-600 disabled:opacity-30 transition-colors shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
