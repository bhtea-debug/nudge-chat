import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { db } from './db';
import type { User } from '@/types';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'dev-secret-change-in-production-min32');

export async function createToken(userId: string): Promise<string> {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('30d')
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<{ userId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as { userId: string };
  } catch {
    return null;
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get('auth-token')?.value;
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  const result = await db.execute({
    sql: 'SELECT id, username, email, role FROM users WHERE id = ?',
    args: [payload.userId],
  });

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id as string,
    name: row.username as string,
    email: (row.email as string) || '',
  };
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new Error('Unauthorized');
  return user;
}
