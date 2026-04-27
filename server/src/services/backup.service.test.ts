import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Specs for backup.service. Two surfaces:
//
//   - Filesystem readers (getBackupStatus) — exercised against a
//     temp-dir scaffolded to look like the pg_backups volume layout
//     (base/<TS>/, wal/<segment>). BACKUPS_ROOT env var swaps the
//     mount point so the service points at our temp dir.
//
//   - DB readers (listDrillRuns / getDrillRun / logDrillRun) — fake
//     pg.Pool injected via db/connection.__setPoolForTest. Mirrors
//     the pattern in policy.service.test.ts.

beforeAll(() => {
  process.env.DATABASE_URL ||= 'postgres://stub';
  process.env.JWT_SECRET ||= 'test-jwt-secret';
  process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
});

interface DrillRow {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  exit_code: number | null;
  base_used: string | null;
  target_time: Date | null;
  from_s3: boolean;
  schema_check_ok: boolean | null;
  smoke_query_rows: number | null;
  tarball_sha256: string | null;
  output: string | null;
  triggered_by: string;
  user_id: string | null;
  user_email: string | null;
}

function makeDrillPool() {
  const rows: DrillRow[] = [];

  const client = {
    query: (sql: string, params?: unknown[]) => {
      const s = sql.trim();
      const ps = (params || []) as any[];

      // set_config — RLS context plumbing, no-op for the fake.
      if (s.startsWith('SELECT set_config')) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      // INSERT into backup_drill_runs
      if (s.startsWith('INSERT INTO platform.backup_drill_runs')) {
        const id = `drill-${rows.length + 1}`;
        rows.push({
          id,
          started_at: new Date(ps[0]),
          finished_at: ps[1] ? new Date(ps[1]) : null,
          exit_code: ps[2],
          base_used: ps[3],
          target_time: ps[4] ? new Date(ps[4]) : null,
          from_s3: !!ps[5],
          schema_check_ok: ps[6],
          smoke_query_rows: ps[7],
          tarball_sha256: ps[8],
          output: ps[9],
          triggered_by: ps[10],
          user_id: ps[11],
          user_email: null,
        });
        return Promise.resolve({ rows: [{ id }], rowCount: 1 });
      }

      // SELECT … LIMIT $1 (list)
      if (s.startsWith('SELECT d.id') && s.includes('LIMIT $1')) {
        const limit = ps[0] as number;
        const sorted = [...rows].sort(
          (a, b) => b.started_at.getTime() - a.started_at.getTime()
        );
        return Promise.resolve({ rows: sorted.slice(0, limit), rowCount: Math.min(sorted.length, limit) });
      }

      // SELECT … WHERE d.id = $1 (get)
      if (s.startsWith('SELECT d.id') && s.includes('WHERE d.id = $1')) {
        const id = ps[0] as string;
        const found = rows.find((r) => r.id === id);
        return Promise.resolve({
          rows: found ? [found] : [],
          rowCount: found ? 1 : 0,
        });
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
    rows,
  };
}

describe('backup.service — filesystem status', () => {
  let tmpRoot: string;
  let originalEnv: string | undefined;

  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-backup-test-'));
    originalEnv = process.env.BACKUPS_ROOT;
    process.env.BACKUPS_ROOT = tmpRoot;
  });

  afterAll(async () => {
    if (originalEnv === undefined) delete process.env.BACKUPS_ROOT;
    else process.env.BACKUPS_ROOT = originalEnv;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports available=false when the mount is missing', async () => {
    const missing = path.join(tmpRoot, 'does-not-exist');
    process.env.BACKUPS_ROOT = missing;
    // Clear module cache so the new BACKUPS_ROOT is picked up.
    // (The service captures it at import time via the env var.)
    const mod = await import('./backup.service');
    const status = await mod.getBackupStatus();
    expect(status.available).toBe(false);
    expect(status.bases).toEqual([]);
    expect(status.wal.segment_count).toBe(0);
    process.env.BACKUPS_ROOT = tmpRoot;
  });

  it('reports zeros for an empty mount', async () => {
    // Re-point to a fresh empty dir so previous test's scaffolding
    // doesn't leak.
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-backup-empty-'));
    process.env.BACKUPS_ROOT = emptyRoot;
    const mod = await import('./backup.service');
    const status = await mod.getBackupStatus();
    expect(status.available).toBe(true);
    expect(status.bases).toEqual([]);
    expect(status.latest_base).toBeNull();
    expect(status.wal.segment_count).toBe(0);
    expect(status.wal.lag_seconds).toBeNull();
    expect(status.volume.total_bytes).toBe(0);
    process.env.BACKUPS_ROOT = tmpRoot;
    await fs.rm(emptyRoot, { recursive: true, force: true });
  });

  it('aggregates base backups + WAL segments + volume bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xray-backup-full-'));
    await fs.mkdir(path.join(root, 'base', '2026-04-27T10-00-00Z'), { recursive: true });
    await fs.writeFile(path.join(root, 'base', '2026-04-27T10-00-00Z', 'base.tar.gz'), Buffer.alloc(2048));
    await fs.writeFile(path.join(root, 'base', '2026-04-27T10-00-00Z', 'MANIFEST.txt'), 'manifest\n');

    await fs.mkdir(path.join(root, 'base', '2026-04-26T10-00-00Z'), { recursive: true });
    await fs.writeFile(path.join(root, 'base', '2026-04-26T10-00-00Z', 'base.tar.gz'), Buffer.alloc(1024));
    // No MANIFEST.txt for the older one — verify has_manifest=false.

    await fs.mkdir(path.join(root, 'wal'), { recursive: true });
    await fs.writeFile(path.join(root, 'wal', '000000010000000000000001'), Buffer.alloc(16 * 1024 * 1024));
    await fs.writeFile(path.join(root, 'wal', '000000010000000000000002'), Buffer.alloc(16 * 1024 * 1024));

    process.env.BACKUPS_ROOT = root;
    const mod = await import('./backup.service');
    const status = await mod.getBackupStatus();

    expect(status.available).toBe(true);
    expect(status.bases.length).toBe(2);
    // Newest first
    expect(status.bases[0].name).toBe('2026-04-27T10-00-00Z');
    expect(status.bases[0].has_manifest).toBe(true);
    expect(status.bases[1].name).toBe('2026-04-26T10-00-00Z');
    expect(status.bases[1].has_manifest).toBe(false);
    expect(status.latest_base?.name).toBe('2026-04-27T10-00-00Z');

    expect(status.wal.segment_count).toBe(2);
    expect(status.wal.total_size_bytes).toBe(2 * 16 * 1024 * 1024);
    expect(status.wal.newest_segment_at).not.toBeNull();
    expect(status.wal.lag_seconds).not.toBeNull();
    expect((status.wal.lag_seconds as number) >= 0).toBe(true);

    expect(status.volume.total_bytes).toBe(status.volume.base_bytes + status.volume.wal_bytes);
    expect(status.volume.base_bytes).toBeGreaterThanOrEqual(2048 + 1024);

    process.env.BACKUPS_ROOT = tmpRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports S3 config from env vars', async () => {
    const orig: Record<string, string | undefined> = {
      bucket: process.env.BACKUP_S3_BUCKET,
      endpoint: process.env.BACKUP_S3_ENDPOINT,
      region: process.env.BACKUP_S3_REGION,
      retain: process.env.BACKUP_RETAIN_DAYS,
    };
    process.env.BACKUP_S3_BUCKET = 'my-bucket';
    process.env.BACKUP_S3_ENDPOINT = 'https://s3.example';
    process.env.BACKUP_S3_REGION = 'eu-west-1';
    process.env.BACKUP_RETAIN_DAYS = '30';

    const mod = await import('./backup.service');
    const status = await mod.getBackupStatus();
    expect(status.s3.configured).toBe(true);
    expect(status.s3.bucket).toBe('my-bucket');
    expect(status.s3.endpoint).toBe('https://s3.example');
    expect(status.s3.region).toBe('eu-west-1');
    expect(status.s3.retain_days).toBe(30);
    expect(status.retain_days).toBe(30);

    if (orig.bucket === undefined) delete process.env.BACKUP_S3_BUCKET;
    else process.env.BACKUP_S3_BUCKET = orig.bucket;
    if (orig.endpoint === undefined) delete process.env.BACKUP_S3_ENDPOINT;
    else process.env.BACKUP_S3_ENDPOINT = orig.endpoint;
    if (orig.region === undefined) delete process.env.BACKUP_S3_REGION;
    else process.env.BACKUP_S3_REGION = orig.region;
    if (orig.retain === undefined) delete process.env.BACKUP_RETAIN_DAYS;
    else process.env.BACKUP_RETAIN_DAYS = orig.retain;
  });

  it('reports configured=false when BACKUP_S3_BUCKET is missing', async () => {
    const orig = process.env.BACKUP_S3_BUCKET;
    delete process.env.BACKUP_S3_BUCKET;
    const mod = await import('./backup.service');
    const status = await mod.getBackupStatus();
    expect(status.s3.configured).toBe(false);
    expect(status.s3.bucket).toBeNull();
    if (orig !== undefined) process.env.BACKUP_S3_BUCKET = orig;
  });
});

