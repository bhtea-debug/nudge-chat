import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { nanoid } from 'nanoid';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ newsId: string }> }
) {
  try {
    await requireUser();
    const { newsId } = await params;

    const result = await db.execute({
      sql: `SELECT c.*, u.username as user_name, u.email as user_email
            FROM news_comments c
            JOIN users u ON u.id = c.user_id
            WHERE c.news_id = ?
            ORDER BY c.created_at ASC`,
      args: [newsId],
    });

    const comments = result.rows.map(row => ({
      ...row,
      user: { id: row.user_id, name: row.user_name, email: row.user_email },
    }));

    return NextResponse.json({ comments });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Get comments error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ newsId: string }> }
) {
  try {
    const user = await requireUser();
    const { newsId } = await params;
    const { content } = await req.json();

    if (!content?.trim()) {
      return NextResponse.json({ error: 'Content required' }, { status: 400 });
    }

    const id = nanoid();
    await db.execute({
      sql: 'INSERT INTO news_comments (id, news_id, user_id, content) VALUES (?, ?, ?, ?)',
      args: [id, newsId, user.id, content.trim()],
    });

    await db.execute({
      sql: 'UPDATE company_news SET comments_count = comments_count + 1 WHERE id = ?',
      args: [newsId],
    });

    return NextResponse.json({
      comment: {
        id,
        news_id: newsId,
        user_id: user.id,
        content: content.trim(),
        created_at: new Date().toISOString(),
        user: { id: user.id, name: user.name, email: user.email },
      },
    }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Create comment error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
