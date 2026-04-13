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

// Re-export as db for convenience — calls getDb() on each use
export const db = {
  execute: (...args: Parameters<Client['execute']>) => getDb().execute(...args),
  batch: (...args: Parameters<Client['batch']>) => getDb().batch(...args),
  close: () => getDb().close(),
};