describe('backup.service — drill history', () => {
  beforeEach(async () => {
    const { __setPoolForTest } = await import('../db/connection');
    __setPoolForTest(null);
  });

  it('logDrillRun inserts a row and returns the new id', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool, rows } = makeDrillPool();
    __setPoolForTest(pool);

    const mod = await import('./backup.service');
    const result = await mod.logDrillRun({
      started_at: '2026-04-27T15:00:00.000Z',
      finished_at: '2026-04-27T15:02:34.000Z',
      exit_code: 0,
      base_used: '2026-04-27T10-00-00Z',
      from_s3: false,
      schema_check_ok: true,
      smoke_query_rows: 12,
      tarball_sha256: 'abc',
      output: 'PROBE PASS',
      triggered_by: 'cron',
    });
    expect(result.id).toBe('drill-1');
    expect(rows.length).toBe(1);
    expect(rows[0].triggered_by).toBe('cron');
    expect(rows[0].schema_check_ok).toBe(true);
  });

  it('listDrillRuns returns rows newest-first with truncated output preview', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeDrillPool();
    __setPoolForTest(pool);

    const mod = await import('./backup.service');
    await mod.logDrillRun({
      started_at: '2026-04-26T10:00:00.000Z',
      exit_code: 0,
      output: 'older drill',
      triggered_by: 'cron',
    });
    await mod.logDrillRun({
      started_at: '2026-04-27T10:00:00.000Z',
      exit_code: 1,
      output: 'x'.repeat(8 * 1024),
      triggered_by: 'admin_ui',
      user_id: '99999999-9999-9999-9999-999999999999',
    });

    const list = await mod.listDrillRuns();
    expect(list.length).toBe(2);
    // Newest first
    expect(list[0].started_at).toBe('2026-04-27T10:00:00.000Z');
    expect(list[0].exit_code).toBe(1);
    // Long output gets truncated in the listing
    expect(list[0].output_preview.length).toBeLessThan(8 * 1024);
    expect(list[0].output_preview.endsWith('[truncated]')).toBe(true);
    // Older one fits under the cap
    expect(list[1].output_preview).toBe('older drill');
  });

  it('caps logged output at 1MB', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool, rows } = makeDrillPool();
    __setPoolForTest(pool);

    const mod = await import('./backup.service');
    const huge = 'a'.repeat(2 * 1024 * 1024);
    await mod.logDrillRun({
      started_at: new Date().toISOString(),
      exit_code: 0,
      output: huge,
      triggered_by: 'operator',
    });
    expect(rows[0].output!.length).toBeLessThan(2 * 1024 * 1024);
    expect(rows[0].output!).toMatch(/\[truncated at 1048576 bytes\]$/);
  });

  it('getDrillRun returns full output (no truncation) for the single-row endpoint', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeDrillPool();
    __setPoolForTest(pool);

    const mod = await import('./backup.service');
    const big = 'y'.repeat(8 * 1024);
    const { id } = await mod.logDrillRun({
      started_at: new Date().toISOString(),
      exit_code: 0,
      output: big,
      triggered_by: 'admin_ui',
    });
    const run = await mod.getDrillRun(id);
    expect(run).not.toBeNull();
    expect(run?.output_preview).toBe(big);
  });

  it('getDrillRun returns null when the id does not exist', async () => {
    const { __setPoolForTest } = await import('../db/connection');
    const { pool } = makeDrillPool();
    __setPoolForTest(pool);

    const mod = await import('./backup.service');
    const run = await mod.getDrillRun('missing-id');
    expect(run).toBeNull();
  });
});
