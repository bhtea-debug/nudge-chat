import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { nanoid } from 'nanoid';

export async function GET() {
  try {
    const user = await requireUser();
    const result = await db.execute({
      sql: `SELECT id, remind_at, text, channel_id, message_id, delivered_at, created_at
            FROM chat_reminders
            WHERE user_id = ? AND delivered_at IS NULL
            ORDER BY remind_at ASC`,
      args: [user.id],
    });
    return NextResponse.json({ reminders: result.rows });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { remindAt, text, channelId, messageId } = await req.json();

    if (!remindAt || !text?.trim()) {
      return NextResponse.json({ error: 'remindAt and text required' }, { status: 400 });
    }
    const at = new Date(remindAt);
    if (isNaN(at.getTime())) {
      return NextResponse.json({ error: 'invalid remindAt' }, { status: 400 });
    }
    if (at.getTime() < Date.now() - 60_000) {
      return NextResponse.json({ error: 'remindAt must be in the future' }, { status: 400 });
    }

    const id = nanoid();
    // Persist in ISO so the cron sweep can compare against `now()` reliably.
    await db.execute({
      sql: `INSERT INTO chat_reminders (id, user_id, remind_at, text, channel_id, message_id)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, user.id, at.toISOString(), text.trim(), channelId || null, messageId || null],
    });
    return NextResponse.json({ reminder: { id, remind_at: at.toISOString(), text: text.trim() } }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Create reminder error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await db.execute({
      sql: 'DELETE FROM chat_reminders WHERE id = ? AND user_id = ?',
      args: [id, user.id],
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
