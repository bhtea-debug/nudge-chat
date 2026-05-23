'use client';

import { useState } from 'react';
import type { Message } from '@/types';

interface Props {
  message: Message;
  onClose: () => void;
  onCreated?: () => void;
}

// Quick presets — selecting one fills both the relative offset and the text.
const presets: { label: string; minutes: number }[] = [
  { label: 'Za 30 min', minutes: 30 },
  { label: 'Za 1h', minutes: 60 },
  { label: 'Za 3h', minutes: 180 },
  { label: 'Jutro rano', minutes: -1 /* sentinel — handled below */ },
];

function tomorrowMorning(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ReminderModal({ message, onClose, onCreated }: Props) {
  const [when, setWhen] = useState<string>(toDatetimeLocal(new Date(Date.now() + 60 * 60_000)));
  const [text, setText] = useState<string>(message.content.length > 80 ? message.content.slice(0, 80) + '…' : message.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyPreset(minutes: number) {
    const d = minutes === -1 ? tomorrowMorning() : new Date(Date.now() + minutes * 60_000);
    setWhen(toDatetimeLocal(d));
  }

  async function save() {
    if (!when || !text.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const at = new Date(when);
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          remindAt: at.toISOString(),
          text: text.trim(),
          channelId: message.channel_id,
          messageId: message.id,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Zapis nieudany');
      }
      onCreated?.();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Coś poszło nie tak');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800">
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <h3 className="font-semibold text-slate-900 dark:text-slate-100">Przypomnij mi</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex flex-wrap gap-2">
            {presets.map(p => (
              <button
                key={p.label}
                onClick={() => applyPreset(p.minutes)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">Kiedy</label>
            <input
              type="datetime-local"
              value={when}
              onChange={e => setWhen(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1">O czym</label>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
          </div>

          {error && <p className="text-xs text-red-500">⚠ {error}</p>}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">Anuluj</button>
          <button
            onClick={save}
            disabled={saving || !when || !text.trim()}
            className="px-3 py-1.5 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-50"
          >
            {saving ? 'Zapisywanie…' : 'Ustaw przypomnienie'}
          </button>
        </div>
      </div>
    </div>
  );
}
