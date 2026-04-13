'use client';

import { useState } from 'react';
import { format } from 'date-fns';
import type { Message, Reaction } from '@/types';

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  isConsecutive: boolean;
  onReaction: (messageId: string, emoji: string) => void;
  onThreadOpen: () => void;
  currentUserId: string;
}

const quickReactions = ['👍', '❤️', '😂', '🎉', '👀', '🔥'];

export default function MessageBubble({
  message,
  isOwn,
  isConsecutive,
  onReaction,
  onThreadOpen,
  currentUserId,
}: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);

  // Group reactions by emoji
  const reactionGroups = (message.reactions || []).reduce((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = [];
    acc[r.emoji]!.push(r);
    return acc;
  }, {} as Record<string, Reaction[]>);

  const hasFiles = message.files && message.files.length > 0;

  return (
    <div
      className={`group flex ${isOwn ? 'justify-end' : 'justify-start'} ${isConsecutive ? 'mt-0.5' : 'mt-3'} message-enter`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowReactionPicker(false); }}
    >
      <div className={`flex gap-2 max-w-[75%] ${isOwn ? 'flex-row-reverse' : ''}`}>
        {/* Avatar (only for non-consecutive, non-own) */}
        {!isOwn && !isConsecutive ? (
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white font-semibold text-xs shrink-0 mt-0.5">
            {message.user?.name?.charAt(0).toUpperCase() || '?'}
          </div>
        ) : !isOwn ? (
          <div className="w-8 shrink-0" />
        ) : null}

        <div className="min-w-0">
          {/* Name + time (non-consecutive) */}
          {!isConsecutive && (
            <div className={`flex items-center gap-2 mb-1 ${isOwn ? 'justify-end' : ''}`}>
              {!isOwn && (
                <span className="text-xs font-semibold text-slate-700">{message.user?.name}</span>
              )}
              <span className="text-[10px] text-slate-400">
                {format(new Date(message.created_at), 'HH:mm')}
              </span>
            </div>
          )}

          {/* Bubble */}
          <div className="relative">
            <div
              className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed break-words ${
                isOwn
                  ? 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white rounded-br-md'
                  : 'bg-white text-slate-800 border border-slate-100 shadow-sm rounded-bl-md'
              }`}
            >
              {/* Reply indicator */}
              {message.reply_to && message.reply_message && (
                <div className={`mb-2 pb-2 border-b ${isOwn ? 'border-white/20' : 'border-slate-100'}`}>
                  <p className={`text-xs ${isOwn ? 'text-white/70' : 'text-slate-400'}`}>
                    W odpowiedzi na: {message.reply_message.content?.substring(0, 50)}...
                  </p>
                </div>
              )}

              {/* Content */}
              <p className="whitespace-pre-wrap">{message.content}</p>

              {/* Edited indicator */}
              {message.edited_at && (
                <span className={`text-[10px] ${isOwn ? 'text-white/50' : 'text-slate-300'}`}> (edytowano)</span>
              )}
            </div>

            {/* Files */}
            {hasFiles && (
              <div className="mt-1.5 space-y-1">
                {message.files!.map(file => (
                  <div key={file.id}>
                    {file.mime_type?.startsWith('image/') ? (
                      <img
                        src={file.file_url}
                        alt={file.filename}
                        className="max-w-xs rounded-xl border border-slate-200 cursor-pointer hover:opacity-90 transition-opacity"
                      />
                    ) : (
                      <a
                        href={file.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                        </svg>
                        <span className="truncate">{file.filename}</span>
                        {file.file_size && (
                          <span className="text-xs text-slate-400 shrink-0">
                            {(file.file_size / 1024).toFixed(0)}KB
                          </span>
                        )}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons (on hover) */}
            {showActions && (
              <div className={`absolute -top-8 ${isOwn ? 'right-0' : 'left-0'} flex items-center gap-0.5 bg-white border border-slate-200 rounded-lg shadow-lg px-1 py-0.5 z-10`}>
                <button
                  onClick={() => setShowReactionPicker(!showReactionPicker)}
                  className="w-7 h-7 rounded-md hover:bg-slate-50 flex items-center justify-center text-slate-400 hover:text-slate-600 text-sm"
                  title="Reakcja"
                >
                  😊
                </button>
                <button
                  onClick={onThreadOpen}
                  className="w-7 h-7 rounded-md hover:bg-slate-50 flex items-center justify-center text-slate-400 hover:text-slate-600"
                  title="Odpowiedz w wątku"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                </button>
              </div>
            )}

            {/* Quick reaction picker */}
            {showReactionPicker && (
              <div className={`absolute -top-16 ${isOwn ? 'right-0' : 'left-0'} flex items-center gap-0.5 bg-white border border-slate-200 rounded-xl shadow-xl px-2 py-1.5 z-20`}>
                {quickReactions.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => { onReaction(message.id, emoji); setShowReactionPicker(false); }}
                    className="w-8 h-8 rounded-lg hover:bg-slate-100 flex items-center justify-center text-lg transition-transform hover:scale-110"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Reactions */}
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
                        ? 'bg-indigo-50 border-indigo-200 text-indigo-600'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span>{emoji}</span>
                    <span className="font-medium">{reactions!.length}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Thread indicator */}
          {message.reply_count && Number(message.reply_count) > 0 ? (
            <button
              onClick={onThreadOpen}
              className={`flex items-center gap-1 mt-1 text-xs text-indigo-500 hover:text-indigo-600 font-medium ${isOwn ? 'justify-end' : ''}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              {message.reply_count} {Number(message.reply_count) === 1 ? 'odpowiedź' : 'odpowiedzi'}
            </button>
          ) : null}

          {/* Read receipts (own messages) */}
          {isOwn && isConsecutive && (
            <div className="flex justify-end mt-0.5">
              <span className="text-[10px] text-slate-400">
                {format(new Date(message.created_at), 'HH:mm')}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
