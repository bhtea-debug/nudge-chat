import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { nanoid } from 'nanoid';

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const filter = searchParams.get('filter') || 'all'; // all | unread | dm | group

    let sql = `
      SELECT c.*,
        (SELECT content FROM chat_messages WHERE channel_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_message_content,
        (SELECT user_id FROM chat_messages WHERE channel_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_message_user_id,
        (SELECT created_at FROM chat_messages WHERE channel_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_message_at,
        (SELECT COUNT(*) FROM chat_messages WHERE channel_id = c.id AND deleted_at IS NULL AND created_at > COALESCE(m.last_read_at, '1970-01-01')) as unread_count
      FROM chat_channels c
      INNER JOIN chat_members m ON m.channel_id = c.id AND m.user_id = ?
      LEFT JOIN chat_channel_settings cs ON cs.channel_id = c.id AND cs.user_id = ?
      WHERE c.is_archived = 0 AND COALESCE(cs.is_archived, 0) = 0
    `;

    const args: any[] = [user.id, user.id];

    if (filter === 'unread') {
      sql += ` HAVING unread_count > 0`;
    } else if (filter === 'dm') {
      sql += ` AND c.type = 'dm'`;
    } else if (filter === 'group') {
      sql += ` AND c.type = 'group'`;
    }

    sql += ` ORDER BY last_message_at DESC NULLS LAST`;

    const result = await db.execute({ sql, args });

    // For DMs, get the other user's info
    const channels = await Promise.all(result.rows.map(async (row) => {
      const channel: any = { ...row };

      if (row.type === 'dm') {
        const otherUser = await db.execute({
          sql: `SELECT u.id, u.email, u.username, NULL as avatar_url
                FROM chat_members cm
                JOIN users u ON u.id = cm.user_id
                WHERE cm.channel_id = ? AND cm.user_id != ?`,
          args: [row.id, user.id],
        });
        if (otherUser.rows.length > 0) {
          channel.other_user = otherUser.rows[0];
        }
      }

      return channel;
    }));

    return NextResponse.json({ channels });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Get channels error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { name, description, type, members, icon } = await req.json();

    const id = nanoid();
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    if (type === 'dm') {
      // Check if DM already exists between these users
      const targetUserId = members?.[0];
      if (!targetUserId) {
        return NextResponse.json({ error: 'Target user required for DM' }, { status: 400 });
      }

      const existing = await db.execute({
        sql: `SELECT c.id FROM chat_channels c
              WHERE c.type = 'dm'
              AND EXISTS (SELECT 1 FROM chat_members WHERE channel_id = c.id AND user_id = ?)
              AND EXISTS (SELECT 1 FROM chat_members WHERE channel_id = c.id AND user_id = ?)`,
        args: [user.id, targetUserId],
      });

      if (existing.rows.length > 0) {
        return NextResponse.json({ channel: { id: existing.rows[0].id } });
      }
    }

    await db.execute({
      sql: `INSERT INTO chat_channels (id, name, slug, description, type, icon, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, name || 'DM', slug || id, description || null, type || 'group', icon || null, user.id],
    });

    // Add creator as admin
    await db.execute({
      sql: `INSERT INTO chat_members (id, channel_id, user_id, role) VALUES (?, ?, ?, 'admin')`,
      args: [nanoid(), id, user.id],
    });

    // Add other members
    if (members && Array.isArray(members)) {
      for (const memberId of members) {
        await db.execute({
          sql: `INSERT OR IGNORE INTO chat_members (id, channel_id, user_id, role) VALUES (?, ?, ?, 'member')`,
          args: [nanoid(), id, memberId],
        });
      }
    }

    return NextResponse.json({ channel: { id, name, slug, type } }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Create channel error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
