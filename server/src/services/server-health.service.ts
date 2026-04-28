import { getSetting } from './settings.service';

// Surfaces deploy-state info the platform admin needs to remember
// to do — specifically, the periodic `NO_CACHE=1 ./update.sh` that
// pulls fresh Alpine CVE patches into the server image.
//
// Routine `./update.sh` runs in cached mode (fast, reuses upstream
// layers); only NO_CACHE=1 forces `apk upgrade --no-cache` to
// re-resolve and pull current OS-level fixes. Without a reminder
// nothing nags the operator into running it on a schedule.
//
// Source of truth: platform_settings keys written by update.sh after
// a successful build (see update.sh step 5). XRay never inspects the
// running container or filesystem; this is purely a record of what
// update.sh said happened.

const KEY_LAST_UPDATE_AT      = 'update_last_run_at';
const KEY_LAST_NO_CACHE_AT    = 'update_last_no_cache_at';
const KEY_LAST_COMMIT_SHA     = 'update_last_commit_sha';
const KEY_LAST_COMMIT_BRANCH  = 'update_last_commit_branch';

// Days since the last NO_CACHE refresh after which we surface a
// "stale" warning in the admin UI. Trivy ships HIGH/CRITICAL CVE
// fixes into Alpine on a roughly weekly cadence; 7 days is the
// natural threshold. Operators can run it more often without
// penalty — the prune step keeps disk under control.
const NO_CACHE_STALE_DAYS = 7;

export interface ServerHealthInfo {
  // Process — read at request time from this node process. Lets the
  // admin see whether the server has been restarted recently and how
  // long it's been live.
  process: {
    started_at: string;        // ISO
    uptime_seconds: number;
    node_version: string;
    pid: number;
  };
  // Update history — written by update.sh into platform_settings.
  // Null on a fresh install before the first update.sh run after
  // this feature lands.
  update: {
    last_run_at: string | null;
    last_no_cache_at: string | null;
    last_commit_sha: string | null;
    last_commit_branch: string | null;
    no_cache_stale: boolean;            // true when last_no_cache_at is null OR > NO_CACHE_STALE_DAYS old
    no_cache_stale_threshold_days: number;
  };
}

export async function getServerHealth(): Promise<ServerHealthInfo> {
  const [lastRunAt, lastNoCacheAt, lastSha, lastBranch] = await Promise.all([
    getSetting(KEY_LAST_UPDATE_AT),
    getSetting(KEY_LAST_NO_CACHE_AT),
    getSetting(KEY_LAST_COMMIT_SHA),
    getSetting(KEY_LAST_COMMIT_BRANCH),
  ]);

  const noCacheStale = isNoCacheStale(lastNoCacheAt);
  const startedAtMs = Date.now() - Math.floor(process.uptime() * 1000);

  return {
    process: {
      started_at: new Date(startedAtMs).toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      node_version: process.version,
      pid: process.pid,
    },
    update: {
      last_run_at: lastRunAt,
      last_no_cache_at: lastNoCacheAt,
      last_commit_sha: lastSha,
      last_commit_branch: lastBranch,
      no_cache_stale: noCacheStale,
      no_cache_stale_threshold_days: NO_CACHE_STALE_DAYS,
    },
  };
}

function isNoCacheStale(iso: string | null): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  const ageMs = Date.now() - t;
  return ageMs > NO_CACHE_STALE_DAYS * 24 * 60 * 60 * 1000;
}
