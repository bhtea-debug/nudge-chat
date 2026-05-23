'use client';

import { useState, useRef, useEffect, useCallback, KeyboardEvent, ChangeEvent } from 'react';
import dynamic from 'next/dynamic';
import { init as emojiInit, SearchIndex } from 'emoji-mart';
import emojiData from '@emoji-mart/data';
import { parseSlash, SLASH_HELP } from '@/lib/slash';

const EmojiPicker = dynamic(() => import('@emoji-mart/react'), { ssr: false });

interface MessageInputProps {
  onSend: (content: string, replyTo?: string) => Promise<void> | void;
  sending: boolean;
  channelId: string;
  replyTo?: { id: string; content: string; userName: string } | null;
  onCancelReply?: () => void;
  onTyping?: () => void;
}

interface MentionMatch {
  start: number; // index in content where '@' sits
  query: string;
}

interface EmojiMatch {
  start: number; // index in content where ':' sits
  query: string;
}

interface UserSuggestion { id: string; name: string; email?: string }
interface EmojiSuggestion { id: string; native: string; name?: string }

// One-time init of the emoji search index. Cheap to call multiple times.
let emojiInited = false;
function ensureEmojiInit() {
  if (emojiInited) return;
  emojiInit({ data: emojiData });
  emojiInited = true;
}

// Look backward from cursor for an active autocomplete trigger (@ or :).
// Returns the trigger char + query text + position, or null if there's no
// active trigger (e.g. the user typed a space after `@foo`).
function detectTrigger(value: string, cursor: number): { kind: '@' | ':'; start: number; query: string } | null {
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === ' ' || ch === '\n' || ch === '\t') return null;
    if (ch === '@' || ch === ':') {
      // Require trigger to be at start of input or after whitespace, to avoid
      // matching emails (`user@host`) or markdown image syntax.
      if (i > 0 && !/\s/.test(value[i - 1]!)) return null;
      const query = value.slice(i + 1, cursor);
      if (/[^\w-]/.test(query)) return null; // only word-ish chars after trigger
      return { kind: ch, start: i, query };
    }
  }
  return null;
}

