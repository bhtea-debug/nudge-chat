import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { nanoid } from 'nanoid';

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = 20;
    const offset = (page - 1) * limit;

    const result = await db.execute({
      sql: `SELECT n.*, u.name as author_name, u.avatar_url as author_avatar,
            EXISTS(SELECT 1 FROM news_likes WHERE news_id = n.id AND user_id = ?) as liked_by_me
            FROM company_news n
            JOIN users u ON u.id = n.author_id
            ORDER BY n.pinned DESC, n.created_at DESC
            LIMIT ? OFFSET ?`,
      args: [user.id, limit, offset],
    });

    return NextResponse.json({ news: result.rows });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { title, content, imageUrl } = await req.json();

    if (!title || !content) {
      return NextResponse.json({ error: 'Title and content required' }, { status: 400 });
    }

    const id = nanoid();
    await db.execute({
      sql: `INSERT INTO company_news (id, author_id, title, content, image_url)
            VALUES (?, ?, ?, ?, ?)`,
      args: [id, user.id, title, content, imageUrl || null],
    });

    return NextResponse.json({ news: { id, title, content } }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
