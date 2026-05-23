import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { nanoid } from 'nanoid';

export async function GET() {
  try {
    const user = await requireUser();
    const cats = await db.execute({
      sql: 'SELECT id, name, position, created_at FROM chat_channel_categories WHERE user_id = ? ORDER BY position ASC, created_at ASC',
      args: [user.id],
    });
    const map = await db.execute({
      sql: 'SELECT channel_id, category_id FROM chat_channel_category_map WHERE user_id = ?',
      args: [user.id],
    });
    return NextResponse.json({
      categories: cats.rows,
      assignments: map.rows,
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const { name, position } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const id = nanoid();
    await db.execute({
      sql: 'INSERT INTO chat_channel_categories (id, user_id, name, position) VALUES (?, ?, ?, ?)',
      args: [id, user.id, name.trim(), Number(position) || 0],
    });
    return NextResponse.json({ category: { id, name: name.trim(), position: Number(position) || 0 } }, { status: 201 });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser();
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await db.execute({
      sql: 'DELETE FROM chat_channel_category_map WHERE category_id = ? AND user_id = ?',
      args: [id, user.id],
    });
    await db.execute({
      sql: 'DELETE FROM chat_channel_categories WHERE id = ? AND user_id = ?',
      args: [id, user.id],
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// PATCH: assign / unassign a channel to a category.
export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const { channelId, categoryId } = await req.json();
    if (!channelId) return NextResponse.json({ error: 'channelId required' }, { status: 400 });

    if (!categoryId) {
      await db.execute({
        sql: 'DELETE FROM chat_channel_category_map WHERE user_id = ? AND channel_id = ?',
        args: [user.id, channelId],
      });
      return NextResponse.json({ ok: true });
    }

    // Verify category belongs to this user before assigning.
    const owned = await db.execute({
      sql: 'SELECT 1 FROM chat_channel_categories WHERE id = ? AND user_id = ?',
      args: [categoryId, user.id],
    });
    if (owned.rows.length === 0) return NextResponse.json({ error: 'Category not found' }, { status: 404 });

    // Upsert: delete + insert is simpler than ON CONFLICT here because we keyed
    // chat_channel_category_map on (user_id, channel_id).
    await db.execute({
      sql: 'DELETE FROM chat_channel_category_map WHERE user_id = ? AND channel_id = ?',
      args: [user.id, channelId],
    });
    await db.execute({
      sql: 'INSERT INTO chat_channel_category_map (id, user_id, channel_id, category_id) VALUES (?, ?, ?, ?)',
      args: [nanoid(), user.id, channelId, categoryId],
    });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
