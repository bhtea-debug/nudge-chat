'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePusherEvent } from './usePusher';

export interface PinnedEntry {
  id: string;
  message_id: string;
  pinned_by: string;
  pinned_by_name: string;
  pinned_at: string;
  message: {
    id: string;
    content: string;
    created_at: string;
    user_id: string;
    user: { id: string; name: string };
  };
}

export function usePinned(channelId: string | null) {
  const [pinned, setPinned] = useState<PinnedEntry[]>([]);

  const refresh = useCallback(async () => {
    if (!channelId) { setPinned([]); return; }
    try {
      const res = await fetch(`/api/pinned?channelId=${channelId}`);
      if (res.ok) {
        const data = await res.json();
        setPinned(data.pinned);
      }
    } catch { /* swallow */ }
  }, [channelId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Server broadcasts pin/unpin on the same channel; refetch for ground truth.
  usePusherEvent(
    channelId ? `presence-channel-${channelId}` : null,
    'pinned-changed',
    () => { refresh(); },
  );

  return { pinned, refresh };
}
