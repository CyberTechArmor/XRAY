import * as fs from 'fs/promises';
import * as path from 'path';
import { getSetting, updateSettings } from './settings.service';

// Reads pipeline-schema templates that ship with the server image
// (baked in via the Dockerfile COPY) and tracks which version of
// each one the operator has applied to their pipeline DB.
//
// Per-integration files (housecall_pro.sql, quickbooks.sql, …) are
// NOT in scope here — those are operator-managed and live outside
// the platform repo. Only cross-integration / global templates
// (globals.sql) ship with the platform and need version tracking.

const SCHEMAS_DIR =
  process.env.PIPELINE_SCHEMAS_DIR || path.join(process.cwd(), 'scripts/pipeline-schemas');

const VERSION_HEADER_RE = /^--\s*globals_schema_version:\s*(\S+)\s*$/m;
const APPLIED_SETTING_KEY = 'globals_schema_version_applied';

export interface GlobalsSchemaInfo {
  current_version: string | null;     // parsed from the .sql file header
  applied_version: string | null;     // from platform_settings; null if never applied
  needs_update: boolean;              // true when current != applied
  sql: string;                        // the full file contents for copy/paste
}

async function readGlobalsSql(): Promise<{ sql: string; version: string | null }> {
  const filePath = path.join(SCHEMAS_DIR, 'globals.sql');
  const sql = await fs.readFile(filePath, 'utf8');
  const match = sql.match(VERSION_HEADER_RE);
  return { sql, version: match ? match[1] : null };
}

export async function getGlobalsSchemaInfo(): Promise<GlobalsSchemaInfo> {
  const [{ sql, version }, applied] = await Promise.all([
    readGlobalsSql(),
    getSetting(APPLIED_SETTING_KEY),
  ]);
  return {
    current_version: version,
    applied_version: applied,
    needs_update: !!version && applied !== version,
    sql,
  };
}

// Records that the operator has applied a specific version of
// globals.sql to their pipeline DB. Called from the admin UI's
// "Mark as applied" button. Defensive: if the version doesn't
// match the file's current header, reject — protects against
// stale-tab clicks recording a version that's already superseded.
export async function markGlobalsSchemaApplied(
  version: string,
  userId: string | null,
): Promise<{ applied_version: string }> {
  const { version: current } = await readGlobalsSql();
  if (!current) {
    throw new Error('globals.sql has no version header — cannot mark applied');
  }
  if (version !== current) {
    throw new Error(
      `Version mismatch: tried to mark "${version}" applied but the current globals.sql is "${current}". Reload the admin view.`,
    );
  }
  await updateSettings({ [APPLIED_SETTING_KEY]: version }, userId);
  return { applied_version: version };
}

// ── Initial setup tracking ──────────────────────────────────────
//
// Operator runs the bootstrap script ONCE per XRay deployment to
// stand up a fresh pipeline DB (CREATE DATABASE + pipeline_user role
// + globals schema + helper). The Admin → Pipeline "Initial setup"
// card generates the SQL with a fresh password client-side and
// shows it once. After running it, the operator clicks "Mark as
// initialized" — that POST hits markInitialSetupApplied below,
// which records the timestamp + chosen DB name in platform_settings.
//
// Tracking is purely a UX convenience — XRay never connects to the
// pipeline DB, so there's nothing to verify on the server side. The
// stored values let the card render in a "completed" state on
// subsequent visits instead of looking like first-deployment again.
// Passwords are NEVER stored.

const INITIAL_APPLIED_AT_KEY = 'pipeline_initial_setup_applied_at';
const INITIAL_DB_NAME_KEY    = 'pipeline_initial_setup_db_name';
const DB_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/i;

export interface InitialSetupStatus {
  applied_at: string | null;   // ISO timestamp; null if never marked
  db_name: string | null;      // the name the operator entered
}

export async function getInitialSetupStatus(): Promise<InitialSetupStatus> {
  const [appliedAt, dbName] = await Promise.all([
    getSetting(INITIAL_APPLIED_AT_KEY),
    getSetting(INITIAL_DB_NAME_KEY),
  ]);
  return { applied_at: appliedAt, db_name: dbName };
}

export async function markInitialSetupApplied(
  dbName: string,
  userId: string | null,
): Promise<InitialSetupStatus> {
  if (!DB_NAME_RE.test(dbName)) {
    throw new Error(
      `Invalid db_name "${dbName}" — must be alphanumeric / underscore, start with a letter, max 63 chars (postgres identifier limit).`,
    );
  }
  const appliedAt = new Date().toISOString();
  await updateSettings(
    { [INITIAL_APPLIED_AT_KEY]: appliedAt, [INITIAL_DB_NAME_KEY]: dbName },
    userId,
  );
  return { applied_at: appliedAt, db_name: dbName };
}
