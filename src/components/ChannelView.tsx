'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChat } from '@/hooks/useChat';
import { useTyping } from '@/hooks/useTyping';
import { usePinned } from '@/hooks/usePinned';
import MessageList from './MessageList';
import MessageInput from './MessageInput';
import ThreadPanel from './ThreadPanel';
import ChannelHeader from './ChannelHeader';
import PinnedBanner from './PinnedBanner';
import ReminderModal from './ReminderModal';
import ForwardModal from './ForwardModal';
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
  const [reminderFor, setReminderFor] = useState<Message | null>(null);
  const [forwardFor, setForwardFor] = useState<Message | null>(null);
  const [allChannels, setAllChannels] = useState<Channel[]>([]);

  const { messages, loading, hasMore, sending, sendMessage, toggleReaction, editMessage, deleteMessage, loadMore } =
    useChat(channel.id);
  const { typingUsers, notifyTyping } = useTyping(channel.id, user.id, user.name);
  const { pinned, refresh: refreshPinned } = usePinned(channel.id);

  // Channels are fetched lazily when the forward modal opens — they aren't
  // needed until then.
  useEffect(() => {
    if (!forwardFor || allChannels.length > 0) return;
    fetch('/api/channels')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.channels) setAllChannels(data.channels); })
      .catch(() => {});
  }, [forwardFor, allChannels.length]);

  const pinToggle = useCallback(async (messageId: string, pinned: boolean) => {
    const method = pinned ? 'POST' : 'DELETE';
    const url = pinned
      ? '/api/pinned'
      : `/api/pinned?messageId=${encodeURIComponent(messageId)}`;
    const init: RequestInit = pinned
      ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId }) }
      : { method };
    const res = await fetch(url, init);
    if (!res.ok) throw new Error('Pin failed');
    refreshPinned();
  }, [refreshPinned]);

  const saveToggle = useCallback(async (messageId: string, saved: boolean) => {
    const res = saved
      ? await fetch('/api/saved', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageId }),
        })
      : await fetch(`/api/saved?messageId=${encodeURIComponent(messageId)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Save failed');
  }, []);

  // Mark mention as read when its message is in view. Cheap optimistic mark
  // for every fetched message that mentions me — server is idempotent.
  const markedRef = useRef(new Set<string>());
  useEffect(() => {
    const mine = messages.filter(m =>
      typeof m.content === 'string'
      && m.content.includes(`@[${user.name}](${user.id})`)
      && !markedRef.current.has(m.id),
    );
    for (const m of mine) {
      markedRef.current.add(m.id);
      fetch('/api/mentions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: m.id }),
      }).catch(() => {});
    }
  }, [messages, user.id, user.name]);

  const otherUserId = channel.other_user?.id;
  const isOtherOnline = !!(otherUserId && onlineUserIds?.has(otherUserId));

  const emptyState = isDM || channel.type === 'dm'
    ? { title: 'Brak wiadomości', subtitle: `Wyślij pierwszą wiadomość do ${channel.other_user?.name || 'tej osoby'}.` }
    : { title: `Witaj na #${channel.name}`, subtitle: channel.description || 'To początek tego kanału — bądź pierwszy z wiadomością.' };

  return (
    <div className="flex-1 flex">
      <div className="flex-1 flex flex-col min-w-0">
        <ChannelHeader channel={channel} isDM={isDM} isOnline={isOtherOnline} />
        <PinnedBanner
          pinned={pinned}
          onUnpin={async (id) => {
            await fetch(`/api/pinned?messageId=${encodeURIComponent(id)}`, { method: 'DELETE' });
            refreshPinned();
          }}
        />
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
          onPinToggle={pinToggle}
          onSaveToggle={saveToggle}
          onRemindMe={setReminderFor}
          onForward={setForwardFor}
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

      {reminderFor && (
        <ReminderModal
          message={reminderFor}
          onClose={() => setReminderFor(null)}
        />
      )}

      {forwardFor && (
        <ForwardModal
          message={forwardFor}
          channels={allChannels}
          onClose={() => setForwardFor(null)}
        />
      )}
    </div>
  );
}
