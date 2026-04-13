'use client';

import { useState, useEffect } from 'react';
import type { User } from '@/types';

interface NewChannelModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export default function NewChannelModal({ onClose, onCreated }: NewChannelModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [type, setType] = useState<'group' | 'dm'>('group');

  useEffect(() => {
    async function fetchUsers() {
      const res = await fetch('/api/search?q=&type=people');
      if (res.ok) {
        const data = await res.json();
        setUsers(data.results?.people || []);
      }
    }
    fetchUsers();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, type, members: selectedUsers }),
      });
      if (res.ok) {
        onCreated();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Nie udało się utworzyć konwersacji');
      }
    } catch {
      setError('Błąd połączenia z serwerem');
    } finally {
      setLoading(false);
    }
  }

  function toggleUser(userId: string) {
    setSelectedUsers(prev =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-900">Nowa konwersacja</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Type selector */}
          <div className="flex gap-2">
            <button type="button" onClick={() => setType('group')}
              className={`flex-1 py-2 text-sm font-medium rounded-xl transition-colors ${type === 'group' ? 'bg-indigo-50 text-indigo-600 border border-indigo-200' : 'bg-slate-50 text-slate-500 border border-slate-200'}`}>
              Kanał grupowy
            </button>
            <button type="button" onClick={() => setType('dm')}
              className={`flex-1 py-2 text-sm font-medium rounded-xl transition-colors ${type === 'dm' ? 'bg-indigo-50 text-indigo-600 border border-indigo-200' : 'bg-slate-50 text-slate-500 border border-slate-200'}`}>
              Wiadomość prywatna
            </button>
          </div>

          {type === 'group' && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nazwa kanału</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="np. ogólny, marketing, dev..."
                  required
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Opis (opcjonalnie)</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="O czym jest ten kanał?"
                  className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </>
          )}

          {/* User list */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              {type === 'dm' ? 'Wybierz osobę' : 'Dodaj członków'}
            </label>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {users.map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    if (type === 'dm') {
                      setSelectedUsers([u.id]);
                    } else {
                      toggleUser(u.id);
                    }
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-colors ${
                    selectedUsers.includes(u.id) ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-slate-50 border border-transparent'
                  }`}
                >
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-xs">
                    {u.name?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate">{u.name}</p>
                    <p className="text-xs text-slate-400 truncate">{u.email}</p>
                  </div>
                  {selectedUsers.includes(u.id) && (
                    <svg className="w-5 h-5 text-indigo-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </form>

        <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700">
            Anuluj
          </button>
          <button
            onClick={handleSubmit as any}
            disabled={loading || (type === 'group' && !name) || selectedUsers.length === 0}
            className="px-4 py-2 bg-indigo-500 text-white text-sm font-medium rounded-xl hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Tworzenie...' : 'Utwórz'}
          </button>
        </div>
      </div>
    </div>
  );
}
