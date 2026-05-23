import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const onlyUnread = new URL(req.url).searchParams.get('unread') === '1';

    const where = onlyUnread
      ? 'WHERE me.user_id = ? AND me.read_at IS NULL AND m.deleted_at IS NULL'
      : 'WHERE me.user_id = ? AND m.deleted_at IS NULL';

    const result = await db.execute({
      sql: `SELECT me.id, me.message_id, me.read_at, me.created_at as mention_created_at,
                   m.content, m.created_at as message_created_at, m.user_id as author_id, m.channel_id,
                   u.username as author_name,
                   c.name as channel_name, c.slug as channel_slug, c.type as channel_type
            FROM chat_mentions me
            JOIN chat_messages m ON m.id = me.message_id
            JOIN chat_channels c ON c.id = m.channel_id
            JOIN users u ON u.id = m.user_id
            ${where}
            ORDER BY me.created_at DESC
            LIMIT 100`,
      args: [user.id],
    });

    const items = await Promise.all(result.rows.map(async (row) => {
      let otherUserId: string | undefined;
      if (row.channel_type === 'dm') {
        const other = await db.execute({
          sql: 'SELECT user_id FROM chat_members WHERE channel_id = ? AND user_id != ? LIMIT 1',
          args: [row.channel_id, user.id],
        });
        otherUserId = other.rows[0]?.user_id as string | undefined;
      }
      return {
        id: row.id,
        message_id: row.message_id,
        read_at: row.read_at,
        created_at: row.mention_created_at,
        message: {
          id: row.message_id,
          content: row.content,
          created_at: row.message_created_at,
          user_id: row.author_id,
          user: { id: row.author_id, name: row.author_name },
          channel: {
            id: row.channel_id,
            name: row.channel_name,
            slug: row.channel_slug,
            type: row.channel_type,
            other_user_id: otherUserId,
          },
        },
      };
    }));

    const unreadCount = onlyUnread
      ? items.length
      : await db.execute({
          sql: 'SELECT COUNT(*) as c FROM chat_mentions WHERE user_id = ? AND read_at IS NULL',
          args: [user.id],
        }).then(r => Number(r.rows[0]?.c || 0));

    return NextResponse.json({ mentions: items, unread_count: unreadCount });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Get mentions error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const body = await req.json().catch(() => ({}));
    const messageId = body.messageId as string | undefined;

    if (messageId) {
      await db.execute({
        sql: 'UPDATE chat_mentions SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND message_id = ? AND read_at IS NULL',
        args: [user.id, messageId],
      });
    } else {
      // Mark all as read.
      await db.execute({
        sql: 'UPDATE chat_mentions SET read_at = CURRENT_TIMESTAMP WHERE user_id = ? AND read_at IS NULL',
        args: [user.id],
      });
    }
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
