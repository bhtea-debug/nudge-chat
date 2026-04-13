import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';
import { nanoid } from 'nanoid';

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const channelId = searchParams.get('channelId');
    const before = searchParams.get('before');
    const replyTo = searchParams.get('replyTo');
    const limit = parseInt(searchParams.get('limit') || '50');

    if (!channelId) {
      return NextResponse.json({ error: 'channelId required' }, { status: 400 });
    }

    // Verify membership
    const membership = await db.execute({
      sql: 'SELECT id FROM chat_members WHERE channel_id = ? AND user_id = ?',
      args: [channelId, user.id],
    });
    if (membership.rows.length === 0) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 });
    }

    let sql = `
      SELECT m.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar
      FROM chat_messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ? AND m.deleted_at IS NULL
    `;
    const args: any[] = [channelId];

    if (replyTo) {
      sql += ` AND m.reply_to = ?`;
      args.push(replyTo);
    } else {
      sql += ` AND m.reply_to IS NULL`;
    }

    if (before) {
      sql += ` AND m.created_at < ?`;
      args.push(before);
    }

    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    args.push(limit);

    const result = await db.execute({ sql, args });

    // Get reactions and files for each message
    const messages = await Promise.all(result.rows.map(async (row) => {
      const [reactions, files, replyCount] = await Promise.all([
        db.execute({
          sql: `SELECT r.*, u.name as user_name FROM chat_reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ?`,
          args: [row.id],
        }),
        db.execute({
          sql: 'SELECT * FROM chat_files WHERE message_id = ?',
          args: [row.id],
        }),
        db.execute({
          sql: 'SELECT COUNT(*) as count FROM chat_messages WHERE reply_to = ? AND deleted_at IS NULL',
          args: [row.id],
        }),
      ]);

      return {
        ...row,
        user: { id: row.user_id, name: row.user_name, email: row.user_email, avatar_url: row.user_avatar },
        reactions: reactions.rows,
        files: files.rows,
        reply_count: replyCount.rows[0]?.count || 0,
      };
    }));

    // Update last_read_at
    await db.execute({
      sql: 'UPDATE chat_members SET last_read_at = CURRENT_TIMESTAMP WHERE channel_id = ? AND user_id = ?',
      args: [channelId, user.id],
    });

    return NextResponse.json({ messages: messages.reverse() });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Get messages error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { channelId, content, replyTo, type } = await req.json();

    if (!channelId || !content) {
      return NextResponse.json({ error: 'channelId and content required' }, { status: 400 });
    }

    // Verify membership
    const membership = await db.execute({
      sql: 'SELECT id FROM chat_members WHERE channel_id = ? AND user_id = ?',
      args: [channelId, user.id],
    });
    if (membership.rows.length === 0) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 });
    }

    const id = nanoid();
    await db.execute({
      sql: `INSERT INTO chat_messages (id, channel_id, user_id, content, type, reply_to)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, channelId, user.id, content, type || 'text', replyTo || null],
    });

    // Extract @mentions
    const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g;
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
      const mentionedUserId = match[2];
      await db.execute({
        sql: 'INSERT OR IGNORE INTO chat_mentions (id, message_id, user_id) VALUES (?, ?, ?)',
        args: [nanoid(), id, mentionedUserId],
      });

      // Notify mentioned user
      await pusherServer.trigger(`private-user-${mentionedUserId}`, 'mention', {
        messageId: id,
        channelId,
        mentionedBy: user.name,
        content: content.substring(0, 100),
      });
    }

    const message = {
      id,
      channel_id: channelId,
      user_id: user.id,
      content,
      type: type || 'text',
      reply_to: replyTo || null,
      created_at: new Date().toISOString(),
      user: { id: user.id, name: user.name, email: user.email, avatar_url: user.avatar_url },
      reactions: [],
      files: [],
      reply_count: 0,
    };

    // Broadcast via Pusher
    await pusherServer.trigger(`presence-channel-${channelId}`, 'new-message', message);

    // Update last_read_at for sender
    await db.execute({
      sql: 'UPDATE chat_members SET last_read_at = CURRENT_TIMESTAMP WHERE channel_id = ? AND user_id = ?',
      args: [channelId, user.id],
    });

    return NextResponse.json({ message }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Create message error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const { messageId, content } = await req.json();

    const msg = await db.execute({
      sql: 'SELECT * FROM chat_messages WHERE id = ? AND user_id = ?',
      args: [messageId, user.id],
    });

    if (msg.rows.length === 0) {
      return NextResponse.json({ error: 'Message not found or not yours' }, { status: 404 });
    }

    await db.execute({
      sql: 'UPDATE chat_messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: [content, messageId],
    });

    const channelId = msg.rows[0].channel_id;
    await pusherServer.trigger(`presence-channel-${channelId}`, 'message-updated', {
      messageId,
      content,
      edited_at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const messageId = searchParams.get('messageId');

    if (!messageId) return NextResponse.json({ error: 'messageId required' }, { status: 400 });

    const msg = await db.execute({
      sql: 'SELECT * FROM chat_messages WHERE id = ? AND user_id = ?',
      args: [messageId, user.id],
    });

    if (msg.rows.length === 0) {
      return NextResponse.json({ error: 'Message not found or not yours' }, { status: 404 });
    }

    await db.execute({
      sql: 'UPDATE chat_messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: [messageId],
    });

    const channelId = msg.rows[0].channel_id;
    await pusherServer.trigger(`presence-channel-${channelId}`, 'message-deleted', { messageId });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
