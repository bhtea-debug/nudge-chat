export const SCHEMA = `
-- Kanały
CREATE TABLE IF NOT EXISTS chat_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  type TEXT DEFAULT 'group',
  icon TEXT,
  created_by TEXT NOT NULL,
  is_archived INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Członkowie kanałów
CREATE TABLE IF NOT EXISTS chat_members (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  last_read_at DATETIME,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id, user_id)
);

-- Wiadomości
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT DEFAULT 'text',
  reply_to TEXT,
  edited_at DATETIME,
  deleted_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Reakcje
CREATE TABLE IF NOT EXISTS chat_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, user_id, emoji)
);

-- Załączniki/pliki
CREATE TABLE IF NOT EXISTS chat_files (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Wzmianki (@mentions) — read_at NULL oznacza nieprzeczytaną wzmiankę
CREATE TABLE IF NOT EXISTS chat_mentions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, user_id)
);

-- Status użytkownika
CREATE TABLE IF NOT EXISTS chat_user_status (
  user_id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'offline',
  status_text TEXT,
  status_emoji TEXT,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Read receipts
CREATE TABLE IF NOT EXISTS chat_read_receipts (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, user_id)
);

-- Ustawienia kanału per user
CREATE TABLE IF NOT EXISTS chat_channel_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  is_pinned INTEGER DEFAULT 0,
  is_muted INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  UNIQUE(user_id, channel_id)
);

-- Kursory skanowania
CREATE TABLE IF NOT EXISTS chat_scan_cursors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_scanned_message_id TEXT,
  last_scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, channel_id)
);

-- Kontakty firmowe
CREATE TABLE IF NOT EXISTS company_contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  position TEXT,
  department TEXT,
  phone TEXT,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Aktualności
CREATE TABLE IF NOT EXISTS company_news (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  image_url TEXT,
  pinned INTEGER DEFAULT 0,
  likes_count INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Komentarze do aktualności
CREATE TABLE IF NOT EXISTS news_comments (
  id TEXT PRIMARY KEY,
  news_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Lajki aktualności
CREATE TABLE IF NOT EXISTS news_likes (
  id TEXT PRIMARY KEY,
  news_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(news_id, user_id)
);

-- Zapisane wiadomości (bookmarks per user)
CREATE TABLE IF NOT EXISTS chat_saved_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, message_id)
);

-- Przypięte wiadomości w kanale
CREATE TABLE IF NOT EXISTS chat_pinned_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pinned_by TEXT NOT NULL,
  pinned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel_id, message_id)
);

-- Ankiety (Poll messages — powiązane z message przez message_id)
CREATE TABLE IF NOT EXISTS chat_polls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,           -- JSON array of strings
  multiple_choice INTEGER DEFAULT 0,
  closes_at DATETIME,
  created_by TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_poll_votes (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  option_idx INTEGER NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(poll_id, user_id, option_idx)
);

-- Przypomnienia (single-shot, Vercel Cron sweeps and fires)
CREATE TABLE IF NOT EXISTS chat_reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  remind_at DATETIME NOT NULL,
  text TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  delivered_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Kategorie/foldery w sidebarze (per user)
CREATE TABLE IF NOT EXISTS chat_channel_categories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Przypisanie kanału do kategorii (per user)
CREATE TABLE IF NOT EXISTS chat_channel_category_map (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  UNIQUE(user_id, channel_id)
);

-- Indeksy
CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_messages_reply ON chat_messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_chat_members_channel ON chat_members(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_reactions_message ON chat_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_files_message ON chat_files(message_id);
CREATE INDEX IF NOT EXISTS idx_chat_mentions_user ON chat_mentions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_read_receipts_message ON chat_read_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_news_comments_news ON news_comments(news_id);
CREATE INDEX IF NOT EXISTS idx_news_likes_news ON news_likes(news_id);
CREATE INDEX IF NOT EXISTS idx_chat_saved_user ON chat_saved_messages(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_pinned_channel ON chat_pinned_messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_polls_channel ON chat_polls(channel_id);
CREATE INDEX IF NOT EXISTS idx_chat_poll_votes_poll ON chat_poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_chat_reminders_pending ON chat_reminders(remind_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_mentions_unread ON chat_mentions(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_category_map_user ON chat_channel_category_map(user_id);

-- Migrations for existing deployments. SQLite has no "ADD COLUMN IF NOT EXISTS",
-- so migrate.ts swallows the "duplicate column" error on re-runs.
ALTER TABLE chat_mentions ADD COLUMN read_at DATETIME;
`;

