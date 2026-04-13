'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import PusherClient from 'pusher-js';
import type { Channel } from 'pusher-js';

let pusherInstance: PusherClient | null = null;

function getPusher(): PusherClient {
  if (!pusherInstance) {
    pusherInstance = new PusherClient(process.env.NEXT_PUBLIC_PUSHER_KEY!, {
      cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
      authEndpoint: '/api/pusher/auth',
    });
  }
  return pusherInstance;
}

export function usePusherChannel(channelName: string | null) {
  const channelRef = useRef<Channel | null>(null);

  useEffect(() => {
    if (!channelName) return;

    const pusher = getPusher();
    const channel = pusher.subscribe(channelName);
    channelRef.current = channel;

    return () => {
      pusher.unsubscribe(channelName);
      channelRef.current = null;
    };
  }, [channelName]);

  const bind = useCallback((event: string, callback: (data: any) => void) => {
    channelRef.current?.bind(event, callback);
    return () => {
      channelRef.current?.unbind(event, callback);
    };
  }, []);

  return { channel: channelRef.current, bind };
}

export function usePusherEvent(
  channelName: string | null,
  event: string,
  callback: (data: any) => void
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!channelName) return;

    const pusher = getPusher();
    const channel = pusher.subscribe(channelName);

    const handler = (data: any) => callbackRef.current(data);
    channel.bind(event, handler);

    return () => {
      channel.unbind(event, handler);
    };
  }, [channelName, event]);
}

export function usePresenceChannel(channelName: string | null) {
  const channelRef = useRef<Channel | null>(null);
  const [members, setMembers] = useState<any[]>([]);

  useEffect(() => {
    if (!channelName) return;

    const pusher = getPusher();
    const channel = pusher.subscribe(channelName);
    channelRef.current = channel;

    channel.bind('pusher:subscription_succeeded', (data: any) => {
      const memberList: any[] = [];
      data.each((member: any) => memberList.push(member));
      setMembers(memberList);
    });

    channel.bind('pusher:member_added', (member: any) => {
      setMembers(prev => [...prev, member]);
    });

    channel.bind('pusher:member_removed', (member: any) => {
      setMembers(prev => prev.filter(m => m.id !== member.id));
    });

    return () => {
      pusher.unsubscribe(channelName);
    };
  }, [channelName]);

  return { channel: channelRef.current, members };
}
