'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { useChat } from '@/hooks/useChat';
import MessageList from '@/components/MessageList';
import MessageInput from '@/components/MessageInput';
import ThreadPanel from '@/components/ThreadPanel';
import ChannelHeader from '@/components/ChannelHeader';
import type { Channel, Message } from '@/types';

export default function DMPage() {
  const params = useParams();
  const targetUserId = params.userId as string;
  const { user } = useAuth();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [threadMessage, setThreadMessage] = useState<Message | null>(null);

  useEffect(() => {
    async function findOrCreateDM() {
      // First try to find existing DM
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

      // Create new DM
      const createRes = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'dm', name: 'DM', members: [targetUserId] }),
      });
      if (createRes.ok) {
        const data = await createRes.json();
        setChannel(data.channel);
      }
    }
    if (targetUserId) findOrCreateDM();
  }, [targetUserId]);

  const { messages, loading, hasMore, sending, sendMessage, toggleReaction, loadMore } = useChat(channel?.id || null);

  if (!channel || !user) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <svg className="animate-spin h-8 w-8 text-indigo-400" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex-1 flex">
      <div className="flex-1 flex flex-col min-w-0">
        <ChannelHeader channel={channel} isDM />
        <MessageList
          messages={messages}
          currentUserId={user.id}
          loading={loading}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onReaction={toggleReaction}
          onThreadOpen={(msg) => setThreadMessage(msg)}
        />
        <MessageInput
          onSend={sendMessage}
          sending={sending}
          channelId={channel.id}
        />
      </div>

      {threadMessage && (
        <ThreadPanel
          message={threadMessage}
          channelId={channel.id}
          currentUserId={user.id}
          onClose={() => setThreadMessage(null)}
        />
      )}
    </div>
  );
}
