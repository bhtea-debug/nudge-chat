import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { nanoid } from 'nanoid';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ newsId: string }> }
) {
  try {
    const user = await requireUser();
    const { newsId } = await params;

    // Check if already liked
    const existing = await db.execute({
      sql: 'SELECT id FROM news_likes WHERE news_id = ? AND user_id = ?',
      args: [newsId, user.id],
    });

    if (existing.rows.length > 0) {
      // Unlike
      await db.execute({
        sql: 'DELETE FROM news_likes WHERE news_id = ? AND user_id = ?',
        args: [newsId, user.id],
      });
      await db.execute({
        sql: 'UPDATE company_news SET likes_count = MAX(0, likes_count - 1) WHERE id = ?',
        args: [newsId],
      });
      return NextResponse.json({ liked: false });
    } else {
      // Like
      await db.execute({
        sql: 'INSERT INTO news_likes (id, news_id, user_id) VALUES (?, ?, ?)',
        args: [nanoid(), newsId, user.id],
      });
      await db.execute({
        sql: 'UPDATE company_news SET likes_count = likes_count + 1 WHERE id = ?',
        args: [newsId],
      });
      return NextResponse.json({ liked: true });
    }
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Toggle like error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
