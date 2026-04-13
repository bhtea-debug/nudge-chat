import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireUser } from '@/lib/auth';

export async function GET() {
  try {
    await requireUser();

    const result = await db.execute({
      sql: `SELECT c.*, s.status, s.status_text, s.status_emoji, s.last_seen_at
            FROM company_contacts c
            LEFT JOIN chat_user_status s ON s.user_id = c.user_id
            ORDER BY c.display_name ASC`,
      args: [],
    });

    return NextResponse.json({ contacts: result.rows });
  } catch (error: any) {
    if (error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
