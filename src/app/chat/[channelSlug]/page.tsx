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

export default function ChannelPage() {
  const params = useParams();
  const channelSlug = params.channelSlug as string;
  const { user } = useAuth();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [threadMessage, setThreadMessage] = useState<Message | null>(null);

  useEffect(() => {
    async function fetchChannel() {
      const res = await fetch('/api/channels');
      if (res.ok) {
        const data = await res.json();
        const found = data.channels.find((c: Channel) => c.slug === channelSlug);
        if (found) setChannel(found);
      }
    }
    fetchChannel();
  }, [channelSlug]);

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
        <ChannelHeader channel={channel} />
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

      {/* Thread panel */}
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
