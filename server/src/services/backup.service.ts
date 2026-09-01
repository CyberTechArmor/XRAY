import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import { withAdminClient } from '../db/connection';
import type { PoolClient } from '../db/connection';
import { getSetting } from './settings.service';

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

// Postgres writes every WAL segment at a fixed 16 MB, padded, no
// matter how little real change it carries. Combined with
// archive_timeout=300 (docker-compose.yml) — which force-switches a
// segment every five minutes of activity — a near-idle deployment
// still lands dozens of full-size 16 MB files a day in the archive.
// This is the multiplier behind "why is it so big already".
const WAL_SEGMENT_BYTES = 16 * 1024 * 1024;

// Default applied by scripts/backup-platform.sh when BACKUP_RETAIN_DAYS
// is unset. Mirrored here purely so the UI can report the effective
// value; the scripts remain the source of truth.
const DEFAULT_RETAIN_DAYS = 14;

// A base backup finishes some time after it starts, and the WAL it
// needs begins at its START WAL LOCATION. The status view estimates
// "prunable" from directory mtimes (finish time), so it backs off by
// this margin to stay on the conservative side of the real cutoff.
// The authoritative cutoff lives in scripts/prune-wal.sh, which reads
// the START WAL LOCATION out of the backup's own backup_label.
const PRUNE_ESTIMATE_MARGIN_MS = 60 * 60 * 1000;

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
  oldest_segment_at: string | null;  // mtime of oldest segment, ISO
  lag_seconds: number | null;        // now - newest_segment_at; null if no segments
  // Bytes/day the archive has accrued, averaged over oldest→newest.
  // null when the archive spans less than an hour (no meaningful rate).
  est_daily_bytes: number | null;
  // What a prune would free RIGHT NOW, estimated. null when there is
  // no base backup at all — in that state nothing is prunable, which
  // is a different and much worse condition than "nothing to prune".
  // See buildIssues(). scripts/prune-wal.sh computes the exact cutoff
  // from the base's backup_label; this is a UI estimate only.
  prunable_estimate_bytes: number | null;
  prunable_estimate_segments: number | null;
}

// pg_stat_archiver, surfaced so the UI can tell apart the two very
// different reasons the newest archived segment can be hours old:
//
//   - the database is simply idle (no WAL to archive) — benign
//   - archive_command is failing — Postgres retries the same segment
//     forever and pg_wal inside the DB volume grows until the disk
//     fills, taking the database down with it
//
// The "WAL lag" number alone cannot distinguish those, so on its own
// it is alarming without being actionable.
export interface ArchiverHealth {
  available: boolean;               // false → view unreadable (permissions)
  archived_count: number | null;
  last_archived_wal: string | null;
  last_archived_at: string | null;
  failed_count: number | null;
  last_failed_wal: string | null;
  last_failed_at: string | null;
  failing: boolean;                 // last failure is newer than last success
}

// One finding about the state of the backup volume, rendered by the
// Backups admin view. Ordered most severe first by buildIssues().
export interface BackupIssue {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  remedy: string;
}

export interface S3Config {
  configured: boolean;          // BACKUP_S3_BUCKET is set + non-empty
  bucket: string | null;
  endpoint: string | null;      // null → default AWS S3
  region: string | null;
  prefix: string | null;
  access_key_id: string | null; // not secret — operator can rotate via UI
  secret_set: boolean;          // BACKUP_S3_SECRET_ACCESS_KEY env var is set
                                // (the secret value never leaves the server;
                                // the boolean tells the admin UI whether to
                                // render "configured" vs. "not yet provided")
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
  // Effective retention actually used by the scripts when
  // BACKUP_RETAIN_DAYS / the platform_settings row is unset. Kept
  // separate from retain_days so the UI can show "unset (14 default)"
  // rather than a bare "unset" that reads like "no retention at all".
  effective_retain_days: number;
  archiver: ArchiverHealth;
  issues: BackupIssue[];
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
  // Sort newest first by directory name. backup-platform.sh names
  // every base after a UTC timestamp (YYYYMMDDTHHMMSSZ-ish), so
  // lexicographic descending IS chronological descending. We
  // deliberately do NOT sort by created_at: filesystem mtimes can
  // be unstable across docker bind mounts, network FS, and CI
  // environments (mkdir-then-touch races, ext4 noatime, etc.). Name
  // ordering is deterministic regardless of where the volume lives.
  summaries.sort((a, b) => b.name.localeCompare(a.name));
  return summaries;
}

