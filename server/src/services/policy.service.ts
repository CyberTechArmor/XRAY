// Step 11 — privacy & compliance docs.
//
// Surfaces:
//   - listLatest()           — public (carve-out, withClient)
//   - getLatest(slug)        — public (carve-out, withClient)
//   - getVersion(slug, ver)  — public (carve-out, withClient)
//   - listAllVersions(slug)  — admin (cross-tenant, withAdminClient)
//   - listAcceptors(...)     — admin (cross-tenant, withAdminClient)
//   - publishVersion(...)    — admin (cross-tenant, withAdminClient)
//   - recordAcceptance(...)  — tenant-scoped (withTenantContext)
//   - pendingForUser(...)    — tenant-scoped (withTenantContext)
//   - listMyAcceptances(...) — tenant-scoped (withTenantContext)
//
// withClient allow-list rationale (mirrors magic_links /
// platform_settings shape): platform.policy_documents has NO
// row-level security per migration 039. The legal pages must
// render for logged-out visitors via /api/legal/<slug>, which
// requires a pre-tenant-context read path. Adding policy.service
// to scripts/check-withclient-allowlist.sh's roster is the
// first allow-list change since step 7's lock.

import type { Request } from 'express';
import { createHash } from 'crypto';
import {
  withClient,
  withAdminClient,
  withTenantContext,
} from '../db/connection';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import * as auditService from './audit.service';

// Marker substring seeded into v1 of every slug by migration 041.
// getLatest / listLatest surface an `is_placeholder: true` flag when
// the marker is still present so the public /legal/<slug> SPA route
// can render a prominent warning banner. Stripping the marker
// (operator publishes a real v2) removes the flag automatically.
const PLACEHOLDER_MARKER = '[XRAY-POLICY-PLACEHOLDER]';

// Sentinel UUID — audit_log.tenant_id is NOT NULL, but publishVersion
// is platform-wide. Mirrors the convention in admin.service /
// audit.service for cross-tenant events.
const PLATFORM_AUDIT_TENANT = '00000000-0000-0000-0000-000000000000';

export interface PolicySummary {
  slug: string;
  version: number;
  title: string;
  is_required: boolean;
  is_placeholder: boolean;
  published_at: string;
}

export interface PolicyDocument extends PolicySummary {
  body_md: string;
  published_by: string | null;
}

export interface PendingPolicy {
  slug: string;
  title: string;
  current_version: number;
  accepted_version: number | null;
}

export interface AcceptanceHistoryRow {
  slug: string;
  version: number;
  accepted_at: string;
}

export interface AcceptorRow {
  user_id: string;
  tenant_id: string;
  user_name: string | null;
  user_email: string | null;
  accepted_at: string;
  ip_hash: string | null;
  ua_hash: string | null;
}

function isPlaceholder(body_md: string): boolean {
  return body_md.includes(PLACEHOLDER_MARKER);
}

// ── Public read paths (no auth required) ──────────────────────────
//
// Both listLatest and getLatest read platform.policy_documents,
// which has no RLS (migration 039). Plain withClient is the
// semantically-correct call shape — see header comment.

export async function listLatest(): Promise<PolicySummary[]> {
  return withClient(async (client) => {
    // SELECT DISTINCT ON (slug) gives the row with the highest
    // version per slug — the (slug, version DESC) index from
    // migration 039 keeps it cheap.
    const r = await client.query(
      `SELECT DISTINCT ON (slug)
              slug, version, title, body_md, is_required, published_at
         FROM platform.policy_documents
        ORDER BY slug ASC, version DESC`,
    );
    return r.rows.map((row) => ({
      slug: row.slug,
      version: row.version,
      title: row.title,
      is_required: row.is_required,
      is_placeholder: isPlaceholder(row.body_md),
      published_at: row.published_at,
    }));
  });
}

