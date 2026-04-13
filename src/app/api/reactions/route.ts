import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';
import { nanoid } from 'nanoid';

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { messageId, emoji } = await req.json();

    if (!messageId || !emoji) {
      return NextResponse.json({ error: 'messageId and emoji required' }, { status: 400 });
    }

    // Check if already reacted
    const existing = await db.execute({
      sql: 'SELECT id FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      args: [messageId, user.id, emoji],
    });

    const msg = await db.execute({
      sql: 'SELECT channel_id FROM chat_messages WHERE id = ?',
      args: [messageId],
    });

    if (msg.rows.length === 0) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    const channelId = msg.rows[0].channel_id;

    if (existing.rows.length > 0) {
      // Remove reaction (toggle)
      await db.execute({
        sql: 'DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        args: [messageId, user.id, emoji],
      });

      await pusherServer.trigger(`presence-channel-${channelId}`, 'reaction-removed', {
        messageId, userId: user.id, emoji,
      });

      return NextResponse.json({ action: 'removed' });
    } else {
      // Add reaction
      await db.execute({
        sql: 'INSERT INTO chat_reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)',
        args: [nanoid(), messageId, user.id, emoji],
      });

      await pusherServer.trigger(`presence-channel-${channelId}`, 'reaction-added', {
        messageId, userId: user.id, userName: user.name, emoji,
      });

      return NextResponse.json({ action: 'added' }, { status: 201 });
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
