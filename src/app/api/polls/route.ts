import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { pusherServer } from '@/lib/pusher';
import { nanoid } from 'nanoid';

// GET ?channelId=X — bulk poll fetch so the message list can map polls by id
// in a single round trip when rendering history.
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const channelId = new URL(req.url).searchParams.get('channelId');
    if (!channelId) return NextResponse.json({ error: 'channelId required' }, { status: 400 });

    const member = await db.execute({
      sql: 'SELECT 1 FROM chat_members WHERE channel_id = ? AND user_id = ? LIMIT 1',
      args: [channelId, user.id],
    });
    if (member.rows.length === 0) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

    const polls = await db.execute({
      sql: `SELECT id, message_id, channel_id, question, options, multiple_choice, closes_at, created_by, created_at
            FROM chat_polls WHERE channel_id = ? ORDER BY created_at DESC LIMIT 200`,
      args: [channelId],
    });

    const votes = await db.execute({
      sql: `SELECT v.poll_id, v.user_id, v.option_idx, u.username as user_name
            FROM chat_poll_votes v
            JOIN users u ON u.id = v.user_id
            WHERE v.poll_id IN (SELECT id FROM chat_polls WHERE channel_id = ?)`,
      args: [channelId],
    });

    const votesByPoll = new Map<string, any[]>();
    for (const v of votes.rows) {
      const arr = votesByPoll.get(v.poll_id as string) || [];
      arr.push({ user_id: v.user_id, user_name: v.user_name, option_idx: Number(v.option_idx) });
      votesByPoll.set(v.poll_id as string, arr);
    }

    const result = polls.rows.map(p => ({
      id: p.id,
      message_id: p.message_id,
      channel_id: p.channel_id,
      question: p.question,
      options: JSON.parse(String(p.options || '[]')),
      multiple_choice: Boolean(p.multiple_choice),
      closes_at: p.closes_at,
      created_by: p.created_by,
      created_at: p.created_at,
      votes: votesByPoll.get(p.id as string) || [],
    }));

    return NextResponse.json({ polls: result });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Get polls error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST: create a poll. Creates an underlying chat_messages row of type 'poll'
// so the message list can render it inline alongside text messages.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { channelId, question, options, multipleChoice, closesAt } = await req.json();

    if (!channelId || !question?.trim() || !Array.isArray(options) || options.length < 2) {
      return NextResponse.json({ error: 'channelId, question, and 2+ options required' }, { status: 400 });
    }
    if (options.length > 10) {
      return NextResponse.json({ error: 'Max 10 options' }, { status: 400 });
    }

    const member = await db.execute({
      sql: 'SELECT 1 FROM chat_members WHERE channel_id = ? AND user_id = ? LIMIT 1',
      args: [channelId, user.id],
    });
    if (member.rows.length === 0) return NextResponse.json({ error: 'Not a member' }, { status: 403 });

    const messageId = nanoid();
    // The text content is a fallback for clients that don't render polls.
    const fallbackContent = `📊 ${question.trim()}\n${options.map((o: string, i: number) => `${i + 1}. ${o}`).join('\n')}`;
    await db.execute({
      sql: `INSERT INTO chat_messages (id, channel_id, user_id, content, type)
            VALUES (?, ?, ?, ?, 'poll')`,
      args: [messageId, channelId, user.id, fallbackContent],
    });

    const pollId = nanoid();
    await db.execute({
      sql: `INSERT INTO chat_polls (id, message_id, channel_id, question, options, multiple_choice, closes_at, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        pollId, messageId, channelId, question.trim(),
        JSON.stringify(options.map(String)),
        multipleChoice ? 1 : 0,
        closesAt || null,
        user.id,
      ],
    });

    const inserted = await db.execute({
      sql: 'SELECT created_at FROM chat_messages WHERE id = ?',
      args: [messageId],
    });
    const createdAt = (inserted.rows[0]?.created_at as string) || new Date().toISOString();

    const message = {
      id: messageId,
      channel_id: channelId,
      user_id: user.id,
      content: fallbackContent,
      type: 'poll' as const,
      reply_to: null,
      created_at: createdAt,
      user: { id: user.id, name: user.name, email: user.email, avatar_url: null },
      reactions: [],
      files: [],
      reply_count: 0,
      poll: {
        id: pollId,
        message_id: messageId,
        channel_id: channelId,
        question: question.trim(),
        options,
        multiple_choice: !!multipleChoice,
        closes_at: closesAt || null,
        created_by: user.id,
        created_at: createdAt,
        votes: [],
      },
    };

    try {
      await pusherServer.trigger(`presence-channel-${channelId}`, 'new-message', message);
    } catch (e) {
      console.error('Poll broadcast failed:', e);
    }

    return NextResponse.json({ message }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    console.error('Create poll error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
