import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { pusherServer } from '@/lib/pusher';

// Vercel Cron handler — runs on a schedule defined in vercel.json. Each invocation
// claims due reminders (delivered_at IS NULL AND remind_at <= now()), pushes a
// `reminder` event to each user's private channel, then marks them delivered.
//
// Vercel sets `Authorization: Bearer ${CRON_SECRET}` on cron invocations. We
// reject anything without the matching secret so the endpoint isn't a public
// fire-arbitrary-notifications API.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const due = await db.execute({
      sql: `SELECT id, user_id, text, channel_id, message_id, remind_at
            FROM chat_reminders
            WHERE delivered_at IS NULL AND remind_at <= datetime('now')
            LIMIT 100`,
      args: [],
    });

    let delivered = 0;
    for (const r of due.rows) {
      try {
        await pusherServer.trigger(`private-user-${r.user_id}`, 'reminder', {
          id: r.id,
          text: r.text,
          channelId: r.channel_id,
          messageId: r.message_id,
          remindAt: r.remind_at,
        });
        await db.execute({
          sql: 'UPDATE chat_reminders SET delivered_at = CURRENT_TIMESTAMP WHERE id = ?',
          args: [r.id],
        });
        delivered++;
      } catch (e) {
        console.error('Failed to deliver reminder', r.id, e);
      }
    }

    return NextResponse.json({ checked: due.rows.length, delivered });
  } catch (error) {
    console.error('Cron reminder error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
