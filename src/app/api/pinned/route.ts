import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';
import { nanoid } from 'nanoid';

async function ensureMember(userId: string, channelId: string): Promise<boolean> {
  const r = await db.execute({
    sql: 'SELECT 1 FROM chat_members WHERE channel_id = ? AND user_id = ? LIMIT 1',
    args: [channelId, userId],
  });
  return r.rows.length > 0;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const channelId = new URL(req.url).searchParams.get('channelId');
    if (!channelId) return NextResponse.json({ error: 'channelId required' }, { status: 400 });
    if (!(await ensureMember(user.id, channelId))) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 });
    }

    const result = await db.execute({
      sql: `SELECT p.id, p.message_id, p.pinned_by, p.pinned_at,
                   m.content, m.created_at as message_created_at, m.user_id as author_id,
                   u.username as author_name,
                   pb.username as pinned_by_name
            FROM chat_pinned_messages p
            JOIN chat_messages m ON m.id = p.message_id AND m.deleted_at IS NULL
            JOIN users u ON u.id = m.user_id
            LEFT JOIN users pb ON pb.id = p.pinned_by
            WHERE p.channel_id = ?
            ORDER BY p.pinned_at DESC`,
      args: [channelId],
    });

    const pinned = result.rows.map(row => ({
      id: row.id,
      message_id: row.message_id,
      pinned_by: row.pinned_by,
      pinned_by_name: row.pinned_by_name,
      pinned_at: row.pinned_at,
      message: {
        id: row.message_id,
        content: row.content,
        created_at: row.message_created_at,
        user_id: row.author_id,
        user: { id: row.author_id, name: row.author_name },
      },
    }));
    return NextResponse.json({ pinned });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Get pinned error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { messageId } = await req.json();
    if (!messageId) return NextResponse.json({ error: 'messageId required' }, { status: 400 });

    const msg = await db.execute({
      sql: 'SELECT channel_id FROM chat_messages WHERE id = ? AND deleted_at IS NULL',
      args: [messageId],
    });
    if (msg.rows.length === 0) return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    const channelId = msg.rows[0].channel_id as string;

    if (!(await ensureMember(user.id, channelId))) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 });
    }

    await db.execute({
      sql: 'INSERT OR IGNORE INTO chat_pinned_messages (id, channel_id, message_id, pinned_by) VALUES (?, ?, ?, ?)',
      args: [nanoid(), channelId, messageId, user.id],
    });

    pusherServer.trigger(`presence-channel-${channelId}`, 'pinned-changed', { messageId })
      .catch(e => console.error('pin broadcast failed', e));

    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Pin error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const messageId = searchParams.get('messageId');
    if (!messageId) return NextResponse.json({ error: 'messageId required' }, { status: 400 });

    const row = await db.execute({
      sql: 'SELECT channel_id FROM chat_pinned_messages WHERE message_id = ? LIMIT 1',
      args: [messageId],
    });
    const channelId = row.rows[0]?.channel_id as string | undefined;
    if (channelId && !(await ensureMember(user.id, channelId))) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 });
    }

    await db.execute({
      sql: 'DELETE FROM chat_pinned_messages WHERE message_id = ?',
      args: [messageId],
    });

    if (channelId) {
      pusherServer.trigger(`presence-channel-${channelId}`, 'pinned-changed', { messageId })
        .catch(e => console.error('unpin broadcast failed', e));
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
