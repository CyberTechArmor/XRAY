import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import { withAdminClient } from '../db/connection';
import type { PoolClient } from '../db/connection';

// Mount point for the pg_backups named volume inside the server
// container. Compose-mounted read-only — see docker-compose.yml.
// Falls back to a sensible default if the mount is missing so the
// admin view degrades to "(no data)" instead of throwing on every
// page load. Read on every call (not cached at module load) so tests
// can swap mounts via process.env.BACKUPS_ROOT without resetting
// modules.
function backupsRoot(): string {
  return process.env.BACKUPS_ROOT || '/var/lib/postgresql/backups';
}
function baseDir(): string {
  return path.join(backupsRoot(), 'base');
}
function walDir(): string {
  return path.join(backupsRoot(), 'wal');
}

// Hard cap on how much drill output we render in history JSON. Full
// output stays in the DB; the API surface caps so a runaway drill
// can't blow past Express's response size for the listing endpoint.
const DRILL_OUTPUT_PREVIEW_BYTES = 4 * 1024;

export interface BaseBackupSummary {
  name: string;          // directory name, typically a UTC ISO timestamp
  size_bytes: number;    // sum of contents
  created_at: string | null;  // mtime of the base dir, ISO
  has_manifest: boolean; // MANIFEST.txt present?
}

export interface WalArchiveSummary {
  segment_count: number;
  total_size_bytes: number;
  newest_segment_at: string | null;  // mtime of newest .ready file, ISO
  lag_seconds: number | null;        // now - newest_segment_at; null if no segments
}

export interface S3Config {
  configured: boolean;          // BACKUP_S3_BUCKET is set + non-empty
  bucket: string | null;
  endpoint: string | null;      // null → default AWS S3
  region: string | null;
  prefix: string | null;
  retain_days: number | null;
}

export interface VolumeUsage {
  total_bytes: number;          // sum across base + wal
  base_bytes: number;
  wal_bytes: number;
}

export interface BackupStatus {
  available: boolean;           // false → mount missing or unreadable
  bases: BaseBackupSummary[];   // newest first; empty if no backups yet
  latest_base: BaseBackupSummary | null;
  wal: WalArchiveSummary;
  volume: VolumeUsage;
  s3: S3Config;
  retain_days: number | null;
}

export interface DrillRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  base_used: string | null;
  target_time: string | null;
  from_s3: boolean;
  schema_check_ok: boolean | null;
  smoke_query_rows: number | null;
  tarball_sha256: string | null;
  output_preview: string;       // truncated; full output via /drill/:id
  triggered_by: string;
  user_id: string | null;
  user_email: string | null;
}

// Sum file sizes recursively under a directory. Returns 0 if the
// directory doesn't exist (graceful — the volume may be empty on
// first deploy). Symlinks aren't followed; we only count real files.
async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      total += await dirSizeBytes(full);
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(full);
        total += st.size;
      } catch {
        // file disappeared mid-scan (e.g. backup script deleting old
        // segments while we read) — skip rather than fail the whole
        // status fetch.
      }
    }
  }
  return total;
}

