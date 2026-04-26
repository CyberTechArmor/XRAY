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

// Session-level GUC writes. The previous implementation used
// `set_config(..., true)` (is_local=true) which only persists inside
// an explicit transaction — outside one, the value is "set" for the
// implicit single-statement transaction and immediately reset, so
// the very next query sees the GUC unset. With FORCE ROW LEVEL
// SECURITY in effect (migration 044), policies fire on every query
// and a missing GUC bypasses isolation by default-deny. We therefore
// use is_local=false (session scope) for the bare-checkout helpers
// AND reset every RLS GUC on every withClient entry so a prior
// pool-client occupant's state can never leak into the next.
async function resetRlsContext(client: PoolClient): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_tenant', '', false),
            set_config('app.current_user_id', '', false),
            set_config('app.is_platform_admin', 'false', false)`
  );
}

// Plain pool checkout. RLS context is RESET to default-deny at the
// start of every checkout (empty current_tenant / current_user_id,
// is_platform_admin=false). Use for unauthenticated / bootstrap
// paths (first-boot setup, magic-link lookup, platform settings
// reads). Queries against RLS-enabled tables return zero rows
// unless the table is on the no-RLS carve-out list — this is
// deliberate default-deny.
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await resetRlsContext(client);
    return await fn(client);
  } finally {
    client.release();
  }
}

// Tenant-scoped execution. Sets `app.current_tenant` so the
// `tenant_isolation` RLS policy gates every query. `withClient`
// has already reset every other GUC to the default-deny baseline
// before this body runs, so a stuck-on bypass flag from a prior
// checkout cannot short-circuit isolation. Settings are session-
// scoped (is_local=false) but reset on every checkout, so they
// don't leak across pool occupants.
export async function withTenantContext<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.current_tenant', $1, false)`, [tenantId]);
    return fn(client);
  });
}

// Per-user execution. Sets `app.current_tenant` + `app.current_user_id`
// so user_scope RLS policies can gate every query against the acting
// user. Use for user-scoped tables: inbox (migration 030), and — in
// a future refactor — the ai_* tables that currently ship their own
// copy of this helper in ai.service.ts (withAiUserContext).
export async function withUserContext<T>(
  tenantId: string,
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    await client.query(
      `SELECT set_config('app.current_tenant', $1, false),
              set_config('app.current_user_id', $2, false)`,
      [tenantId, userId]
    );
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
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    return fn(client);
  });
}

// Transaction analogues. is_local=true works as documented inside an
// explicit BEGIN/COMMIT. The reset shape mirrors withClient so the
// transaction body starts from the default-deny baseline before the
// caller-specific context is applied.
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_tenant', '', true),
              set_config('app.current_user_id', '', true),
              set_config('app.is_platform_admin', 'false', true)`
    );
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