const EMPTY_WAL_SUMMARY: WalArchiveSummary = {
  segment_count: 0,
  total_size_bytes: 0,
  newest_segment_at: null,
  oldest_segment_at: null,
  lag_seconds: null,
  est_daily_bytes: null,
  prunable_estimate_bytes: null,
  prunable_estimate_segments: null,
};

// Scan the archive once and summarise it.
//
// `anchorMs` is the mtime of the OLDEST base backup we still hold, or
// null when there are none. Segments written before that point can
// never be replayed onto any base we keep, so they are prunable; the
// rest may be required to bring the oldest base to consistency and
// must not be touched. Passing null means "no anchor exists", which
// leaves prunable_estimate_* null rather than zero — the difference
// between "nothing to reclaim" and "nothing CAN be reclaimed, because
// there is no recovery point at all" matters, and the UI says so.
async function readWalSummary(anchorMs: number | null): Promise<WalArchiveSummary> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(walDir(), { withFileTypes: true });
  } catch {
    return { ...EMPTY_WAL_SUMMARY };
  }
  const segments = entries.filter((e) => e.isFile());
  if (segments.length === 0) return { ...EMPTY_WAL_SUMMARY };

  const cutoffMs = anchorMs === null ? null : anchorMs - PRUNE_ESTIMATE_MARGIN_MS;

  let total = 0;
  let newestMs = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let prunableBytes = 0;
  let prunableCount = 0;
  let counted = 0;
  for (const seg of segments) {
    try {
      const st = await fs.stat(path.join(walDir(), seg.name));
      total += st.size;
      counted++;
      const mtime = st.mtime.getTime();
      if (mtime > newestMs) newestMs = mtime;
      if (mtime < oldestMs) oldestMs = mtime;
      if (cutoffMs !== null && mtime < cutoffMs) {
        prunableBytes += st.size;
        prunableCount++;
      }
    } catch {
      // segment vanished mid-scan; skip.
    }
  }
  if (counted === 0) return { ...EMPTY_WAL_SUMMARY };

  const newestIso = newestMs > 0 ? new Date(newestMs).toISOString() : null;
  const oldestIso = Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null;
  const lagSec = newestMs > 0 ? Math.max(0, Math.round((Date.now() - newestMs) / 1000)) : null;

  // Growth rate over the span the archive actually covers. Below an
  // hour of span the divisor is noise, so report null instead of an
  // extrapolation nobody should act on.
  const spanMs = newestMs - oldestMs;
  const estDaily =
    spanMs >= 60 * 60 * 1000 ? Math.round(total / (spanMs / 86_400_000)) : null;

  return {
    segment_count: counted,
    total_size_bytes: total,
    newest_segment_at: newestIso,
    oldest_segment_at: oldestIso,
    lag_seconds: lagSec,
    est_daily_bytes: estDaily,
    prunable_estimate_bytes: cutoffMs === null ? null : prunableBytes,
    prunable_estimate_segments: cutoffMs === null ? null : prunableCount,
  };
}