export async function getLatest(slug: string): Promise<PolicyDocument | null> {
  return withClient(async (client) => {
    const r = await client.query(
      `SELECT slug, version, title, body_md, is_required, published_at, published_by
         FROM platform.policy_documents
        WHERE slug = $1
        ORDER BY version DESC
        LIMIT 1`,
      [slug],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      slug: row.slug,
      version: row.version,
      title: row.title,
      body_md: row.body_md,
      is_required: row.is_required,
      is_placeholder: isPlaceholder(row.body_md),
      published_at: row.published_at,
      published_by: row.published_by,
    };
  });
}

export async function getVersion(slug: string, version: number): Promise<PolicyDocument | null> {
  return withClient(async (client) => {
    const r = await client.query(
      `SELECT slug, version, title, body_md, is_required, published_at, published_by
         FROM platform.policy_documents
        WHERE slug = $1 AND version = $2
        LIMIT 1`,
      [slug, version],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      slug: row.slug,
      version: row.version,
      title: row.title,
      body_md: row.body_md,
      is_required: row.is_required,
      is_placeholder: isPlaceholder(row.body_md),
      published_at: row.published_at,
      published_by: row.published_by,
    };
  });
}

// ── Admin paths (platform.admin permission required) ──────────────

export interface AdminSlugSummary {
  slug: string;
  versions: Array<{
    version: number;
    title: string;
    is_required: boolean;
    is_placeholder: boolean;
    published_at: string;
    published_by: string | null;
    acceptance_count: number;
  }>;
}

export async function listAllVersions(): Promise<AdminSlugSummary[]> {
  return withAdminClient(async (client) => {
    const r = await client.query(
      `SELECT pd.slug, pd.version, pd.title, pd.body_md, pd.is_required,
              pd.published_at, pd.published_by,
              COALESCE(ac.cnt, 0)::int AS acceptance_count
         FROM platform.policy_documents pd
         LEFT JOIN (
           SELECT slug, version, COUNT(*) AS cnt
             FROM platform.policy_acceptances
            GROUP BY slug, version
         ) ac ON ac.slug = pd.slug AND ac.version = pd.version
        ORDER BY pd.slug ASC, pd.version DESC`,
    );
    const bySlug = new Map<string, AdminSlugSummary>();
    for (const row of r.rows) {
      let entry = bySlug.get(row.slug);
      if (!entry) {
        entry = { slug: row.slug, versions: [] };
        bySlug.set(row.slug, entry);
      }
      entry.versions.push({
        version: row.version,
        title: row.title,
        is_required: row.is_required,
        is_placeholder: isPlaceholder(row.body_md),
        published_at: row.published_at,
        published_by: row.published_by,
        acceptance_count: row.acceptance_count,
      });
    }
    return Array.from(bySlug.values());
  });
}

export interface PublishInput {
  title: string;
  body_md: string;
  is_required: boolean;
}

export async function publishVersion(
  slug: string,
  input: PublishInput,
  publishedByUserId: string,
): Promise<PolicyDocument> {
  if (!slug || typeof slug !== 'string' || !slug.trim()) {
    throw new AppError(400, 'INVALID_SLUG', 'slug is required');
  }
  if (!input.title || typeof input.title !== 'string' || !input.title.trim()) {
    throw new AppError(400, 'INVALID_TITLE', 'title is required');
  }
  if (typeof input.body_md !== 'string' || input.body_md.length === 0) {
    throw new AppError(400, 'INVALID_BODY', 'body_md is required');
  }
  if (typeof input.is_required !== 'boolean') {
    throw new AppError(400, 'INVALID_REQUIRED', 'is_required must be boolean');
  }

  const result = await withAdminClient(async (client) => {
    // max(version)+1 inside the bypass session. UNIQUE (slug, version)
    // gates the race when two admins click Publish simultaneously —
    // one INSERT wins, the other throws 23505 and the caller retries
    // (ON CONFLICT DO NOTHING is wrong here; we want the author to
    // re-fetch and re-publish so they see the other admin's edit).
    const maxR = await client.query(
      `SELECT COALESCE(MAX(version), 0)::int AS max_version
         FROM platform.policy_documents
        WHERE slug = $1`,
      [slug],
    );
    const nextVersion = maxR.rows[0].max_version + 1;
    const insR = await client.query(
      `INSERT INTO platform.policy_documents
         (slug, version, title, body_md, is_required, published_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING slug, version, title, body_md, is_required, published_at, published_by`,
      [slug, nextVersion, input.title, input.body_md, input.is_required, publishedByUserId],
    );
    const row = insR.rows[0];
    return {
      slug: row.slug,
      version: row.version,
      title: row.title,
      body_md: row.body_md,
      is_required: row.is_required,
      is_placeholder: isPlaceholder(row.body_md),
      published_at: row.published_at,
      published_by: row.published_by,
    };
  });

  auditService.log({
    tenantId: PLATFORM_AUDIT_TENANT,
    userId: publishedByUserId,
    action: 'policy.publish',
    resourceType: 'policy_document',
    resourceId: result.slug,
    metadata: {
      slug: result.slug,
      version: result.version,
      is_required: result.is_required,
      title: result.title,
    },
  });

  return result;
}

