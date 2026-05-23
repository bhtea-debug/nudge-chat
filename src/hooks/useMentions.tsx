'use client';

import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { useAuth } from './useAuth';
import { usePusherEvent } from './usePusher';

interface MentionsContextValue {
  unreadCount: number;
  refresh: () => void;
}

const MentionsContext = createContext<MentionsContextValue>({ unreadCount: 0, refresh: () => {} });

export function MentionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const res = await fetch('/api/mentions?unread=1');
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(Number(data.unread_count) || (data.mentions?.length ?? 0));
      }
    } catch { /* swallow */ }
  }, [user]);

  useEffect(() => {
    if (!user) return;
    refresh();
    const i = setInterval(refresh, 60_000);
    return () => clearInterval(i);
  }, [user, refresh]);

  // Bump count immediately on push so the badge feels live, then reconcile.
  usePusherEvent(
    user ? `private-user-${user.id}` : null,
    'mention',
    () => {
      setUnreadCount(c => c + 1);
      refresh();
    },
  );

  return (
    <MentionsContext.Provider value={{ unreadCount, refresh }}>
      {children}
    </MentionsContext.Provider>
  );
}

export function useMentions() {
  return useContext(MentionsContext);
}
