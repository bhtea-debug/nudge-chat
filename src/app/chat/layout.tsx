'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { usePWA } from '@/hooks/usePWA';
import { useNotifications } from '@/hooks/useNotifications';
import { useRouter, usePathname } from 'next/navigation';
import Sidebar from '@/components/Sidebar';
import ChannelList from '@/components/ChannelList';
import MobileTabBar from '@/components/MobileTabBar';
import NotificationPrompt from '@/components/NotificationPrompt';
import type { Channel } from '@/types';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const { isOnline } = usePWA();
  const { setActiveChannel } = useNotifications();
  const router = useRouter();
  const pathname = usePathname();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [filter, setFilter] = useState<'all' | 'unread' | 'dm' | 'group'>('all');
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [showMobileChat, setShowMobileChat] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Auto-detect if we're in a channel/DM view on initial load (e.g. page refresh)
  // so mobile shows the message area instead of the channel list
  useEffect(() => {
    const inChannel = pathname !== '/chat' && !pathname.startsWith('/chat/contacts') && !pathname.startsWith('/chat/news');
    if (inChannel) {
      setShowMobileChat(true);
    }
  }, [pathname]);

  // Detect which mobile tab is active
  const mobileTab = pathname.startsWith('/chat/contacts')
    ? 'contacts'
    : pathname.startsWith('/chat/news')
    ? 'news'
    : 'chat';

  useEffect(() => {
    if (!loading && !user) {
      router.push('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(console.error);
    }
  }, []);

  useEffect(() => {
    setActiveChannel(activeChannelId);
  }, [activeChannelId, setActiveChannel]);

  useEffect(() => {
    fetchChannels();
    const interval = setInterval(fetchChannels, 10000);
    return () => clearInterval(interval);
  }, [filter]);

  async function fetchChannels() {
    try {
      const res = await fetch(`/api/channels?filter=${filter}`);
      if (res.ok) {
        const data = await res.json();
        setChannels(data.channels);
      }
    } catch (e) {
      console.error('Failed to fetch channels:', e);
    }
  }

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
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3">
          <svg className="animate-spin h-8 w-8 text-indigo-500" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-slate-500 font-medium">\u0141adowanie...</span>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // Contacts or News page \u2014 render full-width on mobile, no sidebar needed
  const isSubPage = pathname.startsWith('/chat/contacts') || pathname.startsWith('/chat/news');

  return (
    <div className="h-[100dvh] flex flex-col bg-white overflow-hidden safe-top">
      {/* Offline banner */}
      {!isOnline && (
        <div className="bg-amber-500 text-white text-xs font-medium text-center py-1.5 px-4 shrink-0">
          Brak po\u0142\u0105czenia z internetem \u2014 tryb offline
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar - nawigacja globalna (desktop only) */}
        <div className="hidden md:flex">
          <Sidebar user={user} onLogout={logout} />
        </div>

        {/* Contacts/News pages \u2014 full width */}
        {isSubPage ? (
          <div className="flex-1 flex flex-col min-w-0">
            {children}
          </div>
        ) : (
          <>
            {/* Lista konwersacji */}
            <div className={`w-full md:w-80 border-r border-slate-200 flex flex-col bg-white shrink-0 ${showMobileChat ? 'hidden md:flex' : 'flex'}`}>
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
              />
            </div>

            {/* Okno wiadomo\u015bci */}
            <div className={`flex-1 flex flex-col min-w-0 ${!showMobileChat ? 'hidden md:flex' : 'flex'}`}>
              {pathname === '/chat' ? (
                <div className="flex-1 flex items-center justify-center bg-slate-50">
                  <div className="text-center">
                    <div className="inline-flex items-center justify-center w-20 h-20 bg-indigo-50 rounded-2xl mb-4">
                      <svg className="w-10 h-10 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                    </div>
                    <h2 className="text-xl font-semibold text-slate-700">Nudge Chat</h2>
                    <p className="text-slate-400 mt-1">Wybierz konwersacj\u0119 z listy po lewej</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Back button for mobile */}
                  <button
                    onClick={() => { setShowMobileChat(false); router.push('/chat'); }}
                    className="md:hidden flex items-center gap-2 px-4 py-2 text-indigo-600 font-medium border-b border-slate-100 shrink-0 safe-top"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    Wr\u00f3\u0107
                  </button>
                  {children}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Mobile bottom tab bar */}
      <div className="md:hidden shrink-0">
        <MobileTabBar
          activeTab={mobileTab}
          unreadCount={totalUnread}
          onLogout={logout}
          userName={user.name}
        />
      </div>

      {/* Notification prompt */}
      <NotificationPrompt />
    </div>
  );
}
