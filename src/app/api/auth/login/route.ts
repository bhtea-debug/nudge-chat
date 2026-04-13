import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { createToken } from '@/lib/auth';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    const result = await db.execute({
      sql: 'SELECT id, username, email, password_hash, role FROM users WHERE username = ?',
      args: [username],
    });

    if (result.rows.length === 0) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    const user = result.rows[0];
    const passwordHash = user.password_hash as string;

    if (passwordHash) {
      const valid = await bcrypt.compare(password, passwordHash);
      if (!valid) {
        return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
      }
    }

    const token = await createToken(user.id as string);

    const response = NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.username,
        email: user.email,
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
