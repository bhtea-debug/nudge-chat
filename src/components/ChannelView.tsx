'use client';

import { useState } from 'react';
import { useChat } from '@/hooks/useChat';
import { useTyping } from '@/hooks/useTyping';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import ThreadPanel from './ThreadPanel';
import ChannelHeader from './ChannelHeader';
import type { Channel, Message, User } from '@/types';

interface Props {
  channel: Channel;
  user: User;
  isDM?: boolean;
  onlineUserIds?: Set<string>;
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} pisze...`;
  if (names.length === 2) return `${names[0]} i ${names[1]} piszą...`;
  return `${names.length} osób pisze...`;
}

export default function ChannelView({ channel, user, isDM, onlineUserIds }: Props) {
  const [threadMessage, setThreadMessage] = useState<Message | null>(null);
  const { messages, loading, hasMore, sending, sendMessage, toggleReaction, editMessage, deleteMessage, loadMore } =
    useChat(channel.id);
  const { typingUsers, notifyTyping } = useTyping(channel.id, user.id, user.name);

  const otherUserId = channel.other_user?.id;
  const isOtherOnline = !!(otherUserId && onlineUserIds?.has(otherUserId));

  const emptyState = isDM || channel.type === 'dm'
    ? { title: 'Brak wiadomości', subtitle: `Wyślij pierwszą wiadomość do ${channel.other_user?.name || 'tej osoby'}.` }
    : { title: `Witaj na #${channel.name}`, subtitle: channel.description || 'To początek tego kanału — bądź pierwszy z wiadomością.' };

  return (
    <div className="flex-1 flex">
      <div className="flex-1 flex flex-col min-w-0">
        <ChannelHeader channel={channel} isDM={isDM} isOnline={isOtherOnline} />
        <MessageList
          messages={messages}
          currentUserId={user.id}
          loading={loading}
          hasMore={hasMore}
          onLoadMore={loadMore}
          onReaction={toggleReaction}
          onThreadOpen={(msg) => setThreadMessage(msg)}
          onEdit={editMessage}
          onDelete={deleteMessage}
          emptyState={emptyState}
        />
        {typingUsers.length > 0 && (
          <div className="px-4 py-1.5 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2 shrink-0">
            <span className="flex gap-0.5">
              <span className="typing-dot w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
              <span className="typing-dot w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
              <span className="typing-dot w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
            </span>
            <span>{typingLabel(typingUsers.map(t => t.userName))}</span>
          </div>
        )}
        <MessageInput
          onSend={sendMessage}
          sending={sending}
          channelId={channel.id}
          onTyping={notifyTyping}
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