async function readBaseBackups(): Promise<BaseBackupSummary[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(baseDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const summaries = await Promise.all(
    dirs.map(async (name): Promise<BaseBackupSummary> => {
      const full = path.join(baseDir(), name);
      const [size, st, manifestExists] = await Promise.all([
        dirSizeBytes(full),
        fs.stat(full).catch(() => null),
        fs
          .access(path.join(full, 'MANIFEST.txt'))
          .then(() => true)
          .catch(() => false),
      ]);
      return {
        name,
        size_bytes: size,
        created_at: st ? st.mtime.toISOString() : null,
        has_manifest: manifestExists,
      };
    })
  );
  // Sort newest first by created_at; fall back to name (lexicographic
  // works for the UTC-ISO naming scheme backup-platform.sh uses).
  summaries.sort((a, b) => {
    const ad = a.created_at || '';
    const bd = b.created_at || '';
    if (ad === bd) return b.name.localeCompare(a.name);
    return bd.localeCompare(ad);
  });
  return summaries;
}

async function readWalSummary(): Promise<WalArchiveSummary> {
  const empty: WalArchiveSummary = {
    segment_count: 0,
    total_size_bytes: 0,
    newest_segment_at: null,
    lag_seconds: null,
  };
  let entries: Dirent[];
  try {
    entries = await fs.readdir(walDir(), { withFileTypes: true });
  } catch {
    return empty;
  }
  const segments = entries.filter((e) => e.isFile());
  if (segments.length === 0) return empty;

  let total = 0;
  let newestMs = 0;
  for (const s of segments) {
    try {
      const st = await fs.stat(path.join(walDir(), s.name));
      total += st.size;
      const mtime = st.mtime.getTime();
      if (mtime > newestMs) newestMs = mtime;
    } catch {
      // segment vanished mid-scan; skip.
    }
  }
  const newestIso = newestMs > 0 ? new Date(newestMs).toISOString() : null;
  const lagSec = newestMs > 0 ? Math.max(0, Math.round((Date.now() - newestMs) / 1000)) : null;
  return {
    segment_count: segments.length,
    total_size_bytes: total,
    newest_segment_at: newestIso,
    lag_seconds: lagSec,
  };
}

function readS3Config(): S3Config {
  const bucket = (process.env.BACKUP_S3_BUCKET || '').trim();
  const configured = bucket.length > 0;
  const retainStr = (process.env.BACKUP_RETAIN_DAYS || '').trim();
  const retainDays = retainStr ? parseInt(retainStr, 10) : null;
  return {
    configured,
    bucket: configured ? bucket : null,
    endpoint: (process.env.BACKUP_S3_ENDPOINT || '').trim() || null,
    region: (process.env.BACKUP_S3_REGION || '').trim() || null,
    prefix: (process.env.BACKUP_S3_PREFIX || '').trim() || null,
    retain_days: Number.isFinite(retainDays as number) ? (retainDays as number) : null,
  };
}

export async function getBackupStatus(): Promise<BackupStatus> {
  // Probe the mount root once. If the directory isn't there at all
  // (first deploy before the volume materialised, or operator hasn't
  // pulled the docker-compose change yet), return available=false so
  // the UI renders an explicit "no data" state instead of empty.
  let mountReachable = true;
  try {
    await fs.access(backupsRoot());
  } catch {
    mountReachable = false;
  }

  if (!mountReachable) {
    return {
      available: false,
      bases: [],
      latest_base: null,
      wal: {
        segment_count: 0,
        total_size_bytes: 0,
        newest_segment_at: null,
        lag_seconds: null,
      },
      volume: { total_bytes: 0, base_bytes: 0, wal_bytes: 0 },
      s3: readS3Config(),
      retain_days: null,
    };
  }

  const [bases, wal, baseBytes, walBytes] = await Promise.all([
    readBaseBackups(),
    readWalSummary(),
    dirSizeBytes(baseDir()),
    dirSizeBytes(walDir()),
  ]);
  const s3 = readS3Config();
  return {
    available: true,
    bases,
    latest_base: bases[0] || null,
    wal,
    volume: {
      total_bytes: baseBytes + walBytes,
      base_bytes: baseBytes,
      wal_bytes: walBytes,
    },
    s3,
    retain_days: s3.retain_days,
  };
}

interface DrillRunRow {
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

function rowToDrillRun(row: DrillRunRow): DrillRun {
  const output = row.output || '';
  const preview =
    output.length > DRILL_OUTPUT_PREVIEW_BYTES
      ? output.slice(0, DRILL_OUTPUT_PREVIEW_BYTES) + '\n…[truncated]'
      : output;
  return {
    id: row.id,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    exit_code: row.exit_code,
    base_used: row.base_used,
    target_time: row.target_time ? row.target_time.toISOString() : null,
    from_s3: row.from_s3,
    schema_check_ok: row.schema_check_ok,
    smoke_query_rows: row.smoke_query_rows,
    tarball_sha256: row.tarball_sha256,
    output_preview: preview,
    triggered_by: row.triggered_by,
    user_id: row.user_id,
    user_email: row.user_email,
  };
}

export async function listDrillRuns(limit = 25): Promise<DrillRun[]> {
  const cap = Math.max(1, Math.min(100, Math.floor(limit)));
  return withAdminClient(async (client: PoolClient) => {
    const result = await client.query<DrillRunRow>(
      `SELECT d.id, d.started_at, d.finished_at, d.exit_code,
              d.base_used, d.target_time, d.from_s3,
              d.schema_check_ok, d.smoke_query_rows, d.tarball_sha256,
              d.output, d.triggered_by, d.user_id,
              u.email AS user_email
         FROM platform.backup_drill_runs d
         LEFT JOIN platform.users u ON u.id = d.user_id
        ORDER BY d.started_at DESC
        LIMIT $1`,
      [cap]
    );
    return result.rows.map(rowToDrillRun);
  });
}

export async function getDrillRun(id: string): Promise<DrillRun | null> {
  return withAdminClient(async (client: PoolClient) => {
    const result = await client.query<DrillRunRow>(
      `SELECT d.id, d.started_at, d.finished_at, d.exit_code,
              d.base_used, d.target_time, d.from_s3,
              d.schema_check_ok, d.smoke_query_rows, d.tarball_sha256,
              d.output, d.triggered_by, d.user_id,
              u.email AS user_email
         FROM platform.backup_drill_runs d
         LEFT JOIN platform.users u ON u.id = d.user_id
        WHERE d.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return null;
    // For the single-run endpoint we return the FULL output (no
    // preview cap) so the operator can read the entire log.
    const row = result.rows[0];
    const full = rowToDrillRun(row);
    full.output_preview = row.output || '';
    return full;
  });
}

export interface DrillLogInput {
  started_at: string;          // ISO
  finished_at?: string | null; // ISO or null/undefined
  exit_code: number;
  base_used?: string | null;
  target_time?: string | null;
  from_s3?: boolean;
  schema_check_ok?: boolean | null;
  smoke_query_rows?: number | null;
  tarball_sha256?: string | null;
  output: string;
  triggered_by: 'cron' | 'operator' | 'admin_ui';
  user_id?: string | null;
}

// Cap stored drill output so a runaway / 100k-line script doesn't
// turn one row into a multi-megabyte blob. Big enough for any
// realistic restore drill.
const MAX_DRILL_OUTPUT_BYTES = 1024 * 1024;

export async function logDrillRun(input: DrillLogInput): Promise<{ id: string }> {
  const output =
    input.output.length > MAX_DRILL_OUTPUT_BYTES
      ? input.output.slice(0, MAX_DRILL_OUTPUT_BYTES) +
        `\n…[truncated at ${MAX_DRILL_OUTPUT_BYTES} bytes]`
      : input.output;
  return withAdminClient(async (client: PoolClient) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO platform.backup_drill_runs
         (started_at, finished_at, exit_code, base_used, target_time,
          from_s3, schema_check_ok, smoke_query_rows, tarball_sha256,
          output, triggered_by, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        input.started_at,
        input.finished_at ?? null,
        input.exit_code,
        input.base_used ?? null,
        input.target_time ?? null,
        input.from_s3 ?? false,
        input.schema_check_ok ?? null,
        input.smoke_query_rows ?? null,
        input.tarball_sha256 ?? null,
        output,
        input.triggered_by,
        input.user_id ?? null,
      ]
    );
    return { id: result.rows[0].id };
  });
}
