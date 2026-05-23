'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { triggerClientEvent, usePusherEvent } from './usePusher';

interface TypingUser {
  userId: string;
  userName: string;
  ts: number;
}

const TYPING_TTL = 4000; // remove indicator if no fresh signal within 4s
const SEND_THROTTLE = 1500; // re-broadcast at most every 1.5s

export function useTyping(channelId: string | null, currentUserId: string, currentUserName: string) {
  const [typing, setTyping] = useState<TypingUser[]>([]);
  const lastSentAtRef = useRef(0);

  const channelName = channelId ? `presence-channel-${channelId}` : null;

  // Listen for others' typing.
  usePusherEvent(channelName, 'client-typing', (data: { userId: string; userName: string }) => {
    if (!data || data.userId === currentUserId) return;
    setTyping(prev => {
      const now = Date.now();
      const others = prev.filter(t => t.userId !== data.userId);
      return [...others, { userId: data.userId, userName: data.userName, ts: now }];
    });
  });

  // Sweep stale entries so the indicator clears even if the typer goes silent.
  useEffect(() => {
    const i = setInterval(() => {
      const cutoff = Date.now() - TYPING_TTL;
      setTyping(prev => {
        const filtered = prev.filter(t => t.ts >= cutoff);
        return filtered.length === prev.length ? prev : filtered;
      });
    }, 1000);
    return () => clearInterval(i);
  }, []);

  // Reset when the channel changes — stale typers from the previous channel
  // shouldn't show up in the new one.
  useEffect(() => { setTyping([]); }, [channelId]);

  const notifyTyping = useCallback(() => {
    if (!channelName) return;
    const now = Date.now();
    if (now - lastSentAtRef.current < SEND_THROTTLE) return;
    lastSentAtRef.current = now;
    triggerClientEvent(channelName, 'typing', { userId: currentUserId, userName: currentUserName });
  }, [channelName, currentUserId, currentUserName]);

  return { typingUsers: typing, notifyTyping };
}
