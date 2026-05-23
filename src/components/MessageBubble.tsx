'use client';

import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { format } from 'date-fns';
import type { Message, Reaction } from '@/types';
import { parseDbDate } from '@/lib/datetime';
import MessageContent from './MessageContent';

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  isConsecutive: boolean;
  onReaction: (messageId: string, emoji: string) => void;
  onThreadOpen: () => void;
  onEdit?: (messageId: string, newContent: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  currentUserId: string;
}

const quickReactions = ['👍', '❤️', '😂', '🎉', '👀', '🔥'];

export default function MessageBubble({
  message,
  isOwn,
  isConsecutive,
  onReaction,
  onThreadOpen,
  onEdit,
  onDelete,
  currentUserId,
}: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [editError, setEditError] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      const len = editRef.current.value.length;
      editRef.current.setSelectionRange(len, len);
      editRef.current.style.height = 'auto';
      editRef.current.style.height = Math.min(editRef.current.scrollHeight, 200) + 'px';
    }
  }, [editing]);

  // Close overflow menu on outside click.
  useEffect(() => {
    if (!showOverflow) return;
    const handler = () => setShowOverflow(false);
    // Defer one frame so the opening click doesn't immediately close it.
    const t = setTimeout(() => window.addEventListener('click', handler), 0);
    return () => { clearTimeout(t); window.removeEventListener('click', handler); };
  }, [showOverflow]);

  const reactionGroups = (message.reactions || []).reduce((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = [];
    acc[r.emoji]!.push(r);
    return acc;
  }, {} as Record<string, Reaction[]>);

  const hasFiles = message.files && message.files.length > 0;

  async function saveEdit() {
    if (!onEdit) return;
    const trimmed = editValue.trim();
    if (!trimmed) return;
    if (trimmed === message.content) {
      setEditing(false);
      return;
    }
    setEditError(null);
    try {
      await onEdit(message.id, trimmed);
      setEditing(false);
    } catch (e: any) {
      setEditError(e?.message || 'Nie udało się zapisać');
    }
  }

  function cancelEdit() {
    setEditValue(message.content);
    setEditError(null);
    setEditing(false);
  }

  async function handleDelete() {
    if (!onDelete) return;
    if (!confirm('Usunąć tę wiadomość? Tej akcji nie można cofnąć.')) return;
    try {
      await onDelete(message.id);
    } catch (e: any) {
      alert(e?.message || 'Nie udało się usunąć wiadomości');
    }
  }

  function onEditKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void saveEdit(); }
  }

  return (
    <div
      className={`group flex ${isOwn ? 'justify-end' : 'justify-start'} ${isConsecutive ? 'mt-0.5' : 'mt-3'} message-enter`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowReactionPicker(false); }}
    >
      <div className={`flex gap-2 max-w-[75%] ${isOwn ? 'flex-row-reverse' : ''}`}>
        {!isOwn && !isConsecutive ? (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-xs shrink-0 mt-0.5">
            {message.user?.name?.charAt(0).toUpperCase() || '?'}
          </div>
        ) : !isOwn ? (
          <div className="w-8 shrink-0" />
        ) : null}

        <div className="min-w-0">
          {!isConsecutive && (
            <div className={`flex items-center gap-2 mb-1 ${isOwn ? 'justify-end' : ''}`}>
              {!isOwn && (
                <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{message.user?.name}</span>
              )}
              <span className="text-[10px] text-slate-400 dark:text-slate-500">
                {format(parseDbDate(message.created_at), 'HH:mm')}
              </span>
            </div>
          )}

          <div className="relative">
            <div
              className={`px-3.5 py-2 rounded-2xl text-sm break-words ${
                isOwn
                  ? 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-br-md'
                  : 'bg-white text-slate-800 border border-slate-100 shadow-sm rounded-bl-md dark:bg-slate-800 dark:text-slate-100 dark:border-slate-700'
              }`}
            >
              {message.reply_to && message.reply_message && (
                <div className={`mb-2 pb-2 border-b ${isOwn ? 'border-white/20' : 'border-slate-100 dark:border-slate-700'}`}>
                  <p className={`text-xs ${isOwn ? 'text-white/70' : 'text-slate-400 dark:text-slate-400'}`}>
                    W odpowiedzi na: {message.reply_message.content?.substring(0, 50)}...
                  </p>
                </div>
              )}

              {editing ? (
                <div>
                  <textarea
                    ref={editRef}
                    value={editValue}
                    onChange={e => {
                      setEditValue(e.target.value);
                      const ta = editRef.current;
                      if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; }
                    }}
                    onKeyDown={onEditKeyDown}
                    rows={1}
                    className={`w-full px-2 py-1 rounded-lg text-sm resize-none outline-none ${
                      isOwn
                        ? 'bg-white/15 text-white placeholder:text-white/60'
                        : 'bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700'
                    }`}
                  />
                  <div className="flex items-center gap-2 mt-1.5 text-[11px]">
                    <button
                      onClick={saveEdit}
                      className={`px-2 py-0.5 rounded-md font-medium ${
                        isOwn ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-indigo-500 hover:bg-indigo-600 text-white'
                      }`}
                    >
                      Zapisz
                    </button>
                    <button
                      onClick={cancelEdit}
                      className={`px-2 py-0.5 rounded-md ${
                        isOwn ? 'text-white/70 hover:text-white' : 'text-slate-500 dark:text-slate-300 hover:text-slate-700 dark:hover:text-white'
                      }`}
                    >
                      Anuluj
                    </button>
                    <span className={`opacity-70 ${isOwn ? 'text-white/70' : 'text-slate-400 dark:text-slate-500'}`}>
                      Enter — zapisz · Esc — anuluj
                    </span>
                  </div>
                  {editError && <p className={`text-[11px] mt-1 ${isOwn ? 'text-white/90' : 'text-red-500'}`}>{editError}</p>}
                </div>
              ) : (
                <>
                  <MessageContent content={message.content} isOwn={isOwn} />
                  {message.edited_at && (
                    <span className={`text-[10px] ${isOwn ? 'text-white/50' : 'text-slate-400 dark:text-slate-500'}`}> (edytowano)</span>
                  )}
                </>
              )}
            </div>

            {hasFiles && (
              <div className="mt-1.5 space-y-1">
                {message.files!.map(file => (
                  <div key={file.id}>
                    {file.mime_type?.startsWith('image/') ? (
                      <img
                        src={file.file_url}
                        alt={file.filename}
                        className="max-w-xs rounded-xl border border-slate-200 dark:border-slate-700 cursor-pointer hover:opacity-90 transition-opacity"
                      />
                    ) : (
                      <a
                        href={file.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                      >
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                        </svg>
                        <span className="truncate">{file.filename}</span>
                        {file.file_size && (
                          <span className="text-xs text-slate-400 shrink-0">{(file.file_size / 1024).toFixed(0)}KB</span>
                        )}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}

            {showActions && !editing && (
              <div className={`absolute -top-8 ${isOwn ? 'right-0' : 'left-0'} flex items-center gap-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg px-1 py-0.5 z-10`}>
                <button
                  onClick={() => setShowReactionPicker(!showReactionPicker)}
                  className="w-7 h-7 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center justify-center text-sm"
                  title="Reakcja"
                >
                  😊
                </button>
                <button
                  onClick={onThreadOpen}
                  className="w-7 h-7 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                  title="Odpowiedz w wątku"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                </button>
                {isOwn && (onEdit || onDelete) && (
                  <div className="relative">
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowOverflow(s => !s); }}
                      className="w-7 h-7 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                      title="Więcej"
                    >
                      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 11.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 17a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
                      </svg>
                    </button>
                    {showOverflow && (
                      <div className={`absolute top-full mt-1 ${isOwn ? 'right-0' : 'left-0'} w-32 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 z-20`}>
                        {onEdit && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setShowOverflow(false); setEditing(true); }}
                            className="w-full text-left px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700"
                          >
                            Edytuj
                          </button>
                        )}
                        {onDelete && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setShowOverflow(false); void handleDelete(); }}
                            className="w-full text-left px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                          >
                            Usuń
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {showReactionPicker && (
              <div className={`absolute -top-16 ${isOwn ? 'right-0' : 'left-0'} flex items-center gap-0.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl px-2 py-1.5 z-20`}>
                {quickReactions.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => { onReaction(message.id, emoji); setShowReactionPicker(false); }}
                    className="w-8 h-8 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center justify-center text-lg transition-transform hover:scale-110"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {Object.keys(reactionGroups).length > 0 && (
            <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : ''}`}>
              {Object.entries(reactionGroups).map(([emoji, reactions]) => {
                const hasReacted = reactions!.some(r => r.user_id === currentUserId);
                return (
                  <button
                    key={emoji}
                    onClick={() => onReaction(message.id, emoji)}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-colors ${
                      hasReacted
                        ? 'bg-indigo-50 dark:bg-indigo-500/20 border-indigo-200 dark:border-indigo-500/40 text-indigo-600 dark:text-indigo-300'
                        : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700'
                    }`}
                  >
                    <span>{emoji}</span>
                    <span className="font-medium">{reactions!.length}</span>
                  </button>
                );
              })}
            </div>
          )}

          {message.reply_count && Number(message.reply_count) > 0 ? (
            <button
              onClick={onThreadOpen}
              className={`flex items-center gap-1 mt-1 text-xs text-indigo-500 dark:text-indigo-300 hover:text-indigo-600 dark:hover:text-indigo-200 font-medium ${isOwn ? 'justify-end' : ''}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              {message.reply_count} {Number(message.reply_count) === 1 ? 'odpowiedź' : 'odpowiedzi'}
            </button>
          ) : null}

          {isOwn && isConsecutive && (
            <div className="flex justify-end mt-0.5">
              <span className="text-[10px] text-slate-400 dark:text-slate-500">
                {format(parseDbDate(message.created_at), 'HH:mm')}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