// setRequired(slug, is_required, byUserId)
//
// Toggles is_required on the LATEST published version of a slug
// without minting a new version. Append-only applies to body_md /
// title (the document text); is_required is a runtime flag whose
// only effect is whether pendingForUser surfaces this slug in the
// re-acceptance modal. Treating it as content would force a
// version bump every time the operator decides "actually let's
// not gate signups on this one" — heavy, and would re-prompt
// every user who already accepted the latest version.
//
// The audit log captures the change so the metadata edit is
// traceable. Throws if the slug has no published versions.
export async function setRequired(
  slug: string,
  isRequired: boolean,
  byUserId: string,
): Promise<PolicyDocument> {
  if (!slug || typeof slug !== 'string') {
    throw new AppError(400, 'INVALID_SLUG', 'slug is required');
  }
  if (typeof isRequired !== 'boolean') {
    throw new AppError(400, 'INVALID_REQUIRED', 'is_required must be boolean');
  }

  const result = await withAdminClient(async (client) => {
    const r = await client.query(
      `UPDATE platform.policy_documents
          SET is_required = $1
        WHERE id = (
          SELECT id FROM platform.policy_documents
           WHERE slug = $2
           ORDER BY version DESC
           LIMIT 1
        )
        RETURNING slug, version, title, body_md, is_required,
                  published_at, published_by`,
      [isRequired, slug],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      slug: row.slug,
      version: row.version,
      title: row.title,
      body_md: row.body_md,
      is_required: row.is_required,
      is_placeholder: isPlaceholder(row.body_md),
      published_at: row.published_at,
      published_by: row.published_by,
    } as PolicyDocument;
  });

  if (!result) {
    throw new AppError(404, 'LEGAL_SLUG_NOT_FOUND', 'No published version for that slug');
  }

  auditService.log({
    tenantId: PLATFORM_AUDIT_TENANT,
    userId: byUserId,
    action: 'policy.set_required',
    resourceType: 'policy_document',
    resourceId: result.slug,
    metadata: {
      slug: result.slug,
      version: result.version,
      is_required: result.is_required,
    },
  });

  return result;
}

