import { db } from './index';
import { SCHEMA } from './schema';

async function migrate() {
  console.log('Running migrations...');
  const statements = SCHEMA.split(';').filter(s => s.trim().length > 0);

  for (const statement of statements) {
    try {
      await db.execute(statement.trim() + ';');
      console.log('✓', statement.trim().substring(0, 60) + '...');
    } catch (error) {
      console.error('✗ Failed:', statement.trim().substring(0, 60));
      console.error(error);
    }
  }

  console.log('Migrations complete!');
}

migrate().catch(console.error);
