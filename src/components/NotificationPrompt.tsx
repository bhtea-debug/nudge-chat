'use client';

import { useState, useEffect } from 'react';
import { useNotifications } from '@/hooks/useNotifications';

export default function NotificationPrompt() {
  const { requestPermission } = useNotifications();
  const [show, setShow] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      // Show prompt after 3 seconds
      const timer = setTimeout(() => setShow(true), 3000);
      return () => clearTimeout(timer);
    }
  }, []);

  if (!show || dismissed) return null;

  async function handleAllow() {
    await requestPermission();
    setShow(false);
  }

  function handleDismiss() {
    setDismissed(true);
    setShow(false);
  }

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-sm animate-in slide-in-from-bottom">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 p-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-slate-900 text-sm">Powiadomienia</p>
            <p className="text-xs text-slate-500 mt-0.5">
              Chcesz otrzymywać powiadomienia o nowych wiadomościach?
            </p>
            <div className="flex gap-2 mt-3">
              <button
                onClick={handleAllow}
                className="px-3 py-1.5 bg-indigo-500 text-white text-xs font-medium rounded-lg hover:bg-indigo-600 transition-colors"
              >
                Tak, włącz
              </button>
              <button
                onClick={handleDismiss}
                className="px-3 py-1.5 text-slate-500 text-xs font-medium rounded-lg hover:bg-slate-50 transition-colors"
              >
                Nie teraz
              </button>
            </div>
          </div>
          <button onClick={handleDismiss} className="text-slate-300 hover:text-slate-500 shrink-0">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
