import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    const channelId = searchParams.get('channelId');
    const type = searchParams.get('type') || 'all'; // all | messages | channels | people

    if (type !== 'people' && (!q || q.length < 2)) {
      return NextResponse.json({ results: [] });
    }

    const searchTerm = q ? `%${q}%` : '%';
    const results: any = { messages: [], channels: [], people: [] };

    if (type === 'all' || type === 'messages') {
      let msgSql = `
        SELECT m.id, m.content, m.created_at, m.channel_id,
               u.username as user_name, NULL as user_avatar,
               c.name as channel_name
        FROM chat_messages m
        JOIN users u ON u.id = m.user_id
        JOIN chat_channels c ON c.id = m.channel_id
        JOIN chat_members cm ON cm.channel_id = m.channel_id AND cm.user_id = ?
        WHERE m.content LIKE ? AND m.deleted_at IS NULL
      `;
      const msgArgs: any[] = [user.id, searchTerm];

      if (channelId) {
        msgSql += ` AND m.channel_id = ?`;
        msgArgs.push(channelId);
      }

      msgSql += ` ORDER BY m.created_at DESC LIMIT 20`;

      const msgResult = await db.execute({ sql: msgSql, args: msgArgs });
      results.messages = msgResult.rows;
    }

    if ((type === 'all' || type === 'channels') && !channelId) {
      const chResult = await db.execute({
        sql: `SELECT c.* FROM chat_channels c
              JOIN chat_members cm ON cm.channel_id = c.id AND cm.user_id = ?
              WHERE c.name LIKE ? AND c.is_archived = 0 AND c.type = 'group'
              LIMIT 10`,
        args: [user.id, searchTerm],
      });
      results.channels = chResult.rows;
    }

    if ((type === 'all' || type === 'people') && !channelId) {
      const pplResult = await db.execute({
        sql: `SELECT id, username as name, email, NULL as avatar_url FROM users WHERE username LIKE ? OR email LIKE ? LIMIT 10`,
        args: [searchTerm, searchTerm],
      });
      results.people = pplResult.rows;
    }

    return NextResponse.json({ results });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
