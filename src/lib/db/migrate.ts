import { createClient } from '@libsql/client';
import { SCHEMA } from './schema';

async function migrate() {
  const client = createClient({
    url: process.env.TURSO_CONNECTION_URL || 'file:local.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  console.log('Running migrations...');
  const statements = SCHEMA.split(';').filter(s => s.trim().length > 0);

  for (const statement of statements) {
    try {
      await client.execute(statement.trim() + ';');
      console.log('✓', statement.trim().substring(0, 60) + '...');
    } catch (error) {
      console.error('✗ Failed:', statement.trim().substring(0, 60));
      console.error(error);
    }
  }

  console.log('Migrations complete!');
}

migrate().catch(console.error);
