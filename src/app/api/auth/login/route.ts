import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createToken } from '@/lib/auth';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    const result = await db.execute({
      sql: 'SELECT id, email, username, password_hash, role FROM users WHERE email = ? OR username = ?',
      args: [username, username],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const user = result.rows[0];
    const passwordHash = user.password_hash as string | null;

    // Reject accounts with no password set — falling through let anyone in
    // who knew the username for any user the shared Nudge table imported
    // without a credential.
    if (!passwordHash) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }
    const valid = await bcrypt.compare(password, passwordHash);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const token = await createToken(user.id as string);

    const response = NextResponse.json({
      user: {
        id: user.id,
        name: user.username,
        email: user.email || user.username,
        role: user.role,
      }
    });

    response.cookies.set('auth-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60,
      path: '/',
    });

    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
