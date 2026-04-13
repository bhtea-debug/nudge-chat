import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { status, statusText, statusEmoji } = await req.json();

    await db.execute({
      sql: `INSERT INTO chat_user_status (user_id, status, status_text, status_emoji, last_seen_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
              status = excluded.status,
              status_text = excluded.status_text,
              status_emoji = excluded.status_emoji,
              last_seen_at = CURRENT_TIMESTAMP`,
      args: [user.id, status || 'online', statusText || null, statusEmoji || null],
    });

    await pusherServer.trigger('presence-online', 'status-changed', {
      userId: user.id,
      userName: user.name,
      status: status || 'online',
      statusText,
      statusEmoji,
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  try {
    await requireUser();

    const result = await db.execute({
      sql: `SELECT s.*, u.username as name, u.email, NULL as avatar_url
            FROM chat_user_status s
            JOIN users u ON u.id = s.user_id
            WHERE s.status != 'offline'
            OR s.last_seen_at > datetime('now', '-5 minutes')`,
      args: [],
    });

    return NextResponse.json({ statuses: result.rows });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
