'use client';

import { usePathname, useRouter } from 'next/navigation';
import type { User } from '@/types';

interface SidebarProps {
  user: User;
  onLogout: () => void;
}

const navItems = [
  {
    id: 'chat',
    label: 'Chat',
    path: '/chat',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
    ),
  },
  {
    id: 'contacts',
    label: 'Kontakty',
    path: '/chat/contacts',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
  },
  {
    id: 'news',
    label: 'Aktualności',
    path: '/chat/news',
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6v-3z" />
      </svg>
    ),
  },
];

export default function Sidebar({ user, onLogout }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  function isActive(path: string) {
    if (path === '/chat') {
      return pathname === '/chat' || (pathname.startsWith('/chat/') && !pathname.startsWith('/chat/contacts') && !pathname.startsWith('/chat/news'));
    }
    return pathname.startsWith(path);
  }

  return (
    <div className="w-[72px] bg-gradient-to-b from-indigo-600 to-violet-700 flex flex-col items-center py-4 shrink-0">
      {/* Logo */}
      <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center mb-6 cursor-pointer hover:bg-white/30 transition-colors" onClick={() => router.push('/chat')}>
        <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
        </svg>
      </div>

      {/* Nav items */}
      <nav className="flex-1 flex flex-col items-center gap-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => router.push(item.path)}
            className={`group relative w-12 h-12 rounded-xl flex items-center justify-center transition-all ${
              isActive(item.path)
                ? 'bg-white/20 text-white'
                : 'text-white/60 hover:bg-white/10 hover:text-white'
            }`}
          >
            {item.icon}
            {/* Tooltip */}
            <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all whitespace-nowrap z-50 shadow-lg">
              {item.label}
            </span>
            {/* Active indicator */}
            {isActive(item.path) && (
              <div className="absolute left-0 w-1 h-5 bg-white rounded-r-full" />
            )}
          </button>
        ))}
      </nav>

      {/* User avatar + logout */}
      <div className="flex flex-col items-center gap-2 mt-auto">
        <button
          onClick={onLogout}
          className="group relative w-10 h-10 rounded-xl flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
          <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all whitespace-nowrap z-50 shadow-lg">
            Wyloguj
          </span>
        </button>
        <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center text-white font-semibold text-sm">
          {user.name?.charAt(0).toUpperCase() || '?'}
        </div>
      </div>
    </div>
  );
}
