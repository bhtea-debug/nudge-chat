'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { usePWA } from '@/hooks/usePWA';
import { useNotifications } from '@/hooks/useNotifications';
import { PresenceProvider } from '@/hooks/usePresence';
import { MentionsProvider } from '@/hooks/useMentions';
import { usePusherEvent } from '@/hooks/usePusher';
import { useRouter, usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import ChannelList from '@/components/ChannelList';
import MobileTabBar from '@/components/MobileTabBar';
import NotificationPrompt from '@/components/NotificationPrompt';
import QuickSwitcher from '@/components/QuickSwitcher';
import ShortcutsOverlay from '@/components/ShortcutsOverlay';
import type { Channel } from '@/types';

const SUB_PAGES = ['/chat/contacts', '/chat/news', '/chat/saved', '/chat/mentions', '/chat/settings'];

function ChatShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const { isOnline } = usePWA();
  const { setActiveChannel, showNotification } = useNotifications();
  const router = useRouter();
  const pathname = usePathname();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [filter, setFilter] = useState<'all' | 'unread' | 'dm' | 'group'>('all');
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [showMobileChat, setShowMobileChat] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEffect(() => {
    const inChannel = pathname !== '/chat' && !SUB_PAGES.some(p => pathname.startsWith(p));
    if (inChannel) setShowMobileChat(true);
  }, [pathname]);

  const mobileTab = pathname.startsWith('/chat/contacts')
    ? 'contacts'
    : pathname.startsWith('/chat/news')
    ? 'news'
    : 'chat';

  useEffect(() => {
    if (!loading && !user) router.push('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(console.error);
    }
  }, []);

  useEffect(() => { setActiveChannel(activeChannelId); }, [activeChannelId, setActiveChannel]);

  const fetchChannels = useCallback(async () => {
    try {
      const res = await fetch(`/api/channels?filter=${filter}`);
      if (res.ok) {
        const data = await res.json();
        setChannels(data.channels);
      }
    } catch (e) {
      console.error('Failed to fetch channels:', e);
    }
  }, [filter]);

  useEffect(() => {
    fetchChannels();
    const interval = setInterval(fetchChannels, 10000);
    return () => clearInterval(interval);
  }, [fetchChannels]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickSwitcherOpen(true);
        return;
      }
      // `?` (Shift+/) — open shortcuts overlay, but don't trap while typing.
      if (e.key === '?' && !meta) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Reminder push — fired by Vercel Cron via Pusher.
  usePusherEvent(
    user ? `private-user-${user.id}` : null,
    'reminder',
    (data: { text: string; channelId?: string; messageId?: string }) => {
      showNotification('⏰ Przypomnienie', {
        body: data.text,
        url: data.channelId ? `/chat/${data.channelId}` : '/chat',
        tag: `reminder-${data.messageId || Date.now()}`,
      });
    },
  );

  function handleChannelSelect(channel: Channel) {
    setActiveChannelId(channel.id);
    setShowMobileChat(true);
    if (channel.type === 'dm' && channel.other_user) {
      router.push(`/chat/dm/${channel.other_user.id}`);
    } else {
      router.push(`/chat/${channel.slug}`);
    }
  }

  const totalUnread = channels.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="flex items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-slate-500 dark:text-slate-400 font-medium">Ładowanie...</span>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const isSubPage = SUB_PAGES.some(p => pathname.startsWith(p));

  return (
    <div className="h-[100dvh] flex flex-col bg-white dark:bg-slate-950 overflow-hidden safe-top">
      {!isOnline && (
        <div className="bg-amber-500 text-white text-xs font-medium text-center py-1.5 px-4 shrink-0">
          Brak połączenia z internetem — tryb offline
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="hidden md:flex">
          <Sidebar user={user} onLogout={logout} />
        </div>

        {isSubPage ? (
          <div className="flex-1 flex flex-col min-w-0">{children}</div>
        ) : (
          <>
            <div className={`w-full md:w-80 border-r border-slate-200 dark:border-slate-800 flex flex-col bg-white dark:bg-slate-900 shrink-0 ${showMobileChat ? 'hidden md:flex' : 'flex'}`}>
              <ChannelList
                channels={channels}
                activeChannelId={activeChannelId}
                filter={filter}
                onFilterChange={setFilter}
                onChannelSelect={handleChannelSelect}
                onRefresh={fetchChannels}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                user={user}
                onOpenQuickSwitcher={() => setQuickSwitcherOpen(true)}
              />
            </div>

            <div className={`flex-1 flex flex-col min-w-0 ${!showMobileChat ? 'hidden md:flex' : 'flex'}`}>
              {pathname === '/chat' ? (
                <div className="flex-1 flex items-center justify-center bg-slate-50 dark:bg-slate-950">
                  <div className="text-center px-6">
                    <div className="inline-flex items-center justify-center w-20 h-20 bg-indigo-50 dark:bg-indigo-500/10 rounded-2xl mb-4">
                      <svg className="w-10 h-10 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                    </div>
                    <h2 className="text-xl font-semibold text-slate-700 dark:text-slate-200">Wybierz konwersację</h2>
                    <p className="text-slate-400 dark:text-slate-500 mt-1 text-sm">
                      Kliknij kanał z listy, lub naciśnij{' '}
                      <kbd className="font-mono text-[11px] px-1.5 py-0.5 border border-slate-200 dark:border-slate-700 rounded">⌘K</kbd>{' '}
                      aby szybko znaleźć osobę. Naciśnij{' '}
                      <kbd className="font-mono text-[11px] px-1.5 py-0.5 border border-slate-200 dark:border-slate-700 rounded">?</kbd>{' '}
                      aby zobaczyć skróty.
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => { setShowMobileChat(false); router.push('/chat'); }}
                    className="md:hidden flex items-center gap-2 px-4 py-2 text-indigo-600 dark:text-indigo-300 font-medium border-b border-slate-100 dark:border-slate-800 shrink-0 safe-top"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    Wróć
                  </button>
                  {children}
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="md:hidden shrink-0">
        <MobileTabBar
          activeTab={mobileTab}
          unreadCount={totalUnread}
          onLogout={logout}
          userName={user.name}
        />
      </div>

      <NotificationPrompt />
      <QuickSwitcher channels={channels} open={quickSwitcherOpen} onClose={() => setQuickSwitcherOpen(false)} />
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <PresenceProvider>
      <MentionsProvider>
        <ChatShell>{children}</ChatShell>
      </MentionsProvider>
    </PresenceProvider>
  );
}
