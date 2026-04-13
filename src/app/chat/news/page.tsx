'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { formatDistanceToNow } from 'date-fns';
import { pl } from 'date-fns/locale';
import type { NewsPost } from '@/types';

export default function NewsPage() {
  const { user } = useAuth();
  const [news, setNews] = useState<NewsPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  useEffect(() => {
    fetchNews();
  }, []);

  async function fetchNews() {
    try {
      const res = await fetch('/api/news');
      if (res.ok) {
        const data = await res.json();
        setNews(data.news);
      }
    } finally {
      setLoading(false);
    }
  }

  async function createPost(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    });
    if (res.ok) {
      setTitle('');
      setContent('');
      setShowForm(false);
      fetchNews();
    }
  }

  async function toggleLike(newsId: string) {
    await fetch(`/api/news/${newsId}/likes`, { method: 'POST' });
    fetchNews();
  }

  return (
    <div className="flex-1 flex flex-col bg-slate-50">
      <div className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">Aktualności</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-indigo-500 text-white text-sm font-medium rounded-xl hover:bg-indigo-600 transition-colors"
        >
          + Nowy post
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <div className="max-w-2xl mx-auto py-6 px-4 space-y-4">
          {/* New post form */}
          {showForm && (
            <form onSubmit={createPost} className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Tytuł ogłoszenia"
                required
                className="w-full text-lg font-semibold text-slate-900 placeholder:text-slate-300 focus:outline-none mb-3"
              />
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Treść..."
                rows={4}
                required
                className="w-full text-slate-700 placeholder:text-slate-300 focus:outline-none resize-none"
              />
              <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700">
                  Anuluj
                </button>
                <button type="submit" className="px-4 py-2 bg-indigo-500 text-white text-sm font-medium rounded-xl hover:bg-indigo-600">
                  Opublikuj
                </button>
              </div>
            </form>
          )}

          {/* News feed */}
          {loading ? (
            <div className="flex justify-center py-12">
              <svg className="animate-spin h-8 w-8 text-indigo-400" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : news.length === 0 ? (
            <div className="text-center py-12 text-slate-400">
              Brak aktualności
            </div>
          ) : (
            news.map(post => (
              <article key={post.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                {post.image_url && (
                  <img src={post.image_url} alt="" className="w-full h-48 object-cover" />
                )}
                <div className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-xs">
                      {(post.author?.name || 'U').charAt(0)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{post.author?.name || 'Unknown'}</p>
                      <p className="text-xs text-slate-400">
                        {formatDistanceToNow(new Date(post.created_at), { addSuffix: true, locale: pl })}
                      </p>
                    </div>
                    {post.pinned ? (
                      <span className="ml-auto text-xs bg-amber-50 text-amber-600 px-2 py-0.5 rounded-full font-medium">Przypięty</span>
                    ) : null}
                  </div>
                  <h2 className="text-lg font-semibold text-slate-900 mb-2">{post.title}</h2>
                  <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap">{post.content}</p>
                  <div className="flex items-center gap-4 mt-4 pt-4 border-t border-slate-100">
                    <button
                      onClick={() => toggleLike(post.id)}
                      className={`flex items-center gap-1.5 text-sm ${post.liked_by_me ? 'text-red-500' : 'text-slate-400 hover:text-red-500'} transition-colors`}
                    >
                      <svg className="w-4 h-4" fill={post.liked_by_me ? 'currentColor' : 'none'} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                      </svg>
                      {post.likes_count}
                    </button>
                    <span className="flex items-center gap-1.5 text-sm text-slate-400">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                      </svg>
                      {post.comments_count}
                    </span>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
