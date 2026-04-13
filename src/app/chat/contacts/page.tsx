'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { Contact } from '@/types';

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    async function fetchContacts() {
      try {
        const res = await fetch('/api/contacts');
        if (res.ok) {
          const data = await res.json();
          setContacts(data.contacts);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchContacts();
  }, []);

  const filtered = contacts.filter(c =>
    c.display_name.toLowerCase().includes(search.toLowerCase()) ||
    c.position?.toLowerCase().includes(search.toLowerCase()) ||
    c.department?.toLowerCase().includes(search.toLowerCase())
  );

  const grouped = filtered.reduce((acc, contact) => {
    const dept = contact.department || 'Inne';
    if (!acc[dept]) acc[dept] = [];
    acc[dept].push(contact);
    return acc;
  }, {} as Record<string, Contact[]>);

  return (
    <div className="flex-1 flex flex-col bg-white">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200">
        <h1 className="text-xl font-bold text-slate-900">Kontakty</h1>
        <div className="mt-3 relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Szukaj kontaktu..."
            className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Contact list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <svg className="animate-spin h-8 w-8 text-indigo-400" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        ) : Object.entries(grouped).length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            Brak kontaktów
          </div>
        ) : (
          Object.entries(grouped).map(([dept, deptContacts]) => (
            <div key={dept}>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 px-2">{dept}</h3>
              <div className="space-y-1">
                {deptContacts.map(contact => (
                  <button
                    key={contact.id}
                    onClick={() => router.push(`/chat/dm/${contact.user_id}`)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-50 transition-colors text-left"
                  >
                    <div className="relative">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-sm">
                        {contact.display_name.charAt(0).toUpperCase()}
                      </div>
                      {contact.status?.status === 'online' && (
                        <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-400 rounded-full border-2 border-white" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-900 text-sm truncate">{contact.display_name}</p>
                      <p className="text-xs text-slate-400 truncate">
                        {contact.position && `${contact.position}`}
                        {contact.status?.status_emoji && ` ${contact.status.status_emoji}`}
                        {contact.status?.status_text && ` ${contact.status.status_text}`}
                      </p>
                    </div>
                    {contact.phone && (
                      <span className="text-xs text-slate-400">{contact.phone}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
