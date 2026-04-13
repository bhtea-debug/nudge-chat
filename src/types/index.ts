export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url?: string;
}

export interface Channel {
  id: string;
  name: string;
  slug: string;
  description?: string;
  type: 'group' | 'dm';
  icon?: string;
  created_by: string;
  is_archived: number;
  created_at: string;
  updated_at: string;
  // Computed from SQL
  last_message?: Message;
  last_message_content?: string;
  last_message_at?: string;
  last_message_user_id?: string;
  unread_count?: number;
  members?: ChannelMember[];
  other_user?: User; // For DMs
}

export interface ChannelMember {
  id: string;
  channel_id: string;
  user_id: string;
  role: 'admin' | 'member';
  last_read_at?: string;
  joined_at: string;
  user?: User;
}

export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  type: 'text' | 'voice' | 'file' | 'system';
  reply_to?: string;
  edited_at?: string;
  deleted_at?: string;
  created_at: string;
  // Computed
  user?: User;
  reactions?: Reaction[];
  files?: FileAttachment[];
  reply_message?: Message;
  reply_count?: number;
  read_by?: string[];
}

export interface Reaction {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: string;
  user?: User;
}

export interface FileAttachment {
  id: string;
  message_id: string;
  user_id: string;
  filename: string;
  file_url: string;
  file_size?: number;
  mime_type?: string;
  created_at: string;
}

export interface UserStatus {
  user_id: string;
  status: 'online' | 'offline' | 'away' | 'dnd';
  status_text?: string;
  status_emoji?: string;
  last_seen_at: string;
}

export interface ChannelSettings {
  id: string;
  user_id: string;
  channel_id: string;
  is_pinned: number;
  is_muted: number;
  is_archived: number;
}

export interface NewsPost {
  id: string;
  author_id: string;
  title: string;
  content: string;
  image_url?: string;
  pinned: number;
  likes_count: number;
  comments_count: number;
  created_at: string;
  updated_at: string;
  author?: User;
  liked_by_me?: boolean;
}

export interface NewsComment {
  id: string;
  news_id: string;
  user_id: string;
  content: string;
  created_at: string;
  user?: User;
}

export interface Contact {
  id: string;
  user_id: string;
  display_name: string;
  position?: string;
  department?: string;
  phone?: string;
  avatar_url?: string;
  created_at: string;
  status?: UserStatus;
}
