/**
 * Backfill script — rewrites plaintext tenant credentials as enc:v1:
 * envelopes. Safe to re-run: rows already carrying the envelope are
 * skipped. Pass --dry-run to preview without writing.
 *
 *   cd server && npx tsx scripts/backfill-encrypt-credentials.ts [--dry-run]
 *
 * Reads DATABASE_URL and ENCRYPTION_KEY from env, same as the server.
 * Run AFTER deploying code that writes enc:v1 and AFTER applying
 * migration 017.
 */
import { Pool, PoolClient } from 'pg';
import { encryptSecret, encryptJsonField } from '../src/lib/encrypted-column';

const DRY_RUN = process.argv.includes('--dry-run');

type Counters = { encrypted: number; skipped: number };

function isEncryptedText(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('enc:v1:');
}

function isEncryptedJsonb(v: unknown): boolean {
  if (v == null) return true;
  const obj = typeof v === 'string' ? JSON.parse(v) : v;
  if (!obj || typeof obj !== 'object') return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;
  return keys.length === 1 && typeof obj._enc === 'string' && obj._enc.startsWith('enc:v1:');
}

async function backfillText(
  client: PoolClient,
  label: string,
  table: string,
  column: string,
): Promise<Counters> {
  const counters: Counters = { encrypted: 0, skipped: 0 };
  const { rows } = await client.query(
    `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> ''`,
  );
  for (const row of rows) {
    if (isEncryptedText(row.value)) {
      counters.skipped++;
      continue;
    }
    const ciphertext = encryptSecret(row.value as string);
    if (!DRY_RUN) {
      await client.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [ciphertext, row.id]);
    }
    counters.encrypted++;
  }
  console.log(`${label}: encrypted=${counters.encrypted} skipped=${counters.skipped}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  return counters;
}

async function backfillJsonb(
  client: PoolClient,
  label: string,
  table: string,
  column: string,
): Promise<Counters> {
  const counters: Counters = { encrypted: 0, skipped: 0 };
  const { rows } = await client.query(
    `SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> '{}'::jsonb`,
  );
  for (const row of rows) {
    if (isEncryptedJsonb(row.value)) {
      counters.skipped++;
      continue;
    }
    const wrapped = encryptJsonField(row.value as Record<string, unknown>);
    if (!DRY_RUN) {
      await client.query(
        `UPDATE ${table} SET ${column} = $1::jsonb WHERE id = $2`,
        [JSON.stringify(wrapped), row.id],
      );
    }
    counters.encrypted++;
  }
  console.log(`${label}: encrypted=${counters.encrypted} skipped=${counters.skipped}${DRY_RUN ? ' [DRY RUN]' : ''}`);
  return counters;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not set');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    // Take a platform-admin stance for the whole session so RLS on the
    // three target tables doesn't hide rows. `false` = session-scoped
    // (persists across statements on this client, no explicit tx).
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    console.log(`Backfill starting${DRY_RUN ? ' (dry run)' : ''}...`);
    await backfillText(client, 'webhooks.secret', 'platform.webhooks', 'secret');
    await backfillText(client, 'connections.connection_details', 'platform.connections', 'connection_details');
    await backfillJsonb(client, 'dashboards.fetch_headers', 'platform.dashboards', 'fetch_headers');
    console.log('Backfill complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