export async function listAcceptors(
  slug: string,
  version: number,
  page = 1,
  limit = 50,
): Promise<{ data: AcceptorRow[]; total: number; page: number; limit: number }> {
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const safePage = Math.max(page, 1);
  const offset = (safePage - 1) * safeLimit;
  return withAdminClient(async (client) => {
    const totalR = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM platform.policy_acceptances
        WHERE slug = $1 AND version = $2`,
      [slug, version],
    );
    const r = await client.query(
      `SELECT pa.user_id, pa.tenant_id, u.name AS user_name, u.email AS user_email,
              pa.accepted_at, pa.ip_hash, pa.ua_hash
         FROM platform.policy_acceptances pa
         LEFT JOIN platform.users u ON u.id = pa.user_id
        WHERE pa.slug = $1 AND pa.version = $2
        ORDER BY pa.accepted_at DESC
        LIMIT $3 OFFSET $4`,
      [slug, version, safeLimit, offset],
    );
    return {
      data: r.rows.map((row) => ({
        user_id: row.user_id,
        tenant_id: row.tenant_id,
        user_name: row.user_name,
        user_email: row.user_email,
        accepted_at: row.accepted_at,
        ip_hash: row.ip_hash,
        ua_hash: row.ua_hash,
      })),
      total: totalR.rows[0].n,
      page: safePage,
      limit: safeLimit,
    };
  });
}

// ── Tenant-scoped paths ──────────────────────────────────────────

function hashWithSecret(value: string): string {
  if (!value) return '';
  return createHash('sha256').update(`${value}|${config.jwtSecret}`).digest('hex');
}

function reqIpHash(req: Request | undefined): string | null {
  if (!req) return null;
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!ip) return null;
  return hashWithSecret(ip);
}

function reqUaHash(req: Request | undefined): string | null {
  if (!req) return null;
  const ua = (req.headers?.['user-agent'] as string) || '';
  if (!ua) return null;
  return hashWithSecret(ua);
}

export async function recordAcceptance(
  userId: string,
  tenantId: string,
  slug: string,
  version: number,
  req?: Request,
): Promise<void> {
  // Validate the version exists for the slug — guards against a
  // tampered POST body recording an acceptance for a non-existent
  // (slug, version) tuple. Read runs under withClient since
  // policy_documents has no RLS.
  const exists = await withClient(async (client) => {
    const r = await client.query(
      `SELECT 1 FROM platform.policy_documents WHERE slug = $1 AND version = $2 LIMIT 1`,
      [slug, version],
    );
    return r.rows.length > 0;
  });
  if (!exists) {
    throw new AppError(404, 'POLICY_VERSION_NOT_FOUND', 'No published policy version matches that (slug, version)');
  }

  const ipHash = reqIpHash(req);
  const uaHash = reqUaHash(req);

  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `INSERT INTO platform.policy_acceptances
         (user_id, tenant_id, slug, version, ip_hash, ua_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, slug, version) DO NOTHING`,
      [userId, tenantId, slug, version, ipHash, uaHash],
    );
  });
}

export async function pendingForUser(
  userId: string,
  tenantId: string,
): Promise<PendingPolicy[]> {
  // Cross-table query joins policy_documents (no RLS) and
  // policy_acceptances (tenant-scoped RLS). Running under
  // withTenantContext gates the policy_acceptances side correctly;
  // the policy_documents side stays unrestricted because no policy
  // is defined on that table.
  return withTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `WITH latest AS (
         SELECT DISTINCT ON (slug) slug, version, title, is_required
           FROM platform.policy_documents
          ORDER BY slug ASC, version DESC
       ),
       my_max AS (
         SELECT slug, MAX(version) AS version
           FROM platform.policy_acceptances
          WHERE user_id = $1
          GROUP BY slug
       )
       SELECT l.slug, l.version AS current_version, l.title,
              m.version AS accepted_version
         FROM latest l
         LEFT JOIN my_max m ON m.slug = l.slug
        WHERE l.is_required = TRUE
          AND (m.version IS NULL OR m.version < l.version)
        ORDER BY l.slug ASC`,
      [userId],
    );
    return r.rows.map((row) => ({
      slug: row.slug,
      title: row.title,
      current_version: row.current_version,
      accepted_version: row.accepted_version,
    }));
  });
}

export async function listMyAcceptances(
  userId: string,
  tenantId: string,
): Promise<AcceptanceHistoryRow[]> {
  return withTenantContext(tenantId, async (client) => {
    const r = await client.query(
      `SELECT slug, version, accepted_at
         FROM platform.policy_acceptances
        WHERE user_id = $1
        ORDER BY accepted_at DESC`,
      [userId],
    );
    return r.rows.map((row) => ({
      slug: row.slug,
      version: row.version,
      accepted_at: row.accepted_at,
    }));
  });
}
