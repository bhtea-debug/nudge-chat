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
    const trimmed = statement.trim();
    try {
      await client.execute(trimmed + ';');
      console.log('✓', trimmed.substring(0, 60) + '...');
    } catch (error: any) {
      // Ignore benign re-run errors for additive migrations.
      const msg = String(error?.message || error || '');
      if (/duplicate column name/i.test(msg) || /already exists/i.test(msg)) {
        console.log('= (already applied)', trimmed.substring(0, 60) + '...');
        continue;
      }
      console.error('✗ Failed:', trimmed.substring(0, 60));
      console.error(error);
    }
  }

  console.log('Migrations complete!');
}

migrate().catch(console.error);
