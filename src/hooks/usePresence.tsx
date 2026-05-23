'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useAuth } from './useAuth';

interface PresenceContextValue {
  onlineUserIds: Set<string>;
}

const PresenceContext = createContext<PresenceContextValue>({ onlineUserIds: new Set() });

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());

  // Periodic refresh — Pusher presence channels would be ideal, but cover only
  // currently-subscribed channel members. This gives a coarse "active in last
  // 5 minutes" view across the whole org for sidebar/header dots.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    async function fetchPresence() {
      try {
        const res = await fetch('/api/presence');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const ids = new Set<string>();
        for (const s of data.statuses || []) {
          if (s.status && s.status !== 'offline' && s.user_id) ids.add(s.user_id);
        }
        // Always treat the current user as online to themselves.
        if (user) ids.add(user.id);
        setOnlineUserIds(ids);
      } catch { /* best-effort */ }
    }

    fetchPresence();
    const interval = setInterval(fetchPresence, 30_000);

    // Heartbeat — keep our own status fresh so other clients see us online.
    async function heartbeat() {
      try {
        await fetch('/api/presence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'online' }),
        });
      } catch { /* swallow */ }
    }
    heartbeat();
    const hb = setInterval(heartbeat, 60_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(hb);
    };
  }, [user]);

  return (
    <PresenceContext.Provider value={{ onlineUserIds }}>
      {children}
    </PresenceContext.Provider>
  );
}

export function usePresence() {
  return useContext(PresenceContext);
}
