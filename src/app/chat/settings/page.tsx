'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useTheme } from '@/hooks/useTheme';
import { useNotifications } from '@/hooks/useNotifications';

const statusOptions: { value: 'online' | 'away' | 'dnd'; label: string; emoji: string; desc: string }[] = [
  { value: 'online', label: 'Dostępny', emoji: '🟢', desc: 'Widoczny i powiadomienia włączone' },
  { value: 'away',   label: 'Z dala',   emoji: '🟡', desc: 'Jesteś tu, ale pewnie nie odpowiesz od razu' },
  { value: 'dnd',    label: 'Nie przeszkadzać', emoji: '🔴', desc: 'Bez powiadomień push, status czerwony' },
];

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { permission, requestPermission } = useNotifications();
  const [statusValue, setStatusValue] = useState<'online' | 'away' | 'dnd'>('online');
  const [statusText, setStatusText] = useState('');
  const [statusEmoji, setStatusEmoji] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // Load existing status — best effort.
    fetch('/api/presence')
      .then(r => r.ok ? r.json() : null)
      .then((data: any) => {
        if (!data || !user) return;
        const mine = (data.statuses || []).find((s: any) => s.user_id === user.id);
        if (mine) {
          if (mine.status && mine.status !== 'offline') setStatusValue(mine.status);
          if (mine.status_text) setStatusText(mine.status_text);
          if (mine.status_emoji) setStatusEmoji(mine.status_emoji);
        }
      })
      .catch(() => {});
  }, [user]);

  async function saveStatus() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: statusValue, statusText: statusText.trim() || null, statusEmoji: statusEmoji.trim() || null }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  }

  if (!user) return null;

  return (
    <div className="flex-1 flex flex-col bg-slate-50 dark:bg-slate-950 overflow-hidden">
      <div className="h-16 px-6 flex items-center border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
          <span>⚙️</span> Ustawienia
        </h1>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="max-w-2xl mx-auto p-6 space-y-6">
          {/* Profile */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Profil</h2>
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-bold">
                {user.name?.charAt(0).toUpperCase() || '?'}
              </div>
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{user.name}</p>
                <p className="text-xs text-slate-400">{user.email}</p>
              </div>
            </div>
          </section>

          {/* Theme */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Motyw</h2>
            <div className="grid grid-cols-3 gap-2">
              {(['light', 'system', 'dark'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`px-3 py-2 rounded-xl text-sm font-medium border transition-colors ${
                    theme === t
                      ? 'border-indigo-300 dark:border-indigo-500/60 bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  {t === 'light' ? '☀️ Jasny' : t === 'dark' ? '🌙 Ciemny' : '💻 System'}
                </button>
              ))}
            </div>
          </section>

          {/* Status */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Twój status</h2>
            <div className="space-y-1.5">
              {statusOptions.map(o => (
                <button
                  key={o.value}
                  onClick={() => setStatusValue(o.value)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${
                    statusValue === o.value
                      ? 'bg-indigo-50 dark:bg-indigo-500/15 ring-1 ring-indigo-300 dark:ring-indigo-500/50'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <span className="text-base">{o.emoji}</span>
                  <div>
                    <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{o.label}</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500">{o.desc}</p>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={statusEmoji}
                onChange={e => setStatusEmoji(e.target.value.slice(0, 4))}
                placeholder="😊"
                className="w-16 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-center text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <input
                value={statusText}
                onChange={e => setStatusText(e.target.value)}
                placeholder="Krótki status (opcjonalnie)"
                maxLength={80}
                className="flex-1 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveStatus}
                disabled={saving}
                className="px-3 py-1.5 text-sm font-medium bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50"
              >
                {saving ? 'Zapisywanie…' : 'Zapisz status'}
              </button>
              {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">✓ Zapisane</span>}
            </div>
          </section>

          {/* Notifications */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Powiadomienia</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-700 dark:text-slate-200">Powiadomienia w przeglądarce</p>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Status: {permission === 'granted' ? '✅ Włączone' : permission === 'denied' ? '⛔ Zablokowane' : '⏳ Nie ustawione'}
                </p>
              </div>
              {permission !== 'granted' && (
                <button
                  onClick={requestPermission}
                  className="px-3 py-1.5 text-sm font-medium bg-indigo-500 text-white rounded-lg hover:bg-indigo-600"
                >
                  Włącz
                </button>
              )}
            </div>
          </section>

          {/* Account actions */}
          <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5">
            <button
              onClick={logout}
              className="w-full py-2 text-sm font-medium bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 rounded-lg hover:bg-red-100 dark:hover:bg-red-500/20"
            >
              Wyloguj się
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}
