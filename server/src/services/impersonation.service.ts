import { withAdminTransaction, withAdminClient } from '../db/connection';
import { config } from '../config';
import { signAccessToken, signRefreshToken } from './jwt.service';
import { hashRefreshToken } from '../lib/crypto';
import { AppError } from '../middleware/error-handler';
import * as auditService from './audit.service';

// Step 10 — platform-admin impersonation.
//
// Start: a platform admin POSTs /api/admin/impersonate/:tid/:uid.
// We mint a NEW user_sessions row owned by the target user, with
// impersonator_user_id stamped to the admin's id. The access
// token JWT carries an `imp` claim so the SPA renders a persistent
// red banner without an extra round-trip.
//
// Stop: the impersonation access token's `imp` claim carries the
// originating admin's id. We look up the admin, mint a fresh
// session for them (a new row — we deliberately don't try to
// rotate the admin's pre-existing session; they may have other
// devices still logged in), and delete the impersonation session.
//
// Audit: paired log lines on start + stop. tenant_audit captures
// the cross-tenant view (target tenant sees "platform admin X
// impersonated user Y"); platform_audit captures the originating
// tenant's view ("admin X started impersonation of Y in tenant T").

interface ImpersonationTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export async function startImpersonation(input: {
  adminUserId: string;
  targetTenantId: string;
  targetUserId: string;
}): Promise<ImpersonationTokens> {
  return withAdminTransaction(async (client) => {
    // Defence in depth — the route already gates is_platform_admin,
    // but we verify that at the DB level here. A future caller
    // wiring this from a non-route path won't accidentally elevate.
    const adminRow = await client.query(
      `SELECT u.id, u.email, u.tenant_id, r.slug AS role_slug
         FROM platform.users u
         JOIN platform.roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.status = 'active'`,
      [input.adminUserId]
    );
    if (adminRow.rows.length === 0) {
      throw new AppError(404, 'ADMIN_NOT_FOUND', 'Admin user not found or inactive');
    }
    const admin = adminRow.rows[0];
    if (admin.role_slug !== 'platform_admin') {
      throw new AppError(403, 'NOT_PLATFORM_ADMIN', 'Caller is not a platform admin');
    }

    // Target lookup — must exist, be active, and match the
    // route-supplied tenant_id (defence in depth: a caller can't
    // splice a user from tenant A onto tenant B's route).
    const targetRow = await client.query(
      `SELECT u.id, u.email, u.is_owner, u.tenant_id, u.role_id, r.slug AS role_slug
         FROM platform.users u
         JOIN platform.roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.tenant_id = $2 AND u.status = 'active'`,
      [input.targetUserId, input.targetTenantId]
    );
    if (targetRow.rows.length === 0) {
      throw new AppError(404, 'TARGET_NOT_FOUND', 'Target user not found in that tenant or inactive');
    }
    const target = targetRow.rows[0];

    // Tenant must be live (not archived/suspended) — admin can
    // still impersonate inside an active tenant; routing into an
    // archived tenant is almost certainly a stale operator bookmark
    // and we surface it as a clean error.
    const tenantRow = await client.query(
      `SELECT status FROM platform.tenants WHERE id = $1`,
      [input.targetTenantId]
    );
    if (tenantRow.rows.length === 0) {
      throw new AppError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
    }
    if (['archived', 'suspended'].includes(tenantRow.rows[0].status)) {
      throw new AppError(403, 'TENANT_INACTIVE', 'Cannot impersonate inside an archived or suspended tenant');
    }

    // Target's permissions + flags. Platform admin status follows
    // the role slug; we deliberately don't grant the admin's own
    // platform-admin posture to the impersonation session — the
    // operator is sitting in the target's seat with the target's
    // permissions only, plus the imp claim for traceability.
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
         JOIN platform.role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = $1`,
      [target.role_id]
    );
    const permissions: string[] = permResult.rows.map((r: { key: string }) => r.key);
    const isTargetPlatformAdmin = target.role_slug === 'platform_admin';

    const flagRow = await client.query(
      `SELECT has_admin, has_billing, has_replay
         FROM platform.users WHERE id = $1`,
      [target.id]
    );
    const flags = flagRow.rows[0] || {};

    // Mint the session.
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions
         (user_id, tenant_id, refresh_token_hash, device_info, expires_at, impersonator_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        target.id,
        target.tenant_id,
        refreshTokenHash,
        JSON.stringify({ impersonation: true, admin_id: admin.id }),
        expiresAt,
        admin.id,
      ]
    );
    const sessionId = sessionResult.rows[0].id;

    const accessToken = signAccessToken({
      sub: target.id,
      tid: target.tenant_id,
      role: target.role_slug,
      permissions,
      is_owner: target.is_owner,
      is_platform_admin: isTargetPlatformAdmin,
      has_admin: flags.has_admin,
      has_billing: flags.has_billing,
      has_replay: flags.has_replay,
      imp: { admin_id: admin.id, admin_email: admin.email },
    });

    // Paired audit logs. The target-tenant entry surfaces in the
    // tenant's own audit view; the originating-admin entry surfaces
    // in the platform-wide audit view.
    auditService.log({
      tenantId: target.tenant_id,
      userId: admin.id,
      action: 'admin.impersonation.start',
      resourceType: 'user',
      resourceId: target.id,
      metadata: {
        admin_email: admin.email,
        target_email: target.email,
      },
    });
    if (admin.tenant_id && admin.tenant_id !== target.tenant_id) {
      auditService.log({
        tenantId: admin.tenant_id,
        userId: admin.id,
        action: 'admin.impersonation.start',
        resourceType: 'user',
        resourceId: target.id,
        metadata: {
          target_tenant_id: target.tenant_id,
          target_email: target.email,
        },
      });
    }

    return { accessToken, refreshToken, sessionId };
  });
}

// Stop is invoked by an impersonation session (req.user.imp set).
// We resolve the original admin from the imp claim, mint a fresh
// session for them, and delete the impersonation row.
export async function stopImpersonation(input: {
  impersonationRefreshTokenHash: string;
  adminUserId: string;
}): Promise<ImpersonationTokens> {
  return withAdminTransaction(async (client) => {
    // Locate the impersonation session by the refresh token hash
    // sent up via cookie. The session row must have a non-NULL
    // impersonator_user_id matching the admin id from the JWT — if
    // an attacker forges an `imp` claim against a non-impersonation
    // session, this filter rejects it.
    const sessionResult = await client.query(
      `SELECT id, user_id, tenant_id, impersonator_user_id
         FROM platform.user_sessions
        WHERE refresh_token_hash = $1
          AND impersonator_user_id = $2`,
      [input.impersonationRefreshTokenHash, input.adminUserId]
    );
    if (sessionResult.rows.length === 0) {
      throw new AppError(400, 'NOT_IMPERSONATING', 'Current session is not an impersonation session');
    }
    const impSession = sessionResult.rows[0];

    // Resolve the admin user (must still exist + be active +
    // platform admin).
    const adminRow = await client.query(
      `SELECT u.id, u.email, u.tenant_id, u.is_owner, u.role_id, r.slug AS role_slug
         FROM platform.users u
         JOIN platform.roles r ON r.id = u.role_id
        WHERE u.id = $1 AND u.status = 'active'`,
      [input.adminUserId]
    );
    if (adminRow.rows.length === 0) {
      throw new AppError(404, 'ADMIN_NOT_FOUND', 'Original admin user not found or inactive');
    }
    const admin = adminRow.rows[0];
    if (admin.role_slug !== 'platform_admin') {
      throw new AppError(403, 'NOT_PLATFORM_ADMIN', 'Original session is not a platform admin');
    }

    // Admin's permissions + flags.
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
         JOIN platform.role_permissions rp ON rp.permission_id = p.id
        WHERE rp.role_id = $1`,
      [admin.role_id]
    );
    const permissions: string[] = permResult.rows.map((r: { key: string }) => r.key);

    const flagRow = await client.query(
      `SELECT has_admin, has_billing, has_replay
         FROM platform.users WHERE id = $1`,
      [admin.id]
    );
    const flags = flagRow.rows[0] || {};

    // Fresh session for the admin. We don't try to rotate any
    // pre-existing admin session; they may be active on other
    // devices.
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const newSession = await client.query(
      `INSERT INTO platform.user_sessions
         (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [admin.id, admin.tenant_id, refreshTokenHash, expiresAt]
    );

    // Tear down the impersonation row.
    await client.query(
      `DELETE FROM platform.user_sessions WHERE id = $1`,
      [impSession.id]
    );

    const accessToken = signAccessToken({
      sub: admin.id,
      tid: admin.tenant_id,
      role: admin.role_slug,
      permissions,
      is_owner: admin.is_owner,
      is_platform_admin: true,
      has_admin: flags.has_admin,
      has_billing: flags.has_billing,
      has_replay: flags.has_replay,
    });

    auditService.log({
      tenantId: impSession.tenant_id,
      userId: admin.id,
      action: 'admin.impersonation.stop',
      resourceType: 'user',
      resourceId: impSession.user_id,
      metadata: {
        admin_email: admin.email,
      },
    });
    if (admin.tenant_id && admin.tenant_id !== impSession.tenant_id) {
      auditService.log({
        tenantId: admin.tenant_id,
        userId: admin.id,
        action: 'admin.impersonation.stop',
        resourceType: 'user',
        resourceId: impSession.user_id,
        metadata: {
          target_tenant_id: impSession.tenant_id,
        },
      });
    }

    return {
      accessToken,
      refreshToken,
      sessionId: newSession.rows[0].id,
    };
  });
}

// Used by the impersonation-stop route to verify the JWT's `imp`
// claim against the database. Returns true only if the current
// session is a live impersonation session.
export async function isImpersonating(refreshTokenHash: string): Promise<boolean> {
  return withAdminClient(async (client) => {
    const r = await client.query(
      `SELECT 1 FROM platform.user_sessions
        WHERE refresh_token_hash = $1
          AND impersonator_user_id IS NOT NULL`,
      [refreshTokenHash]
    );
    return r.rows.length > 0;
  });
}
