import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';
import { nanoid } from 'nanoid';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pollId: string }> },
) {
  try {
    const user = await requireUser();
    const { pollId } = await params;
    const { optionIdx } = await req.json();

    if (typeof optionIdx !== 'number' || optionIdx < 0) {
      return NextResponse.json({ error: 'optionIdx must be a non-negative integer' }, { status: 400 });
    }

    const poll = await db.execute({
      sql: 'SELECT channel_id, options, multiple_choice, closes_at FROM chat_polls WHERE id = ?',
      args: [pollId],
    });
    if (poll.rows.length === 0) return NextResponse.json({ error: 'Poll not found' }, { status: 404 });

    const channelId = poll.rows[0].channel_id as string;
    const options: string[] = JSON.parse(String(poll.rows[0].options || '[]'));
    const multiple = !!poll.rows[0].multiple_choice;
    const closesAt = poll.rows[0].closes_at as string | null;

    if (optionIdx >= options.length) {
      return NextResponse.json({ error: 'option out of range' }, { status: 400 });
    }
    if (closesAt && new Date(closesAt).getTime() < Date.now()) {
      return NextResponse.json({ error: 'Poll closed' }, { status: 410 });
    }

    const member = await db.execute({
      sql: 'SELECT 1 FROM chat_members WHERE channel_id = ? AND user_id = ? LIMIT 1',
      args: [channelId, user.id],
    });
    if (member.rows.length === 0) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

    // Toggle the vote. For single-choice polls, replace any prior selection.
    const existing = await db.execute({
      sql: 'SELECT id FROM chat_poll_votes WHERE poll_id = ? AND user_id = ? AND option_idx = ?',
      args: [pollId, user.id, optionIdx],
    });

    if (existing.rows.length > 0) {
      await db.execute({
        sql: 'DELETE FROM chat_poll_votes WHERE poll_id = ? AND user_id = ? AND option_idx = ?',
        args: [pollId, user.id, optionIdx],
      });
    } else {
      if (!multiple) {
        // Single-choice: drop any prior selection by this user before adding the new one.
        await db.execute({
          sql: 'DELETE FROM chat_poll_votes WHERE poll_id = ? AND user_id = ?',
          args: [pollId, user.id],
        });
      }
      await db.execute({
        sql: 'INSERT OR IGNORE INTO chat_poll_votes (id, poll_id, user_id, option_idx) VALUES (?, ?, ?, ?)',
        args: [nanoid(), pollId, user.id, optionIdx],
      });
    }

    // Broadcast new vote tally so other clients update without polling.
    const votes = await db.execute({
      sql: `SELECT v.user_id, v.option_idx, u.username as user_name
            FROM chat_poll_votes v JOIN users u ON u.id = v.user_id
            WHERE v.poll_id = ?`,
      args: [pollId],
    });
    const voteList = votes.rows.map(v => ({
      user_id: v.user_id, user_name: v.user_name, option_idx: Number(v.option_idx),
    }));

    pusherServer.trigger(`presence-channel-${channelId}`, 'poll-vote', { pollId, votes: voteList })
      .catch(e => console.error('poll vote broadcast failed', e));

    return NextResponse.json({ ok: true, votes: voteList });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Vote error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