// pg_stat_archiver is world-readable in Postgres, but the app connects
// as a deliberately unprivileged role and the view could be revoked on
// a hardened install. Any failure degrades to available:false so the
// Backups page still renders — a diagnostic panel must never be the
// thing that takes the page down.
async function readArchiverHealth(): Promise<ArchiverHealth> {
  const unavailable: ArchiverHealth = {
    available: false,
    archived_count: null,
    last_archived_wal: null,
    last_archived_at: null,
    failed_count: null,
    last_failed_wal: null,
    last_failed_at: null,
    failing: false,
  };
  try {
    return await withAdminClient(async (client: PoolClient) => {
      const r = await client.query<{
        archived_count: string | null;
        last_archived_wal: string | null;
        last_archived_time: Date | null;
        failed_count: string | null;
        last_failed_wal: string | null;
        last_failed_time: Date | null;
      }>(
        `SELECT archived_count, last_archived_wal, last_archived_time,
                failed_count, last_failed_wal, last_failed_time
           FROM pg_stat_archiver`
      );
      if (r.rows.length === 0) return unavailable;
      const row = r.rows[0];
      const lastOk = row.last_archived_time ? row.last_archived_time.getTime() : 0;
      const lastBad = row.last_failed_time ? row.last_failed_time.getTime() : 0;
      return {
        available: true,
        archived_count: row.archived_count === null ? null : Number(row.archived_count),
        last_archived_wal: row.last_archived_wal,
        last_archived_at: row.last_archived_time ? row.last_archived_time.toISOString() : null,
        failed_count: row.failed_count === null ? null : Number(row.failed_count),
        last_failed_wal: row.last_failed_wal,
        last_failed_at: row.last_failed_time ? row.last_failed_time.toISOString() : null,
        // A failure newer than the last success means the archiver is
        // stuck on a segment right now, not that it hiccuped once
        // months ago. Only the former is actionable.
        failing: lastBad > 0 && lastBad > lastOk,
      };
    });
  } catch {
    return unavailable;
  }
}

// S3 config keys in platform_settings (Phase C). DB rows take
// precedence over env vars so operators can change bucket/region/etc.
// from Admin → Backups without a server restart. The actual SECRET
// access key stays in .env (BACKUP_S3_SECRET_ACCESS_KEY) — encrypting
// it in DB and decrypting from inside the bash worker is more
// complexity than the rare-rotation use case justifies.
const S3_SETTING_KEYS = {
  bucket: 'backup_s3_bucket',
  endpoint: 'backup_s3_endpoint',
  region: 'backup_s3_region',
  prefix: 'backup_s3_prefix',
  access_key_id: 'backup_s3_access_key_id',
  retain_days: 'backup_retain_days',
} as const;

async function readSettingOrEnv(settingKey: string, envKey: string): Promise<string> {
  const fromDb = await getSetting(settingKey);
  if (fromDb !== null && fromDb !== '') return fromDb;
  return (process.env[envKey] || '').trim();
}

