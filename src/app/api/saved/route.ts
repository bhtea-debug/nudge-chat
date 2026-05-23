import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { nanoid } from 'nanoid';

export async function GET() {
  try {
    const user = await requireUser();
    // Join through to message + channel so the saved view can render context
    // (sender, channel name, timestamp) without an extra round trip per item.
    const result = await db.execute({
      sql: `SELECT s.id as save_id, s.note, s.created_at as saved_at,
                   m.id as message_id, m.content, m.created_at as message_created_at,
                   m.channel_id, m.user_id as author_id,
                   u.username as author_name,
                   c.name as channel_name, c.slug as channel_slug, c.type as channel_type
            FROM chat_saved_messages s
            JOIN chat_messages m ON m.id = s.message_id AND m.deleted_at IS NULL
            JOIN chat_channels c ON c.id = m.channel_id
            JOIN users u ON u.id = m.user_id
            JOIN chat_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
            WHERE s.user_id = ?
            ORDER BY s.created_at DESC
            LIMIT 100`,
      args: [user.id, user.id],
    });

    // For DM channels we need the other_user so a link can be formed.
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
        id: row.save_id,
        message_id: row.message_id,
        note: row.note,
        created_at: row.saved_at,
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

    return NextResponse.json({ saved: items });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Get saved error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { messageId, note } = await req.json();
    if (!messageId) return NextResponse.json({ error: 'messageId required' }, { status: 400 });

    // Verify user can see this message (membership check).
    const membership = await db.execute({
      sql: `SELECT 1 FROM chat_messages m
            JOIN chat_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
            WHERE m.id = ? LIMIT 1`,
      args: [user.id, messageId],
    });
    if (membership.rows.length === 0) {
      return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
    }

    await db.execute({
      sql: 'INSERT OR IGNORE INTO chat_saved_messages (id, user_id, message_id, note) VALUES (?, ?, ?, ?)',
      args: [nanoid(), user.id, messageId, note || null],
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Save message error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const messageId = searchParams.get('messageId');
    if (!messageId) return NextResponse.json({ error: 'messageId required' }, { status: 400 });

    await db.execute({
      sql: 'DELETE FROM chat_saved_messages WHERE user_id = ? AND message_id = ?',
      args: [user.id, messageId],
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
