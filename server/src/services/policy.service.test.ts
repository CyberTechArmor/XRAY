import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Pure-logic + fake-pool specs for policy.service.
// Pattern follows totp.service.test.ts: drive the service through a
// fake pg.Pool installed via db/connection.__setPoolForTest. Locks
// the contracts that don't need a live Postgres — publish-and-
// pendingForUser round-trip, idempotent recordAcceptance, version
// monotonicity, the placeholder marker. RLS scoping + UNIQUE-race
// behaviour is covered by the live cross-tenant probe in
// src/db/rls-probe.test.ts when PROBE_RLS=1 is set.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

interface FakeRow {
  slug: string;
  version: number;
  title: string;
  body_md: string;
  is_required: boolean;
  published_at: string;
  published_by: string | null;
}

interface FakeAcceptance {
  user_id: string;
  tenant_id: string;
  slug: string;
  version: number;
  accepted_at: string;
  ip_hash: string | null;
  ua_hash: string | null;
}

interface FakeClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
  release: () => void;
}

function makeFakePool() {
  const documents: FakeRow[] = [];
  const acceptances: FakeAcceptance[] = [];

  const client: FakeClient = {
    query: (sql: string, params?: unknown[]) => {
      const s = sql.trim();
      const ps = (params || []) as any[];

      // set_config calls — context plumbing, no-op for the fake.
      if (s.startsWith('SELECT set_config')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // listLatest
      if (s.startsWith('SELECT DISTINCT ON (slug)')) {
        const bySlug = new Map<string, FakeRow>();
        for (const d of documents) {
          const cur = bySlug.get(d.slug);
          if (!cur || d.version > cur.version) bySlug.set(d.slug, d);
        }
        const rows = Array.from(bySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug));
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      // getLatest
      if (
        s.startsWith('SELECT slug, version, title, body_md, is_required, published_at, published_by') &&
        s.includes('WHERE slug = $1') &&
        s.includes('ORDER BY version DESC')
      ) {
        const matches = documents.filter((d) => d.slug === ps[0]).sort((a, b) => b.version - a.version);
        return Promise.resolve({ rows: matches.slice(0, 1), rowCount: matches.length ? 1 : 0 });
      }

      // getVersion
      if (
        s.startsWith('SELECT slug, version, title, body_md, is_required, published_at, published_by') &&
        s.includes('WHERE slug = $1 AND version = $2')
      ) {
        const matches = documents.filter((d) => d.slug === ps[0] && d.version === ps[1]);
        return Promise.resolve({ rows: matches, rowCount: matches.length });
      }

      // recordAcceptance pre-insert validation: SELECT 1 FROM policy_documents
      if (s.startsWith('SELECT 1 FROM platform.policy_documents WHERE slug = $1 AND version = $2')) {
        const exists = documents.some((d) => d.slug === ps[0] && d.version === ps[1]);
        return Promise.resolve({ rows: exists ? [{ '?column?': 1 }] : [], rowCount: exists ? 1 : 0 });
      }

      // publishVersion — max(version) probe
      if (s.startsWith('SELECT COALESCE(MAX(version), 0)::int AS max_version')) {
        const maxV = documents.filter((d) => d.slug === ps[0]).reduce((m, d) => Math.max(m, d.version), 0);
        return Promise.resolve({ rows: [{ max_version: maxV }], rowCount: 1 });
      }

      // publishVersion — INSERT
      if (s.startsWith('INSERT INTO platform.policy_documents')) {
        const row: FakeRow = {
          slug: ps[0],
          version: ps[1],
          title: ps[2],
          body_md: ps[3],
          is_required: ps[4],
          published_at: new Date().toISOString(),
          published_by: ps[5] ?? null,
        };
        documents.push(row);
        return Promise.resolve({ rows: [row], rowCount: 1 });
      }

      // recordAcceptance INSERT
      if (s.startsWith('INSERT INTO platform.policy_acceptances')) {
        const dup = acceptances.some(
          (a) => a.user_id === ps[0] && a.slug === ps[2] && a.version === ps[3],
        );
        if (dup) {
          // ON CONFLICT DO NOTHING semantics — silent drop.
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        acceptances.push({
          user_id: ps[0],
          tenant_id: ps[1],
          slug: ps[2],
          version: ps[3],
          ip_hash: ps[4] ?? null,
          ua_hash: ps[5] ?? null,
          accepted_at: new Date().toISOString(),
        });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }

      // pendingForUser CTE query
      if (s.startsWith('WITH latest AS')) {
        const userId = ps[0];
        const bySlug = new Map<string, FakeRow>();
        for (const d of documents) {
          const cur = bySlug.get(d.slug);
          if (!cur || d.version > cur.version) bySlug.set(d.slug, d);
        }
        const myMax = new Map<string, number>();
        for (const a of acceptances) {
          if (a.user_id !== userId) continue;
          const cur = myMax.get(a.slug);
          if (cur === undefined || a.version > cur) myMax.set(a.slug, a.version);
        }
        const rows: any[] = [];
        for (const [slug, latest] of bySlug.entries()) {
          if (!latest.is_required) continue;
          const accepted = myMax.get(slug);
          if (accepted === undefined || accepted < latest.version) {
            rows.push({
              slug,
              current_version: latest.version,
              title: latest.title,
              accepted_version: accepted ?? null,
            });
          }
        }
        rows.sort((a, b) => a.slug.localeCompare(b.slug));
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      // listMyAcceptances
      if (s.startsWith('SELECT slug, version, accepted_at') && s.includes('FROM platform.policy_acceptances')) {
        const rows = acceptances
          .filter((a) => a.user_id === ps[0])
          .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at))
          .map((a) => ({ slug: a.slug, version: a.version, accepted_at: a.accepted_at }));
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      // setRequired UPDATE — match the latest version's is_required.
      if (s.startsWith('UPDATE platform.policy_documents') && s.includes('SET is_required = $1')) {
        const newRequired = ps[0];
        const slug = ps[1];
        const matches = documents.filter((d) => d.slug === slug).sort((a, b) => b.version - a.version);
        if (matches.length === 0) return Promise.resolve({ rows: [], rowCount: 0 });
        matches[0].is_required = newRequired;
        const r = matches[0];
        return Promise.resolve({
          rows: [{ slug: r.slug, version: r.version, title: r.title, body_md: r.body_md, is_required: r.is_required, published_at: r.published_at, published_by: r.published_by }],
          rowCount: 1,
        });
      }

      // listAllVersions admin query
      if (s.includes('FROM platform.policy_documents pd') && s.includes('LEFT JOIN')) {
        const rows = documents
          .map((d) => ({
            slug: d.slug,
            version: d.version,
            title: d.title,
            body_md: d.body_md,
            is_required: d.is_required,
            published_at: d.published_at,
            published_by: d.published_by,
            acceptance_count: acceptances.filter((a) => a.slug === d.slug && a.version === d.version).length,
          }))
          .sort((a, b) => (a.slug === b.slug ? b.version - a.version : a.slug.localeCompare(b.slug)));
        return Promise.resolve({ rows, rowCount: rows.length });
      }

      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: () => {},
  };

  return {
    pool: {
      connect: () => Promise.resolve(client),
      on: () => {},
      end: () => Promise.resolve(),
    } as unknown as import('pg').Pool,
    documents,
    acceptances,
  };
}

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const ADMIN_USER_ID = '33333333-3333-3333-3333-333333333333';

beforeEach(async () => {
  const { __setPoolForTest } = await import('../db/connection');
  __setPoolForTest(null);
});

describe('policy.service — publish + pendingForUser round-trip', () => {
  it('publishVersion appends v1, getLatest returns it, listLatest contains it', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    const v1 = await policy.publishVersion(
      'terms_of_service',
      { title: 'Terms', body_md: '# Terms\nRules.', is_required: true },
      ADMIN_USER_ID,
    );
    expect(v1.version).toBe(1);
    expect(v1.is_placeholder).toBe(false); // body has no marker

    const latest = await policy.getLatest('terms_of_service');
    expect(latest).not.toBeNull();
    expect(latest!.version).toBe(1);
    expect(latest!.title).toBe('Terms');

    const all = await policy.listLatest();
    expect(all.find((p) => p.slug === 'terms_of_service')?.version).toBe(1);
  });

  it('publishVersion increments to v2; pendingForUser surfaces the gap', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    await policy.publishVersion(
      'privacy_policy',
      { title: 'Privacy v1', body_md: '# v1', is_required: true },
      ADMIN_USER_ID,
    );

    // Initially no acceptance — user is pending v1.
    let pending = await policy.pendingForUser(USER_ID, TENANT_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      slug: 'privacy_policy',
      current_version: 1,
      accepted_version: null,
    });

    // User accepts v1 — pending is empty.
    await policy.recordAcceptance(USER_ID, TENANT_ID, 'privacy_policy', 1);
    pending = await policy.pendingForUser(USER_ID, TENANT_ID);
    expect(pending).toHaveLength(0);

    // Admin publishes v2 — user is pending again, with accepted_version=1.
    const v2 = await policy.publishVersion(
      'privacy_policy',
      { title: 'Privacy v2', body_md: '# v2', is_required: true },
      ADMIN_USER_ID,
    );
    expect(v2.version).toBe(2);

    pending = await policy.pendingForUser(USER_ID, TENANT_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      slug: 'privacy_policy',
      current_version: 2,
      accepted_version: 1,
    });

    // User re-accepts v2 — pending empty again.
    await policy.recordAcceptance(USER_ID, TENANT_ID, 'privacy_policy', 2);
    pending = await policy.pendingForUser(USER_ID, TENANT_ID);
    expect(pending).toHaveLength(0);
  });

  it('recordAcceptance is idempotent on (user, slug, version)', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool, acceptances } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    await policy.publishVersion(
      'cookie_policy',
      { title: 'Cookies', body_md: '# Cookies', is_required: true },
      ADMIN_USER_ID,
    );

    await policy.recordAcceptance(USER_ID, TENANT_ID, 'cookie_policy', 1);
    await policy.recordAcceptance(USER_ID, TENANT_ID, 'cookie_policy', 1);
    await policy.recordAcceptance(USER_ID, TENANT_ID, 'cookie_policy', 1);
    expect(acceptances).toHaveLength(1);
  });

  it('recordAcceptance rejects a (slug, version) tuple that has no published row', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    await expect(
      policy.recordAcceptance(USER_ID, TENANT_ID, 'never_published', 1),
    ).rejects.toMatchObject({ code: 'POLICY_VERSION_NOT_FOUND' });
  });

  it('non-required slugs do not appear in pendingForUser', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    await policy.publishVersion(
      'subprocessors',
      { title: 'Sub-processors', body_md: '# List', is_required: false },
      ADMIN_USER_ID,
    );
    const pending = await policy.pendingForUser(USER_ID, TENANT_ID);
    expect(pending).toHaveLength(0);
  });

  it('publishVersion validates input and rejects empty fields', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    await expect(
      policy.publishVersion('', { title: 'x', body_md: 'y', is_required: true }, ADMIN_USER_ID),
    ).rejects.toMatchObject({ code: 'INVALID_SLUG' });
    await expect(
      policy.publishVersion('terms_of_service', { title: '', body_md: 'y', is_required: true }, ADMIN_USER_ID),
    ).rejects.toMatchObject({ code: 'INVALID_TITLE' });
    await expect(
      policy.publishVersion('terms_of_service', { title: 'x', body_md: '', is_required: true }, ADMIN_USER_ID),
    ).rejects.toMatchObject({ code: 'INVALID_BODY' });
  });

  it('placeholder marker bubbles through to is_placeholder', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    await policy.publishVersion(
      'dpa',
      { title: 'DPA', body_md: '# DPA\n[XRAY-POLICY-PLACEHOLDER] tbd', is_required: true },
      ADMIN_USER_ID,
    );
    const latest = await policy.getLatest('dpa');
    expect(latest!.is_placeholder).toBe(true);

    // Publishing a real v2 strips the marker → is_placeholder=false.
    await policy.publishVersion(
      'dpa',
      { title: 'DPA', body_md: '# DPA\nReal copy.', is_required: true },
      ADMIN_USER_ID,
    );
    const latest2 = await policy.getLatest('dpa');
    expect(latest2!.is_placeholder).toBe(false);
  });

  it('listMyAcceptances returns the user\'s acceptance history newest-first', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);

    const policy = await import('./policy.service');
    await policy.publishVersion(
      'acceptable_use',
      { title: 'AUP', body_md: '# AUP', is_required: true },
      ADMIN_USER_ID,
    );
    await policy.recordAcceptance(USER_ID, TENANT_ID, 'acceptable_use', 1);
    const history = await policy.listMyAcceptances(USER_ID, TENANT_ID);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ slug: 'acceptable_use', version: 1 });
  });

  it('setRequired toggles is_required on the latest version without bumping', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);
    const policy = await import('./policy.service');

    const v1 = await policy.publishVersion(
      'subprocessors',
      { title: 'Sub-processors', body_md: '# List', is_required: true },
      ADMIN_USER_ID,
    );
    expect(v1.is_required).toBe(true);

    // Toggle off — version stays at 1.
    const flipped = await policy.setRequired('subprocessors', false, ADMIN_USER_ID);
    expect(flipped.is_required).toBe(false);
    expect(flipped.version).toBe(1);

    // Re-read latest — confirms persistence + the slug no longer
    // appears in pendingForUser when not accepted.
    const latest = await policy.getLatest('subprocessors');
    expect(latest!.is_required).toBe(false);

    const pending = await policy.pendingForUser(USER_ID, TENANT_ID);
    expect(pending.find((p) => p.slug === 'subprocessors')).toBeUndefined();

    // Flip back on — pendingForUser now surfaces it.
    await policy.setRequired('subprocessors', true, ADMIN_USER_ID);
    const pending2 = await policy.pendingForUser(USER_ID, TENANT_ID);
    expect(pending2.find((p) => p.slug === 'subprocessors')).toBeDefined();
  });

  it('setRequired throws LEGAL_SLUG_NOT_FOUND for an unknown slug', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeFakePool();
    __setPoolForTest(pool);
    const policy = await import('./policy.service');
    await expect(
      policy.setRequired('never_published', true, ADMIN_USER_ID),
    ).rejects.toMatchObject({ code: 'LEGAL_SLUG_NOT_FOUND' });
  });
});