async function readS3Config(): Promise<S3Config> {
  const [bucket, endpoint, region, prefix, accessKeyId, retainStr] = await Promise.all([
    readSettingOrEnv(S3_SETTING_KEYS.bucket, 'BACKUP_S3_BUCKET'),
    readSettingOrEnv(S3_SETTING_KEYS.endpoint, 'BACKUP_S3_ENDPOINT'),
    readSettingOrEnv(S3_SETTING_KEYS.region, 'BACKUP_S3_REGION'),
    readSettingOrEnv(S3_SETTING_KEYS.prefix, 'BACKUP_S3_PREFIX'),
    readSettingOrEnv(S3_SETTING_KEYS.access_key_id, 'BACKUP_S3_ACCESS_KEY_ID'),
    readSettingOrEnv(S3_SETTING_KEYS.retain_days, 'BACKUP_RETAIN_DAYS'),
  ]);
  const configured = bucket.length > 0;
  const retainDays = retainStr ? parseInt(retainStr, 10) : null;
  return {
    configured,
    bucket: configured ? bucket : null,
    endpoint: endpoint || null,
    region: region || null,
    prefix: prefix || null,
    access_key_id: accessKeyId || null,
    // The secret access key never leaves the server. Only the boolean
    // "is it set in env?" is exposed so the admin UI can show
    // configured / not-yet-set state without revealing the value.
    secret_set: !!(process.env.BACKUP_S3_SECRET_ACCESS_KEY || '').trim(),
    retain_days: Number.isFinite(retainDays as number) ? (retainDays as number) : null,
  };
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// Turn the raw numbers into findings an operator can act on.
//
// This exists because the status tiles alone were actively
// misleading: a volume sitting at 24 GB with a red "WAL lag" number
// and a "Latest base: never" tile shows every symptom of the problem
// without ever naming the cause or the fix. The cause is structural,
// not a threshold being crossed, so it needs prose.
//
// Ordered most severe first; the view renders them in order.
function buildIssues(input: {
  bases: BaseBackupSummary[];
  wal: WalArchiveSummary;
  volume: VolumeUsage;
  archiver: ArchiverHealth;
  baseScheduleEnabled: boolean;
  retainDays: number | null;
  effectiveRetainDays: number;
}): BackupIssue[] {
  const { bases, wal, volume, archiver, baseScheduleEnabled, retainDays, effectiveRetainDays } =
    input;
  const issues: BackupIssue[] = [];

  // ── The headline finding on any install that never took a base ──
  // Both halves of this are worth stating plainly: there is no
  // recovery point, AND that is precisely why the volume only ever
  // grows. Operators reading the old UI reasonably concluded the WAL
  // archive was itself a backup. It is not.
  if (bases.length === 0) {
    issues.push({
      id: 'no_base_backup',
      severity: 'critical',
      title: 'No base backup exists — this volume cannot restore the database',
      detail:
        `The WAL archive holds ${wal.segment_count} segments (${fmtBytes(wal.total_size_bytes)}), ` +
        'but WAL is only a change log. It restores nothing on its own: it has to be ' +
        'replayed onto a base backup, and there are none here. ' +
        'That is also why the volume has grown every day since first boot and never ' +
        'shrunk — archived WAL can only be pruned relative to a base backup, so with ' +
        'zero base backups nothing has ever been eligible for deletion. Every segment ' +
        'Postgres has ever archived is still on disk.',
      remedy:
        'Click "Backup now" to create a recovery point, then "Prune WAL" to reclaim ' +
        'everything archived before it — on an install this old that is very nearly the ' +
        'whole archive. Then enable the "Base backup" schedule below (0 2 * * *) so it ' +
        'keeps happening; each run prunes on its way out.',
    });
  }

  // ── Archiver stuck ──
  // Distinct from, and worse than, a large archive: a failing
  // archive_command makes Postgres retry the same segment forever and
  // hold every WAL file in pg_wal inside the DATA volume. That fills
  // the data disk and stops the database.
  if (archiver.available && archiver.failing) {
    issues.push({
      id: 'archiver_failing',
      severity: 'critical',
      title: 'WAL archiving is failing — pg_wal is growing inside the data volume',
      detail:
        `archive_command last failed on segment ${archiver.last_failed_wal || '(unknown)'}` +
        (archiver.last_failed_at ? ` at ${archiver.last_failed_at}` : '') +
        `, after ${archiver.failed_count ?? 0} total failures. Postgres retries a failed ` +
        'segment indefinitely and will not recycle any WAL until it succeeds, so pg_wal ' +
        'inside the pg_data volume grows without bound. If that disk fills, the database ' +
        'stops accepting writes.',
      remedy:
        'Check the postgres container log for the archive_command error. The usual causes ' +
        'are the archive directory being unwritable, or scripts/wal-archive.sh hitting its ' +
        'refuse-to-overwrite guard on a segment name that already exists in the archive.',
    });
  }

  // ── Reclaimable WAL sitting around ──
  if (
    bases.length > 0 &&
    wal.prunable_estimate_bytes !== null &&
    wal.prunable_estimate_bytes > 0
  ) {
    issues.push({
      id: 'wal_prunable',
      severity: 'warning',
      title: `About ${fmtBytes(wal.prunable_estimate_bytes)} of archived WAL is reclaimable`,
      detail:
        `Roughly ${wal.prunable_estimate_segments} segments predate the oldest base backup ` +
        'still held, so no backup on this volume can ever need them. (Estimated from file ' +
        'timestamps — the prune itself uses the exact START WAL LOCATION recorded in the ' +
        'base backup, so the real figure may differ slightly.)',
      remedy: 'Click "Prune WAL". Base backups also prune on their way out.',
    });
  }

  // ── The schedule that would prevent recurrence ──
  if (!baseScheduleEnabled) {
    issues.push({
      id: 'base_schedule_disabled',
      severity: bases.length === 0 ? 'warning' : 'info',
      title: 'The base backup schedule is disabled',
      detail:
        'Schedules ship disabled and this one was never turned on. Nothing creates ' +
        'recovery points automatically, and since the WAL prune runs at the end of a base ' +
        'backup, nothing reclaims archive space automatically either. A one-off "Backup ' +
        'now" fixes today; only the schedule fixes tomorrow.',
      remedy:
        'Enable "Base backup" under Scheduled tasks with 0 2 * * * (daily, 02:00 UTC).',
    });
  }

  // ── Why the number is as big as it is ──
  // Growth here is dominated by segment padding, not by data volume,
  // and that is not obvious from a byte count.
  if (wal.est_daily_bytes !== null && wal.est_daily_bytes > 0) {
    const perMonth = wal.est_daily_bytes * 30;
    const avgSeg = wal.segment_count > 0 ? wal.total_size_bytes / wal.segment_count : 0;
    const padded = avgSeg > WAL_SEGMENT_BYTES * 0.9;
    issues.push({
      id: 'wal_growth_rate',
      severity: 'info',
      title: `WAL archive is growing about ${fmtBytes(wal.est_daily_bytes)}/day (~${fmtBytes(perMonth)}/month)`,
      detail:
        `Measured across the ${wal.segment_count} segments currently held. ` +
        (padded
          ? 'Note that Postgres writes every WAL segment at a fixed 16 MB whether it is ' +
            'full or nearly empty, and archive_timeout=300 forces a segment switch every ' +
            'five minutes of activity. So this figure tracks how often the database is ' +
            'touched, not how much data changed — a lightly used install still writes ' +
            'many full-size 16 MB files a day. '
          : '') +
        'With pruning in place the archive stabilises at roughly one retention window ' +
        `(${effectiveRetainDays} days) instead of growing forever.`,
      remedy:
        'No action needed once base backups and pruning are running — this is the ' +
        'steady-state cost of point-in-time recovery.',
    });
  }

  // ── Retention is implicit ──
  if (retainDays === null) {
    issues.push({
      id: 'retention_unset',
      severity: 'info',
      title: `Retention is unset — the scripts default to ${effectiveRetainDays} days`,
      detail:
        'BACKUP_RETAIN_DAYS is not set and no platform_settings row overrides it, so ' +
        `scripts/backup-platform.sh falls back to ${effectiveRetainDays} days. Retention ` +
        'is applied, just not explicitly chosen.',
      remedy:
        'Set "Retention (days)" in the S3 mirror configuration below to make the window ' +
        'explicit. It governs local base-backup retention too, not only S3.',
    });
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return issues;
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
    const s3 = await readS3Config();
    return {
      available: false,
      bases: [],
      latest_base: null,
      wal: { ...EMPTY_WAL_SUMMARY },
      volume: { total_bytes: 0, base_bytes: 0, wal_bytes: 0 },
      s3,
      retain_days: s3.retain_days,
      effective_retain_days: s3.retain_days ?? DEFAULT_RETAIN_DAYS,
      archiver: await readArchiverHealth(),
      // No mount, no filesystem facts to reason about. The view
      // already renders its own "mount unavailable" state.
      issues: [],
    };
  }

  // Bases first: the oldest one is the anchor the WAL scan needs to
  // work out what is prunable.
  const bases = await readBaseBackups();
  // bases is sorted newest-first by name, so the oldest is last.
  const oldestBase = bases.length > 0 ? bases[bases.length - 1] : null;
  const anchorMs =
    oldestBase && oldestBase.created_at ? new Date(oldestBase.created_at).getTime() : null;

  const [wal, baseBytes, walBytes, archiver, baseSchedule] = await Promise.all([
    readWalSummary(anchorMs),
    dirSizeBytes(baseDir()),
    dirSizeBytes(walDir()),
    readArchiverHealth(),
    getSetting('backup_schedule_base_enabled').catch(() => null),
  ]);
  const s3 = await readS3Config();
  const effectiveRetainDays = s3.retain_days ?? DEFAULT_RETAIN_DAYS;
  const volume = {
    total_bytes: baseBytes + walBytes,
    base_bytes: baseBytes,
    wal_bytes: walBytes,
  };

  return {
    available: true,
    bases,
    latest_base: bases[0] || null,
    wal,
    volume,
    s3,
    retain_days: s3.retain_days,
    effective_retain_days: effectiveRetainDays,
    archiver,
    issues: buildIssues({
      bases,
      wal,
      volume,
      archiver,
      baseScheduleEnabled: baseSchedule === 'true',
      retainDays: s3.retain_days,
      effectiveRetainDays,
    }),
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

// ── Backup jobs queue (Phase B) ──────────────────────────────────
//
// The server enqueues; the backup-worker sidecar polls, claims, runs,
// and writes back. Frontend polls GET /jobs/:id for terminal status.

export type BackupJobKind = 'base' | 's3sync' | 'drill' | 'delete_base' | 'prune_wal';
export type BackupJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BackupJob {
  id: string;
  kind: BackupJobKind;
  status: BackupJobStatus;
  args: Record<string, unknown>;
  exit_code: number | null;
  output: string | null;          // truncated in listing, full in single
  requested_by: string | null;
  requested_by_email: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface BackupJobRow {
  id: string;
  kind: BackupJobKind;
  status: BackupJobStatus;
  args: Record<string, unknown>;
  exit_code: number | null;
  output: string | null;
  requested_by: string | null;
  requested_by_email: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const JOB_OUTPUT_PREVIEW_BYTES = 4 * 1024;

function rowToJob(row: BackupJobRow, fullOutput: boolean): BackupJob {
  const out = row.output || '';
  const output = fullOutput
    ? out
    : out.length > JOB_OUTPUT_PREVIEW_BYTES
      ? out.slice(0, JOB_OUTPUT_PREVIEW_BYTES) + '\n…[truncated]'
      : out;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    args: row.args || {},
    exit_code: row.exit_code,
    output: output || null,
    requested_by: row.requested_by,
    requested_by_email: row.requested_by_email,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at ? row.started_at.toISOString() : null,
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

export interface EnqueueJobInput {
  kind: BackupJobKind;
  args?: Record<string, unknown>;
  requested_by?: string | null;
}

export async function enqueueJob(input: EnqueueJobInput): Promise<BackupJob> {
  const args = input.args || {};
  return withAdminClient(async (client: PoolClient) => {
    const result = await client.query<BackupJobRow>(
      `INSERT INTO platform.backup_jobs (kind, args, requested_by)
       VALUES ($1, $2::jsonb, $3)
       RETURNING id, kind, status, args, exit_code, output,
                 requested_by, NULL::text AS requested_by_email,
                 created_at, started_at, finished_at`,
      [input.kind, JSON.stringify(args), input.requested_by ?? null]
    );
    return rowToJob(result.rows[0], true);
  });
}

export async function getJob(id: string): Promise<BackupJob | null> {
  return withAdminClient(async (client: PoolClient) => {
    const result = await client.query<BackupJobRow>(
      `SELECT j.id, j.kind, j.status, j.args, j.exit_code, j.output,
              j.requested_by, u.email AS requested_by_email,
              j.created_at, j.started_at, j.finished_at
         FROM platform.backup_jobs j
         LEFT JOIN platform.users u ON u.id = j.requested_by
        WHERE j.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return null;
    return rowToJob(result.rows[0], true);
  });
}

export async function listJobs(limit = 25): Promise<BackupJob[]> {
  const cap = Math.max(1, Math.min(100, Math.floor(limit)));
  return withAdminClient(async (client: PoolClient) => {
    const result = await client.query<BackupJobRow>(
      `SELECT j.id, j.kind, j.status, j.args, j.exit_code, j.output,
              j.requested_by, u.email AS requested_by_email,
              j.created_at, j.started_at, j.finished_at
         FROM platform.backup_jobs j
         LEFT JOIN platform.users u ON u.id = j.requested_by
        ORDER BY j.created_at DESC
        LIMIT $1`,
      [cap]
    );
    return result.rows.map((r) => rowToJob(r, false));
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
