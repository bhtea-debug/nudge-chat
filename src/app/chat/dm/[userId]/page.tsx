'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { usePresence } from '@/hooks/usePresence';
import ChannelView from '@/components/ChannelView';
import type { Channel } from '@/types';

export default function DMPage() {
  const params = useParams();
  const targetUserId = params.userId as string;
  const { user } = useAuth();
  const { onlineUserIds } = usePresence();
  const [channel, setChannel] = useState<Channel | null>(null);

  useEffect(() => {
    async function findOrCreateDM() {
      const res = await fetch('/api/channels?filter=dm');
      if (res.ok) {
        const data = await res.json();
        const existing = data.channels.find((c: Channel) =>
          c.type === 'dm' && c.other_user?.id === targetUserId
        );
        if (existing) {
          setChannel(existing);
          return;
        }
      }

      const createRes = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dm', members: [targetUserId] }),
      });
      if (createRes.ok) {
        const refetchRes = await fetch('/api/channels?filter=dm');
        if (refetchRes.ok) {
          const refetchData = await refetchRes.json();
          const created = refetchData.channels.find((c: Channel) =>
            c.type === 'dm' && c.other_user?.id === targetUserId
          );
          if (created) {
            setChannel(created);
            return;
          }
        }
        const data = await createRes.json();
        setChannel(data.channel);
      }
    }
    if (targetUserId) findOrCreateDM();
  }, [targetUserId]);

  if (!channel || !user) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <svg className="animate-spin h-8 w-8 text-indigo-400" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return <ChannelView channel={channel} user={user} isDM onlineUserIds={onlineUserIds} />;
}
