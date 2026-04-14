'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from './useAuth';
import { usePusherEvent } from './usePusher';

export function useNotifications() {
  const { user } = useAuth();
  const permissionRef = useRef<NotificationPermission>('default');
  const activeChannelRef = useRef<string | null>(null);

  useEffect(() => {
    if (!('Notification' in window)) return;
    permissionRef.current = Notification.permission;
  }, []);

  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;

    const result = await Notification.requestPermission();
    permissionRef.current = result;
    return result === 'granted';
  }, []);

  const showNotification = useCallback((title: string, options: {
    body: string;
    tag?: string;
    url?: string;
    icon?: string;
  }) => {
    if (permissionRef.current !== 'granted') return;

    // Don't show if tab is focused
    if (document.hasFocus()) return;

    // Use service worker if available for better reliability
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((registration) => {
        registration.showNotification(title, {
          body: options.body,
          icon: options.icon || '/icons/icon-192x192.png',
          badge: '/icons/icon-96x96.png',
          tag: options.tag || 'nudge-chat-' + Date.now(),
          data: { url: options.url || '/chat' },
          vibrate: [200, 100, 200] as any,
          requireInteraction: false,
        } as NotificationOptions);
      });
    } else {
      // Fallback to basic Notification API
      const notification = new Notification(title, {
        body: options.body,
        icon: options.icon || '/icons/icon-192x192.png',
        tag: options.tag || 'nudge-chat-' + Date.now(),
      });
      notification.onclick = () => {
        window.focus();
        if (options.url) {
          window.location.href = options.url;
        }
        notification.close();
      };
    }
  }, []);

  const setActiveChannel = useCallback((channelId: string | null) => {
    activeChannelRef.current = channelId;
  }, []);

  // Listen for new messages on user's private channel
  usePusherEvent(
    user ? `private-user-${user.id}` : null,
    'new-message-notification',
    (data: {
      channelId: string;
      channelName: string;
      channelType: string;
      senderName: string;
      senderId: string;
      content: string;
      messageId: string;
    }) => {
      // Don't notify for own messages
      if (data.senderId === user?.id) return;
      // Don't notify if user is viewing this channel
      if (activeChannelRef.current === data.channelId) return;

      const title = data.channelType === 'dm'
        ? data.senderName
        : `#${data.channelName}`;

      const body = data.channelType === 'dm'
        ? data.content.substring(0, 100)
        : `${data.senderName}: ${data.content.substring(0, 100)}`;

      const url = data.channelType === 'dm'
        ? `/chat/dm/${data.senderId}`
        : `/chat/${data.channelName}`;

      showNotification(title, {
        body,
        tag: `msg-${data.channelId}`,
        url,
      });
    }
  );

  // Listen for @mentions
  usePusherEvent(
    user ? `private-user-${user.id}` : null,
    'mention',
    (data: {
      messageId: string;
      channelId: string;
      mentionedBy: string;
      content: string;
    }) => {
      showNotification(`${data.mentionedBy} wspomniał/a o Tobie`, {
        body: data.content.substring(0, 100),
        tag: `mention-${data.messageId}`,
        url: '/chat',
      });
    }
  );

  // Listen for thread replies to user's messages
  usePusherEvent(
    user ? `private-user-${user.id}` : null,
    'thread-reply',
    (data: {
      channelId: string;
      channelName: string;
      senderName: string;
      content: string;
      parentMessageId: string;
    }) => {
      showNotification(`${data.senderName} odpowiedział/a w wątku`, {
        body: data.content.substring(0, 100),
        tag: `thread-${data.parentMessageId}`,
        url: '/chat',
      });
    }
  );

  return {
    requestPermission,
    showNotification,
    setActiveChannel,
    permission: permissionRef.current,
  };
}
