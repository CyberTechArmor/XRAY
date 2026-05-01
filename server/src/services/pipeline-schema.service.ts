import * as fs from 'fs/promises';
import * as path from 'path';
import { getSetting, updateSettings } from './settings.service';

// Reads pipeline-schema templates that ship with the server image
// (baked in via the Dockerfile COPY) and tracks which version of
// each one the operator has applied to their pipeline DB.
//
// Two kinds of files are tracked:
//
//  - globals.sql                              cross-integration tables
//                                             (e.g. revenue_goals).
//  - integrations/<slug>.sql                  per-integration tables
//                                             (e.g. housecall_pro).
//
// Both follow the same drift-tracking pattern: a header line carries
// the current version, the operator runs the SQL out-of-band against
// their pipeline DB and clicks "Mark as applied" to record the
// version in platform_settings. The platform never opens a
// connection to the pipeline DB.

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

// ── Per-integration schema files ────────────────────────────────
//
// scripts/pipeline-schemas/integrations/<slug>/<file>.sql, one
// directory per integration with one or more .sql files inside.
// Conventional filenames:
//   - schema.sql   → CREATE SCHEMA + pipeline_user grants stub
//   - render.sql   → templated SELECT for the dashboard read path
// Other names are accepted; whatever lands in the directory shows
// up in Admin → Pipeline as its own version-tracked card.
//
// Each file's header line is `-- <slug>_<file>_version: …` (e.g.
// `housecall_pro_schema_version: 2026-04-30-1`,
// `housecall_pro_render_version: 2026-04-30-1`). The header has to
// match the slug + filename so a file copy-pasted from another
// integration with a stale header can't be silently mis-applied.
//
// Applied versions are recorded in platform_settings under
// `integration_schema_version_applied:<slug>:<file>`.

const INTEGRATIONS_DIR = path.join(SCHEMAS_DIR, 'integrations');
const INTEGRATION_SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;

function buildIntegrationVersionHeaderRe(slug: string, file: string): RegExp {
  return new RegExp(`^--\\s*${slug}_${file}_version:\\s*(\\S+)\\s*$`, 'm');
}

function integrationAppliedKey(slug: string, file: string): string {
  return `integration_schema_version_applied:${slug}:${file}`;
}

export interface IntegrationFileInfo extends GlobalsSchemaInfo {
  slug: string;
  file: string;   // e.g. 'schema', 'render'
}

export interface IntegrationSlugSummary {
  slug: string;
  files: string[];   // sorted basenames sans .sql
}

export async function listIntegrationSlugs(): Promise<IntegrationSlugSummary[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(INTEGRATIONS_DIR, { withFileTypes: true });
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const summaries: IntegrationSlugSummary[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!INTEGRATION_SLUG_RE.test(ent.name)) continue;
    const files = await listIntegrationFiles(ent.name);
    if (files.length > 0) summaries.push({ slug: ent.name, files });
  }
  return summaries.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function listIntegrationFiles(slug: string): Promise<string[]> {
  if (!INTEGRATION_SLUG_RE.test(slug)) {
    throw new Error(`Invalid integration slug "${slug}"`);
  }
  const dir = path.resolve(INTEGRATIONS_DIR, slug);
  // Containment check — slug regex already forbids `/`, `..`, etc.,
  // but be explicit so CodeQL clears the path-injection rule.
  if (path.dirname(dir) !== path.resolve(INTEGRATIONS_DIR)) {
    throw new Error(`Invalid integration slug "${slug}"`);
  }
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.slice(0, -4))
    .filter((name) => INTEGRATION_SLUG_RE.test(name))
    .sort();
}

async function readIntegrationFile(
  slug: string,
  file: string,
): Promise<{ sql: string; version: string | null }> {
  if (!INTEGRATION_SLUG_RE.test(slug)) {
    throw new Error(`Invalid integration slug "${slug}"`);
  }
  if (!INTEGRATION_SLUG_RE.test(file)) {
    throw new Error(`Invalid integration file "${file}"`);
  }
  // Containment: resolve the full path and assert its parent is
  // exactly INTEGRATIONS_DIR/<slug> before reading.
  const slugDir = path.resolve(INTEGRATIONS_DIR, slug);
  if (path.dirname(slugDir) !== path.resolve(INTEGRATIONS_DIR)) {
    throw new Error(`Invalid integration slug "${slug}"`);
  }
  const filePath = path.resolve(slugDir, `${file}.sql`);
  if (path.dirname(filePath) !== slugDir) {
    throw new Error(`Invalid integration file "${file}"`);
  }
  const sql = await fs.readFile(filePath, 'utf8');
  const match = sql.match(buildIntegrationVersionHeaderRe(slug, file));
  return { sql, version: match ? match[1] : null };
}

export async function getIntegrationFileInfo(
  slug: string,
  file: string,
): Promise<IntegrationFileInfo> {
  const [{ sql, version }, applied] = await Promise.all([
    readIntegrationFile(slug, file),
    getSetting(integrationAppliedKey(slug, file)),
  ]);
  return {
    slug,
    file,
    current_version: version,
    applied_version: applied,
    needs_update: !!version && applied !== version,
    sql,
  };
}

export async function markIntegrationFileApplied(
  slug: string,
  file: string,
  version: string,
  userId: string | null,
): Promise<{ slug: string; file: string; applied_version: string }> {
  const { version: current } = await readIntegrationFile(slug, file);
  if (!current) {
    throw new Error(
      `${slug}/${file}.sql has no version header — cannot mark applied`,
    );
  }
  if (version !== current) {
    throw new Error(
      `Version mismatch: tried to mark "${version}" applied but the current ${slug}/${file}.sql is "${current}". Reload the admin view.`,
    );
  }
  await updateSettings({ [integrationAppliedKey(slug, file)]: version }, userId);
  return { slug, file, applied_version: version };
}
