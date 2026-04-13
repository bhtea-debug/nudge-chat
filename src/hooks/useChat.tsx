'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { usePusherEvent } from './usePusher';
import type { Message, Channel } from '@/types';

export function useChat(channelId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [sending, setSending] = useState(false);

  const fetchMessages = useCallback(async (before?: string) => {
    if (!channelId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ channelId });
      if (before) params.set('before', before);

      const res = await fetch(`/api/messages?${params}`);
      if (!res.ok) throw new Error('Failed to fetch messages');

      const data = await res.json();
      if (before) {
        setMessages(prev => [...data.messages, ...prev]);
      } else {
        setMessages(data.messages);
      }
      setHasMore(data.messages.length >= 50);
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    if (channelId) {
      setMessages([]);
      setHasMore(true);
      fetchMessages();
    }
  }, [channelId, fetchMessages]);

  // Real-time message handling
  usePusherEvent(
    channelId ? `presence-channel-${channelId}` : null,
    'new-message',
    (message: Message) => {
      setMessages(prev => {
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      });
    }
  );

  usePusherEvent(
    channelId ? `presence-channel-${channelId}` : null,
    'message-updated',
    (data: { messageId: string; content: string; edited_at: string }) => {
      setMessages(prev =>
        prev.map(m =>
          m.id === data.messageId
            ? { ...m, content: data.content, edited_at: data.edited_at }
            : m
        )
      );
    }
  );

  usePusherEvent(
    channelId ? `presence-channel-${channelId}` : null,
    'message-deleted',
    (data: { messageId: string }) => {
      setMessages(prev => prev.filter(m => m.id !== data.messageId));
    }
  );

  usePusherEvent(
    channelId ? `presence-channel-${channelId}` : null,
    'reaction-added',
    (data: { messageId: string; userId: string; userName: string; emoji: string }) => {
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== data.messageId) return m;
          const reactions = [...(m.reactions || [])];
          reactions.push({
            id: '',
            message_id: data.messageId,
            user_id: data.userId,
            emoji: data.emoji,
            created_at: new Date().toISOString(),
            user: { id: data.userId, name: data.userName, email: '' },
          });
          return { ...m, reactions };
        })
      );
    }
  );

  usePusherEvent(
    channelId ? `presence-channel-${channelId}` : null,
    'reaction-removed',
    (data: { messageId: string; userId: string; emoji: string }) => {
      setMessages(prev =>
        prev.map(m => {
          if (m.id !== data.messageId) return m;
          const reactions = (m.reactions || []).filter(
            r => !(r.user_id === data.userId && r.emoji === data.emoji)
          );
          return { ...m, reactions };
        })
      );
    }
  );

  const sendMessage = useCallback(async (content: string, replyTo?: string) => {
    if (!channelId || !content.trim()) return;
    setSending(true);
    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId, content: content.trim(), replyTo }),
      });
      if (!res.ok) throw new Error('Failed to send message');
      const data = await res.json();
      // Add message to local state immediately (optimistic update)
      if (data.message) {
        setMessages(prev => {
          if (prev.some(m => m.id === data.message.id)) return prev;
          return [...prev, data.message];
        });
      }
    } catch (e) {
      console.error('Failed to send message:', e);
    } finally {
      setSending(false);
    }
  }, [channelId]);

  const toggleReaction = useCallback(async (messageId: string, emoji: string) => {
    try {
      await fetch('/api/reactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, emoji }),
      });
    } catch (e) {
      console.error('Failed to toggle reaction:', e);
    }
  }, []);

  const loadMore = useCallback(() => {
    if (messages.length > 0 && hasMore && !loading) {
      fetchMessages(messages[0].created_at);
    }
  }, [messages, hasMore, loading, fetchMessages]);

  return {
    messages,
    loading,
    hasMore,
    sending,
    sendMessage,
    toggleReaction,
    loadMore,
  };
}
