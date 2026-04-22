/**
 * Backfill script — rewrites plaintext tenant credentials as enc:v1:
 * envelopes. Safe to re-run: rows already carrying the envelope are
 * skipped. Pass --dry-run to preview without writing.
 *
 * Compiled to dist/scripts/backfill-encrypt-credentials.js by tsc and
 * shipped inside the server container. Invoked from update.sh after
 * migration 017 applies:
 *
 *   docker compose exec -T server node dist/scripts/backfill-encrypt-credentials.js
 *
 * Reads DATABASE_URL and ENCRYPTION_KEY from env, same as the server.
 * Run AFTER deploying code that writes enc:v1 and AFTER applying
 * migration 017.
 */
import { Pool, PoolClient } from 'pg';
import { encryptSecret } from '../lib/encrypted-column';

const DRY_RUN = process.argv.includes('--dry-run');

type Counters = { encrypted: number; skipped: number };

function isEncryptedText(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('enc:v1:');
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
    // `dashboards.fetch_headers` was dropped in step 3 (migration 020);
    // its backfill entry was removed with it.
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