export default function MessageInput({ onSend, sending, channelId, replyTo, onCancelReply, onTyping }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [mention, setMention] = useState<MentionMatch | null>(null);
  const [mentionResults, setMentionResults] = useState<UserSuggestion[]>([]);
  const [emoji, setEmoji] = useState<EmojiMatch | null>(null);
  const [emojiResults, setEmojiResults] = useState<EmojiSuggestion[]>([]);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  useEffect(() => { ensureEmojiInit(); }, []);

  // Adjust active autocomplete state whenever content/cursor changes.
  const refreshTriggers = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const cursor = el.selectionStart ?? content.length;
    const t = detectTrigger(content, cursor);
    if (!t) {
      setMention(null);
      setEmoji(null);
      return;
    }
    if (t.kind === '@') {
      setEmoji(null);
      setMention({ start: t.start, query: t.query });
    } else {
      setMention(null);
      setEmoji({ start: t.start, query: t.query });
    }
    setActiveSuggestion(0);
  }, [content]);

  // Fetch user suggestions for active @ mention.
  useEffect(() => {
    if (!mention) { setMentionResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?type=people&q=${encodeURIComponent(mention.query)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMentionResults((data.results?.people || []).slice(0, 6));
      } catch { /* best-effort */ }
    }, 80);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mention]);

  // Emoji suggestions are local (SearchIndex). Limit to 6 to fit the popover.
  useEffect(() => {
    if (!emoji || emoji.query.length < 1) { setEmojiResults([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const results = await SearchIndex.search(emoji.query, { maxResults: 6, caller: 'message-input' } as any);
        if (cancelled || !results) return;
        setEmojiResults(
          (results as any[]).map((r: any) => ({
            id: r.id,
            native: r.skins?.[0]?.native || '',
            name: r.name,
          })).filter((r: EmojiSuggestion) => !!r.native).slice(0, 6),
        );
      } catch { /* swallow */ }
    })();
    return () => { cancelled = true; };
  }, [emoji]);

  function resetHeight() {
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function autoGrow() {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setContent(e.target.value);
    autoGrow();
    onTyping?.();
    // Defer to next tick so selectionStart reflects the new value.
    requestAnimationFrame(refreshTriggers);
  }

  function insertAtCursor(textToInsert: string, replaceFrom: number, replaceTo: number) {
    const before = content.slice(0, replaceFrom);
    const after = content.slice(replaceTo);
    const next = `${before}${textToInsert}${after}`;
    setContent(next);
    setMention(null);
    setEmoji(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      const pos = (before + textToInsert).length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
      autoGrow();
    });
  }

  function applyMention(user: UserSuggestion) {
    if (!mention) return;
    const cursor = textareaRef.current?.selectionStart ?? content.length;
    insertAtCursor(`@[${user.name}](${user.id}) `, mention.start, cursor);
  }

  function applyEmoji(em: EmojiSuggestion) {
    if (!emoji) return;
    const cursor = textareaRef.current?.selectionStart ?? content.length;
    insertAtCursor(`${em.native} `, emoji.start, cursor);
  }

  function applyPickerEmoji(em: any) {
    const native = em?.native;
    if (!native) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? content.length;
    insertAtCursor(native, cursor, cursor);
    setShowPicker(false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const suggestions: any[] = mention ? mentionResults : emoji ? emojiResults : [];
    const autocompleteOpen = (mention && mentionResults.length > 0) || (emoji && emojiResults.length > 0);

    if (autocompleteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveSuggestion(i => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveSuggestion(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        setEmoji(null);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const pick = suggestions[activeSuggestion];
        if (mention && pick) applyMention(pick as UserSuggestion);
        else if (emoji && pick) applyEmoji(pick as EmojiSuggestion);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    if (!content.trim() || sending) return;
    const toSend = content;
    const replyId = replyTo?.id;
    setContent('');
    setSendError(null);
    setMention(null);
    setEmoji(null);
    onCancelReply?.();
    resetHeight();

    // Slash commands intercept the send.
    const intent = parseSlash(toSend.trim());
    if (intent) {
      try {
        if (intent.kind === 'unknown') {
          throw new Error(intent.hint);
        }
        if (intent.kind === 'poll') {
          const res = await fetch('/api/polls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              channelId,
              question: intent.question,
              options: intent.options,
              multipleChoice: intent.multiple,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Nie udało się stworzyć ankiety');
          }
          return;
        }
        if (intent.kind === 'remind') {
          const res = await fetch('/api/reminders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              remindAt: intent.remindAt.toISOString(),
              text: intent.text,
              channelId,
            }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'Nie udało się ustawić przypomnienia');
          }
          return;
        }
        // intent.kind === 'message' — transformed content (e.g. /me, /shrug)
        await onSend(intent.content, replyId);
        return;
      } catch (e: any) {
        setContent(toSend);
        setSendError(e?.message || 'Nie udało się wykonać polecenia');
        return;
      }
    }

    try {
      await onSend(toSend, replyId);
    } catch (e: any) {
      setContent(toSend);
      setSendError(e?.message || 'Nie udało się wysłać wiadomości');
    }
  }

  // ---- File upload (shared by button, paste, drag-drop) ----

  async function uploadAndSend(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/files/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Upload nieudany (HTTP ${res.status})`);
      }
      const data = await res.json();
      const label = (data.mimeType || '').startsWith('image/')
        ? `[Obraz: ${data.filename}](${data.url})`
        : `[Plik: ${data.filename}](${data.url})`;
      await onSend(label, replyTo?.id);
      onCancelReply?.();
    } catch (e: any) {
      setSendError(e?.message || 'Upload nieudany');
    } finally {
      setUploading(false);
    }
  }

  function handleFileButton(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadAndSend(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          void uploadAndSend(f);
          return;
        }
      }
    }
  }

  // Drag counter dance: dragenter/leave fire for every child element, so we
  // need a counter to avoid the overlay flickering while moving the cursor.
  function handleDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragCounterRef.current++;
    setIsDragging(true);
  }
  function handleDragLeave() {
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragging(false);
  }
  function handleDragOver(e: React.DragEvent) {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void uploadAndSend(file);
  }

  return (
    <div
      className="relative border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay absolute inset-0 z-30 flex items-center justify-center bg-indigo-500/10 border-2 border-dashed border-indigo-400 rounded-lg m-2 pointer-events-none">
          <p className="text-sm font-medium text-indigo-600 dark:text-indigo-300">Upuść plik aby wysłać</p>
        </div>
      )}

      {sendError && (
        <div className="flex items-center justify-between bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-300 text-xs rounded-xl px-3 py-2 mb-2">
          <span className="truncate">⚠ {sendError}</span>
          <button onClick={() => setSendError(null)} className="ml-2 shrink-0 opacity-70 hover:opacity-100">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {replyTo && (
        <div className="flex items-center justify-between bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-100 dark:border-indigo-500/30 rounded-xl px-3 py-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-0.5 h-8 bg-indigo-400 rounded-full shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-indigo-600 dark:text-indigo-300">Odpowiedź do {replyTo.userName}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{replyTo.content}</p>
            </div>
          </div>
          <button onClick={onCancelReply} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0 ml-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* @mention autocomplete dropdown */}
      {mention && mentionResults.length > 0 && (
        <div className="absolute bottom-full mb-1 left-4 right-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden z-20">
          {mentionResults.map((u, idx) => (
            <button
              key={u.id}
              onClick={() => applyMention(u)}
              onMouseEnter={() => setActiveSuggestion(idx)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-left ${idx === activeSuggestion ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
            >
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-xs font-semibold">
                {u.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{u.name}</p>
                {u.email && <p className="text-xs text-slate-400 truncate">{u.email}</p>}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* slash command help — only when input starts with `/` and no space yet */}
      {!mention && !emoji && content.startsWith('/') && !content.includes(' ') && (
        <div className="absolute bottom-full mb-1 left-4 right-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden z-20">
          {SLASH_HELP.filter(s => s.command.startsWith(content.toLowerCase())).slice(0, 6).map(s => (
            <button
              key={s.command}
              onClick={() => { setContent(s.syntax.replace(/^\/[a-z]+/, s.command) + ' '); requestAnimationFrame(() => textareaRef.current?.focus()); }}
              className="w-full flex items-start gap-3 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50"
            >
              <code className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-300 mt-0.5 shrink-0">{s.command}</code>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-slate-700 dark:text-slate-200">{s.description}</p>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{s.example}</p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* :emoji autocomplete dropdown */}
      {emoji && emojiResults.length > 0 && (
        <div className="absolute bottom-full mb-1 left-4 right-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden z-20">
          {emojiResults.map((em, idx) => (
            <button
              key={em.id}
              onClick={() => applyEmoji(em)}
              onMouseEnter={() => setActiveSuggestion(idx)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${idx === activeSuggestion ? 'bg-indigo-50 dark:bg-indigo-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}
            >
              <span className="text-lg">{em.native}</span>
              <span className="text-xs text-slate-500 dark:text-slate-300">:{em.id}:</span>
            </button>
          ))}
        </div>
      )}

      {/* Emoji picker popover */}
      {showPicker && (
        <div className="absolute bottom-full mb-2 right-4 z-30">
          <EmojiPicker
            data={emojiData}
            onEmojiSelect={applyPickerEmoji}
            theme="auto"
            previewPosition="none"
            skinTonePosition="none"
            navPosition="bottom"
          />
        </div>
      )}

      <div className="flex items-end gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          title="Załącz plik"
          className="w-9 h-9 rounded-xl text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 flex items-center justify-center transition-colors shrink-0 disabled:opacity-50"
        >
          {uploading ? (
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
            </svg>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileButton}
          accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
        />

        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={refreshTriggers}
            onClick={refreshTriggers}
            onPaste={handlePaste}
            placeholder="Napisz wiadomość... (Enter wysyła, Shift+Enter nowa linia)"
            rows={1}
            className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent placeholder:text-slate-400 dark:placeholder:text-slate-500 max-h-[160px]"
          />
        </div>

        <button
          onClick={() => setShowPicker(s => !s)}
          title="Emoji"
          className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors shrink-0 ${
            showPicker
              ? 'bg-indigo-50 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300'
              : 'text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200'
          }`}
        >
          😊
        </button>

        <button
          onClick={handleSend}
          disabled={!content.trim() || sending}
          title="Wyślij (Enter)"
          className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white flex items-center justify-center hover:from-indigo-600 hover:to-violet-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0 shadow-sm shadow-indigo-200 dark:shadow-none"
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
