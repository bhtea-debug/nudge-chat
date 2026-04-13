'use client';

import { useState, useRef, KeyboardEvent } from 'react';

interface MessageInputProps {
  onSend: (content: string, replyTo?: string) => void;
  sending: boolean;
  channelId: string;
  replyTo?: { id: string; content: string; userName: string } | null;
  onCancelReply?: () => void;
}

export default function MessageInput({ onSend, sending, channelId, replyTo, onCancelReply }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    if (!content.trim() || sending) return;
    onSend(content, replyTo?.id);
    setContent('');
    onCancelReply?.();

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleInput() {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        // Insert file link in message
        if (data.mimeType?.startsWith('image/')) {
          onSend(`[Obraz: ${data.filename}](${data.url})`, replyTo?.id);
        } else {
          onSend(`[Plik: ${data.filename}](${data.url})`, replyTo?.id);
        }
        onCancelReply?.();
      }
    } catch (err) {
      console.error('Upload failed:', err);
    }

    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-3">
      {/* Reply indicator */}
      {replyTo && (
        <div className="flex items-center justify-between bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-0.5 h-8 bg-indigo-400 rounded-full shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-indigo-600">Odpowiedź do {replyTo.userName}</p>
              <p className="text-xs text-slate-500 truncate">{replyTo.content}</p>
            </div>
          </div>
          <button onClick={onCancelReply} className="text-slate-400 hover:text-slate-600 shrink-0 ml-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* Attachment button */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-9 h-9 rounded-xl text-slate-400 hover:bg-slate-50 hover:text-slate-600 flex items-center justify-center transition-colors shrink-0"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileUpload}
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
        />

        {/* Text input */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            onInput={handleInput}
            placeholder="Napisz wiadomość..."
            rows={1}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent placeholder:text-slate-400 max-h-[120px]"
          />
        </div>

        {/* Voice message button */}
        <button
          onClick={() => setIsRecording(!isRecording)}
          className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors shrink-0 ${
            isRecording
              ? 'bg-red-500 text-white animate-pulse'
              : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'
          }`}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
          </svg>
        </button>

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!content.trim() || sending}
          className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center hover:from-indigo-600 hover:to-violet-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0 shadow-sm shadow-indigo-200"
        >
          {sending ? (
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
