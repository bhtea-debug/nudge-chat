import { createClient, type Client } from '@libsql/client';

let _db: Client | null = null;

export function getDb(): Client {
  if (!_db) {
    _db = createClient({
      url: process.env.TURSO_CONNECTION_URL || 'file:local.db',
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _db;
}

// Proxy for backward compat
export const db = new Proxy({} as Client, {
  get(_, prop) {
    return (getDb() as any)[prop];
  },
});
