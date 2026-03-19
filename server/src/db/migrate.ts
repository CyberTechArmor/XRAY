import { readFileSync } from 'fs';
import { join } from 'path';
import { getPool, closePool } from './connection';

async function migrate() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    // Run the init.sql
    const initSql = readFileSync(join(__dirname, '../../../init.sql'), 'utf-8');
    await client.query(initSql);
    console.log('Database schema created successfully');
  } catch (err) {
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
