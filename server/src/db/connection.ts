import { Pool, PoolClient } from 'pg';
export type { PoolClient } from 'pg';
import { config } from '../config';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }
  return pool;
}

// Test-only: lets unit tests swap in a fake pool. Not exported from any
// public module.
export function __setPoolForTest(next: Pool | null): void {
  pool = next;
}

// Plain pool checkout. No RLS context set. Use for unauthenticated /
// bootstrap paths (first-boot setup, magic-link lookup, platform
// settings reads). Queries against RLS-enabled tables return zero
// rows unless the table is on the no-RLS carve-out list — this is
// deliberate default-deny.
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// Tenant-scoped execution. Sets `app.current_tenant` so the
// `tenant_isolation` RLS policy gates every query, and clears
// `app.is_platform_admin` so a stuck-on bypass flag from a prior
// checkout can't short-circuit isolation. Both settings are
// transaction-local (`is_local=true`) — they don't persist on the
// client once it returns to the pool.
export async function withTenantContext<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    return fn(client);
  });
}

// Platform-admin cross-tenant execution. Sets `app.is_platform_admin`
// so the `platform_admin_bypass` RLS policy lets the query see every
// tenant's rows. Use for admin UI, fan-out dispatch iterating
// connected tenants, Stripe webhook reverse-lookups, and any audit
// query that deliberately crosses tenants. Bypass is opt-in via this
// named helper — never assumed.
export async function withAdminClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    return fn(client);
  });
}

// Transaction analogues. Same context semantics; BEGIN/COMMIT wraps
// the work. ROLLBACK on any throw.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function withTenantTransaction<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    return fn(client);
  });
}

export async function withAdminTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    return fn(client);
  });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
