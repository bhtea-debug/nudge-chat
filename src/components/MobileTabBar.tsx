'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface MobileTabBarProps {
  activeTab: 'chat' | 'contacts' | 'news';
  unreadCount: number;
  onLogout: () => void;
  userName: string;
}

export default function MobileTabBar({ activeTab, unreadCount, onLogout, userName }: MobileTabBarProps) {
  const router = useRouter();
  const [showProfile, setShowProfile] = useState(false);

  const tabs = [
    {
      id: 'chat' as const,
      label: 'Chat',
      path: '/chat',
      icon: (active: boolean) => (
        <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 0 : 1.5}>
          {active ? (
            <path d="M4.913 2.658c2.075-.27 4.19-.408 6.337-.408 2.147 0 4.262.139 6.337.408 1.922.25 3.291 1.861 3.405 3.727a4.403 4.403 0 00-1.032-.211 50.89 50.89 0 00-8.42 0c-2.358.196-4.04 2.19-4.04 4.434v4.286a4.47 4.47 0 002.433 3.984L7.28 21.53A.75.75 0 016 21v-4.03a48.527 48.527 0 01-1.087-.128C2.905 16.58 1.5 14.833 1.5 12.862V6.638c0-1.97 1.405-3.718 3.413-3.979z" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          )}
        </svg>
      ),
      badge: unreadCount,
    },
    {
      id: 'contacts' as const,
      label: 'Kontakty',
      path: '/chat/contacts',
      icon: (active: boolean) => (
        <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 0 : 1.5}>
          {active ? (
            <path fillRule="evenodd" d="M8.25 6.75a3.75 3.75 0 117.5 0 3.75 3.75 0 01-7.5 0zM15.75 9.75a3 3 0 116 0 3 3 0 01-6 0zM2.25 9.75a3 3 0 116 0 3 3 0 01-6 0zM6.31 15.117A6.745 6.745 0 0112 12a6.745 6.745 0 016.709 7.498.75.75 0 01-.372.568A12.696 12.696 0 0112 21.75c-2.305 0-4.47-.612-6.337-1.684a.75.75 0 01-.372-.568 6.787 6.787 0 011.019-4.38z" clipRule="evenodd" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
          )}
        </svg>
      ),
    },
    {
      id: 'news' as const,
      label: 'Aktualności',
      path: '/chat/news',
      icon: (active: boolean) => (
        <svg className="w-6 h-6" fill={active ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={active ? 0 : 1.5}>
          {active ? (
            <path fillRule="evenodd" d="M4.125 3C3.089 3 2.25 3.84 2.25 4.875V18a3 3 0 003 3h15a3 3 0 01-3-3V4.875C17.25 3.839 16.41 3 15.375 3H4.125zM12 9.75a.75.75 0 000 1.5h1.5a.75.75 0 000-1.5H12zm-.75-2.25a.75.75 0 01.75-.75h1.5a.75.75 0 010 1.5H12a.75.75 0 01-.75-.75zM6 12.75a.75.75 0 000 1.5h7.5a.75.75 0 000-1.5H6zm-.75 3.75a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5H6a.75.75 0 01-.75-.75zM6 6.75a.75.75 0 00-.75.75v3c0 .414.336.75.75.75h3a.75.75 0 00.75-.75v-3A.75.75 0 009 6.75H6z" clipRule="evenodd" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6v-3z" />
          )}
        </svg>
      ),
    },
  ];

  return (
    <>
      {/* Profile sheet */}
      {showProfile && (
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowProfile(false)} />
          <div className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl p-6 safe-bottom animate-slide-up">
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto mb-6" />
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-bold text-lg">
                {userName?.charAt(0).toUpperCase() || '?'}
              </div>
              <div>
                <p className="font-semibold text-slate-900">{userName}</p>
                <p className="text-sm text-slate-400">Online</p>
              </div>
            </div>
            <button
              onClick={() => { setShowProfile(false); onLogout(); }}
              className="w-full py-3 px-4 bg-red-50 text-red-600 font-medium rounded-xl hover:bg-red-100 transition-colors text-sm"
            >
              Wyloguj się
            </button>
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div className="bg-white border-t border-slate-200 safe-bottom">
        <div className="flex items-center justify-around px-2 pt-1.5 pb-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => router.push(tab.path)}
                className={`flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-xl transition-colors relative ${
                  isActive ? 'text-indigo-600' : 'text-slate-400'
                }`}
              >
                <div className="relative">
                  {tab.icon(isActive)}
                  {tab.badge && tab.badge > 0 ? (
                    <span className="absolute -top-1.5 -right-2.5 bg-red-500 text-white text-[9px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1">
                      {tab.badge > 99 ? '99+' : tab.badge}
                    </span>
                  ) : null}
                </div>
                <span className="text-[10px] font-medium">{tab.label}</span>
              </button>
            );
          })}

          {/* Profile tab */}
          <button
            onClick={() => setShowProfile(true)}
            className="flex flex-col items-center gap-0.5 px-4 py-1.5 text-slate-400"
          >
            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-bold text-[10px]">
              {userName?.charAt(0).toUpperCase() || '?'}
            </div>
            <span className="text-[10px] font-medium">Profil</span>
          </button>
        </div>
      </div>
    </>
  );
}
