import { withClient, withAdminClient, withAdminTransaction } from '../db/connection';
import { generateCode, generateToken, hashToken, hashRefreshToken, generateUUID } from '../lib/crypto';
import { config } from '../config';
import { AppError } from '../middleware/error-handler';
import { signAccessToken, signRefreshToken } from './jwt.service';
import { sendTemplateEmail } from './email.service';
import * as auditService from './audit.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

interface MagicLink {
  id: string;
  email: string;
  code: string;
  token_hash: string;
  purpose: string;
  tenant_id: string | null;
  metadata: Record<string, unknown> | null;
  used: boolean;
  attempts: number;
  // max_attempts column added by migration 033 (default 5). The
  // per-link cap is independent of the per-day per-user cap (20)
  // enforced by the rate-limit middleware in step 9 — both apply.
  max_attempts: number;
  expires_at: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// Derive a URL-safe slug from a tenant display name. Exported for reuse
// (completeSignup + firstBootSetup + initiateSignup all funnel through
// this single definition) and for the slug-collision spec.
export function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function getUserPermissions(userId: string): Promise<string[]> {
  // Called mid-login before the caller's tenant context is bound — the
  // lookup is keyed on user_id (which is unique across tenants), so
  // admin bypass is the correct explicit scope.
  return withAdminClient(async (client) => {
    const result = await client.query(
      `SELECT p.key
       FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       JOIN platform.users u ON u.role_id = rp.role_id
       WHERE u.id = $1`,
      [userId]
    );
    const perms = result.rows.map((r: { key: string }) => r.key);

    // Augment permissions based on user-level permission flags
    const flagResult = await client.query(
      `SELECT has_admin, has_billing, has_replay FROM platform.users WHERE id = $1`,
      [userId]
    );
    if (flagResult.rows.length > 0) {
      const { has_admin, has_billing, has_replay } = flagResult.rows[0];
      if (has_admin && !perms.includes('users.manage')) perms.push('users.manage');
      if (has_billing) {
        if (!perms.includes('billing.manage')) perms.push('billing.manage');
        if (!perms.includes('billing.view')) perms.push('billing.view');
      }
      if (has_replay) {
        if (!perms.includes('session_replay.view')) perms.push('session_replay.view');
      }
    }

    return perms;
  });
}

async function getUserFlags(userId: string): Promise<{ has_admin: boolean; has_billing: boolean; has_replay: boolean }> {
  // Same rationale as getUserPermissions — mid-login user lookup by id.
  return withAdminClient(async (client) => {
    const result = await client.query(
      `SELECT has_admin, has_billing, has_replay FROM platform.users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) return { has_admin: false, has_billing: false, has_replay: false };
    return { has_admin: !!result.rows[0].has_admin, has_billing: !!result.rows[0].has_billing, has_replay: !!result.rows[0].has_replay };
  });
}

async function createMagicLink(
  email: string,
  purpose: string,
  tenantId?: string,
  metadata?: Record<string, unknown>
): Promise<{ code: string; token: string }> {
  const code = generateCode(6);
  const token = generateToken(48);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + config.magicLink.expiryMinutes * 60_000);

  // platform.magic_links is on the bypass-only carve-out list per
  // migration 029 (no RLS); stays on plain withClient.
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO platform.magic_links (email, code, token_hash, purpose, tenant_id, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [email, code, tokenHash, purpose, tenantId || null, metadata ? JSON.stringify(metadata) : null, expiresAt]
    );
  });

  return { code, token };
}

// ─── First-boot setup ───────────────────────────────────────────────────────

export async function getSetupStatus(): Promise<{ setupRequired: boolean }> {
  // First-boot check — the platform may have zero users yet, so no
  // tenant or admin context exists. plain withClient. The COUNT
  // returns 0 even with RLS active since the bootstrap seed creates
  // the first user outside tenant scope.
  return withAdminClient(async (client) => {
    const result = await client.query('SELECT COUNT(*) FROM platform.users');
    const count = parseInt(result.rows[0].count, 10);
    return { setupRequired: count === 0 };
  });
}

export async function firstBootSetup(input: {
  email: string;
  name: string;
  tenantName: string;
}): Promise<TokenPair> {
  // Platform bootstrap — zero users exist yet; admin bypass is the
  // correct (and only sensible) context for the initial seeds +
  // first tenant creation.
  return withAdminTransaction(async (client) => {
    // Only allowed when zero users exist
    const countResult = await client.query('SELECT COUNT(*) FROM platform.users');
    if (parseInt(countResult.rows[0].count, 10) > 0) {
      throw new AppError(403, 'SETUP_COMPLETE', 'Platform is already set up');
    }

    // Seed roles if they don't exist (handles pre-existing DB without seed data)
    const roleCheck = await client.query("SELECT id FROM platform.roles WHERE slug = 'platform_admin'");
    if (roleCheck.rows.length === 0) {
      await client.query(`
        INSERT INTO platform.roles (name, slug, description, is_system, is_platform) VALUES
          ('Platform Admin', 'platform_admin', 'Full platform access', true, true),
          ('Owner',          'owner',          'Tenant owner',          true, false),
          ('Member',         'member',         'Standard member — views dashboards, manages account', true, false)
        ON CONFLICT (slug) DO NOTHING
      `);

      // Seed permissions
      await client.query(`
        INSERT INTO platform.permissions (key, label, category, description) VALUES
          ('platform.admin',      'Platform admin',     'platform',    'Full platform administration'),
          ('account.view',        'View account',       'account',     'View own profile and sessions'),
          ('account.edit',        'Edit account',       'account',     'Edit own profile'),
          ('users.view',          'View users',         'users',       'View team members'),
          ('users.manage',        'Manage users',       'users',       'Invite and manage users'),
          ('dashboards.view',     'View dashboards',    'dashboards',  'View dashboards'),
          ('dashboards.manage',   'Manage dashboards',  'dashboards',  'Create and edit dashboards'),
          ('connections.view',    'View connections',    'connections', 'View data connections'),
          ('connections.manage',  'Manage connections',  'connections', 'Manage data connections'),
          ('billing.view',        'View billing',       'billing',     'View plan and invoices'),
          ('billing.manage',      'Manage billing',     'billing',     'Change plan'),
          ('audit.view',          'View audit log',     'audit',       'View audit log')
        ON CONFLICT (key) DO NOTHING
      `);

      // platform_admin gets all permissions
      await client.query(`
        INSERT INTO platform.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
          WHERE r.slug = 'platform_admin'
        ON CONFLICT DO NOTHING
      `);

      // owner gets everything except platform.admin
      await client.query(`
        INSERT INTO platform.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
          WHERE r.slug = 'owner' AND p.key != 'platform.admin'
        ON CONFLICT DO NOTHING
      `);

      // member gets view permissions + account
      await client.query(`
        INSERT INTO platform.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
          WHERE r.slug = 'member' AND p.key IN (
            'account.view', 'account.edit', 'users.view',
            'dashboards.view', 'connections.view', 'billing.view', 'audit.view'
          )
        ON CONFLICT DO NOTHING
      `);

      console.log('[SETUP] Seeded roles and permissions');
    }

    // Get platform_admin role
    const roleResult = await client.query(
      "SELECT id FROM platform.roles WHERE slug = 'platform_admin'"
    );
    if (roleResult.rows.length === 0) {
      throw new AppError(500, 'ROLE_NOT_FOUND', "Role 'platform_admin' not found");
    }
    const roleId = roleResult.rows[0].id;

    // Create tenant
    const slug = normalizeSlug(input.tenantName);
    if (!slug) {
      throw new AppError(400, 'INVALID_TENANT_NAME', 'Organization name must contain at least one letter or number.');
    }

    const tenantResult = await client.query(
      `INSERT INTO platform.tenants (name, slug) VALUES ($1, $2) RETURNING *`,
      [input.tenantName, slug]
    );
    const tenant = tenantResult.rows[0];

    // Create user
    const userResult = await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, is_owner, status)
       VALUES ($1, $2, $3, $4, true, 'active')
       RETURNING *`,
      [tenant.id, input.email, input.name, roleId]
    );
    const user = userResult.rows[0];

    // Link owner to tenant
    await client.query(
      'UPDATE platform.tenants SET owner_user_id = $1 WHERE id = $2',
      [user.id, tenant.id]
    );

    // Create billing state
    await client.query(
      `INSERT INTO platform.billing_state (tenant_id, plan_tier, dashboard_limit, payment_status)
       VALUES ($1, 'free', 0, 'none')`,
      [tenant.id]
    );

    // Create warehouse schema
    const schemaName = `tn_${tenant.id.replace(/-/g, '')}`;
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [roleId]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    // Create session
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, tenant.id, refreshTokenHash, expiresAt]
    );

    const accessToken = signAccessToken({
      sub: user.id,
      tid: tenant.id,
      role: 'platform_admin',
      permissions,
      is_owner: true,
      is_platform_admin: true,
      has_admin: true,
      has_billing: true,
    });

    auditService.log({
      tenantId: tenant.id,
      userId: user.id,
      action: 'user.setup',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { is_platform_admin: true, first_boot: true },
    });

    console.log(`[SETUP] Platform admin created: ${input.email}`);

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function initiateSignup(input: {
  email: string;
  name: string;
  tenantName: string;
  // When present, swaps the email template to the branded
  // "tenant_invitation" copy ("you've been invited") instead of the
  // default "signup_verification" copy ("verify your email"). Routes
  // through the same magic-link + completeSignup machinery — only the
  // outbound email differs.
  invitation?: { inviterName: string };
}): Promise<{ message: string }> {
  // Pre-signup existence checks run BEFORE a tenant exists, and
  // deliberately scan every tenant for email / name / slug collisions.
  // Admin bypass is the correct explicit scope for those reads.
  const existing = await withAdminClient(async (client) => {
    const result = await client.query(
      'SELECT id FROM platform.users WHERE email = $1',
      [input.email]
    );
    return result.rows[0];
  });

  if (existing) {
    throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
  }

  // Check if tenant name already exists (case-insensitive)
  const existingTenant = await withAdminClient(async (client) => {
    const result = await client.query(
      'SELECT id FROM platform.tenants WHERE LOWER(name) = LOWER($1)',
      [input.tenantName]
    );
    return result.rows[0];
  });

  if (existingTenant) {
    throw new AppError(409, 'TENANT_EXISTS', 'An organization with this name already exists. Please choose a different name.');
  }

  // Also check slug collision up front — two distinct names can collapse
  // to the same slug (e.g. "Acme Corp" and "Acme, Corp!") and we want the
  // user to see a clear error now, not a 500 at completeSignup.
  const derivedSlug = normalizeSlug(input.tenantName);
  if (!derivedSlug) {
    throw new AppError(400, 'INVALID_TENANT_NAME', 'Organization name must contain at least one letter or number.');
  }
  const existingSlug = await withAdminClient(async (client) => {
    const result = await client.query(
      'SELECT id FROM platform.tenants WHERE slug = $1',
      [derivedSlug]
    );
    return result.rows[0];
  });
  if (existingSlug) {
    throw new AppError(409, 'SLUG_TAKEN', 'That organization name collides with an existing one. Please pick a more distinct name.');
  }

  const { code, token } = await createMagicLink(input.email, 'signup', undefined, {
    name: input.name,
    tenantName: input.tenantName,
  });

  // Fire-and-forget: don't block the response on SMTP. Choose
  // template based on whether this signup originates from a platform
  // admin invitation (admin.service.inviteTenantOwner) or self-signup.
  const templateKey = input.invitation ? 'tenant_invitation' : 'signup_verification';
  const variables: Record<string, string> = {
    name: input.name,
    code,
    link: `${config.webauthn.origin}/auth/verify?token=${token}&purpose=signup`,
  };
  if (input.invitation) {
    variables.inviter_name = input.invitation.inviterName;
    variables.tenant_name = input.tenantName;
  }
  sendTemplateEmail(templateKey, input.email, variables).catch((err) => {
    console.error('Failed to send signup email:', err);
  });

  return { message: 'Verification email sent. Please check your inbox.' };
}

export async function initiateLogin(email: string): Promise<{ message: string }> {
  // Check if user exists — find ALL active accounts for this email
  // across every tenant. Admin bypass explicit.
  const users = await withAdminClient(async (client) => {
    const result = await client.query(
      'SELECT id, tenant_id, name FROM platform.users WHERE email = $1 AND status = $2',
      [email, 'active']
    );
    return result.rows;
  });

  if (users.length === 0) {
    // Don't reveal whether user exists — still return success
    return { message: 'If an account exists, a login link has been sent.' };
  }

  // Use the first user's tenant_id for the magic link (tenant selection happens at completeLogin)
  const user = users[0];
  const { code, token } = await createMagicLink(email, 'login', user.tenant_id);

  // Fire-and-forget: don't block the response on SMTP
  sendTemplateEmail('login_code', email, {
    name: user.name,
    code,
    link: `${config.webauthn.origin}/auth/verify?token=${token}&purpose=login`,
  }).catch((err) => {
    console.error('Failed to send login email:', err);
  });

  return { message: 'If an account exists, a login link has been sent.' };
}

export async function verifyCode(input: {
  email: string;
  code: string;
}): Promise<MagicLink> {
  // magic_links is on the carve-out (no RLS); plain withClient.
  return withClient(async (client) => {
    // Read the most recent magic link for this email regardless of
    // expiry/used state so we can return a specific error code for
    // each failure mode (expired vs. used vs. no record vs. wrong
    // code). Clients key a re-request CTA off MAGIC_LINK_EXPIRED.
    const result = await client.query(
      `SELECT * FROM platform.magic_links
       WHERE email = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.email]
    );

    const magicLink = result.rows[0] as MagicLink | undefined;
    if (!magicLink) {
      throw new AppError(400, 'INVALID_CODE', 'No verification code found. Please request a new one.');
    }

    if (magicLink.used) {
      throw new AppError(400, 'MAGIC_LINK_USED', 'This code has already been used. Please request a new one.');
    }

    if (new Date(magicLink.expires_at) <= new Date()) {
      throw new AppError(400, 'MAGIC_LINK_EXPIRED', 'This code has expired. Please request a new one.');
    }

    // Step 9: enforce the per-row max_attempts column (migration 033,
    // default 5). config.magicLink.maxAttempts is no longer the gate —
    // the column lets the operator tune per-link severity without a
    // server restart. attempts_remaining is surfaced on every failure
    // so the auth modal can render "N attempts left."
    const maxAttempts = magicLink.max_attempts ?? config.magicLink.maxAttempts;

    if (magicLink.attempts >= maxAttempts) {
      // Mark as used so a fresh attempt with the same code can't slip
      // past the cap on a race.
      await client.query(
        'UPDATE platform.magic_links SET used = true WHERE id = $1',
        [magicLink.id]
      );
      throw new AppError(
        400,
        'MAX_ATTEMPTS',
        'Maximum verification attempts exceeded. Please request a new code.',
        { attempts_remaining: 0 }
      );
    }

    if (magicLink.code !== input.code) {
      const updated = await client.query(
        `UPDATE platform.magic_links
            SET attempts = attempts + 1,
                used = (attempts + 1 >= $2)
          WHERE id = $1
        RETURNING attempts, used`,
        [magicLink.id, maxAttempts]
      );
      const newAttempts: number = updated.rows[0]?.attempts ?? magicLink.attempts + 1;
      const remaining = Math.max(0, maxAttempts - newAttempts);
      const code = remaining === 0 ? 'MAX_ATTEMPTS' : 'INVALID_CODE';
      const message = remaining === 0
        ? 'Maximum verification attempts exceeded. Please request a new code.'
        : 'Incorrect verification code';
      throw new AppError(400, code, message, { attempts_remaining: remaining });
    }

    // Mark as used
    await client.query(
      'UPDATE platform.magic_links SET used = true WHERE id = $1',
      [magicLink.id]
    );

    return magicLink;
  });
}

export async function verifyToken(token: string): Promise<MagicLink> {
  const tokenHash = hashToken(token);

  // magic_links is on the carve-out (no RLS); plain withClient.
  return withClient(async (client) => {
    // Look up the magic link by token regardless of used/expiry so we
    // can branch the error code — UI uses MAGIC_LINK_EXPIRED /
    // MAGIC_LINK_USED to offer a "send me a new link" CTA instead of a
    // generic "invalid token" dead end.
    const result = await client.query(
      `SELECT * FROM platform.magic_links WHERE token_hash = $1`,
      [tokenHash]
    );

    const magicLink = result.rows[0] as MagicLink | undefined;
    if (!magicLink) {
      throw new AppError(400, 'INVALID_TOKEN', 'Invalid verification link. Please request a new one.');
    }

    if (magicLink.used) {
      throw new AppError(400, 'MAGIC_LINK_USED', 'This link has already been used. Please request a new one.');
    }

    if (new Date(magicLink.expires_at) <= new Date()) {
      throw new AppError(400, 'MAGIC_LINK_EXPIRED', 'This link has expired. Please request a new one.');
    }

    // Mark as used
    await client.query(
      'UPDATE platform.magic_links SET used = true WHERE id = $1',
      [magicLink.id]
    );

    return magicLink;
  });
}

export async function completeSignup(magicLink: MagicLink): Promise<TokenPair> {
  const metadata = magicLink.metadata as { name: string; tenantName: string } | null;
  if (!metadata) {
    throw new AppError(400, 'INVALID_METADATA', 'Signup metadata missing');
  }

  // completeSignup creates a brand-new tenant + first user; no tenant
  // context exists yet. Admin bypass explicit.
  return withAdminTransaction(async (client) => {
    // Check if this is the first user on the platform (platform admin bootstrap)
    const userCountResult = await client.query('SELECT COUNT(*) FROM platform.users');
    const isFirstUser = parseInt(userCountResult.rows[0].count, 10) === 0;

    // Determine the role
    let roleSlug: string;
    let isPlatformAdmin = false;

    if (isFirstUser) {
      roleSlug = 'platform_admin';
      isPlatformAdmin = true;
    } else {
      roleSlug = 'owner';
    }

    const roleResult = await client.query(
      'SELECT id FROM platform.roles WHERE slug = $1',
      [roleSlug]
    );
    if (roleResult.rows.length === 0) {
      throw new AppError(500, 'ROLE_NOT_FOUND', `Role '${roleSlug}' not found`);
    }
    const roleId = roleResult.rows[0].id;

    // Create slug from tenant name
    const slug = normalizeSlug(metadata.tenantName);
    if (!slug) {
      throw new AppError(400, 'INVALID_TENANT_NAME', 'Organization name must contain at least one letter or number.');
    }

    // Check tenant name uniqueness (case-insensitive)
    const existingTenant = await client.query(
      'SELECT id FROM platform.tenants WHERE LOWER(name) = LOWER($1)',
      [metadata.tenantName]
    );
    if (existingTenant.rows.length > 0) {
      throw new AppError(409, 'TENANT_EXISTS', 'An organization with this name already exists. Please choose a different name.');
    }

    // Re-check slug collision at commit time — covers races where two
    // signups were initiated concurrently with names that normalize to
    // the same slug. Throwing here surfaces a legible error instead of
    // a raw unique-constraint 500 on the INSERT below.
    const existingSlug = await client.query(
      'SELECT id FROM platform.tenants WHERE slug = $1',
      [slug]
    );
    if (existingSlug.rows.length > 0) {
      throw new AppError(409, 'SLUG_TAKEN', 'That organization name collides with an existing one. Please pick a more distinct name.');
    }

    // Create tenant
    const tenantResult = await client.query(
      `INSERT INTO platform.tenants (name, slug)
       VALUES ($1, $2)
       RETURNING *`,
      [metadata.tenantName, slug]
    );
    const tenant = tenantResult.rows[0];

    // Create user
    const userResult = await client.query(
      `INSERT INTO platform.users (tenant_id, email, name, role_id, is_owner, status)
       VALUES ($1, $2, $3, $4, true, 'active')
       RETURNING *`,
      [tenant.id, magicLink.email, metadata.name, roleId]
    );
    const user = userResult.rows[0];

    // Link owner to tenant
    await client.query(
      'UPDATE platform.tenants SET owner_user_id = $1 WHERE id = $2',
      [user.id, tenant.id]
    );

    // Create billing state for tenant
    await client.query(
      `INSERT INTO platform.billing_state (tenant_id, plan_tier, dashboard_limit, payment_status)
       VALUES ($1, 'free', 0, 'none')`,
      [tenant.id]
    );

    // Create warehouse schema
    const schemaName = `tn_${tenant.id.replace(/-/g, '')}`;
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);

    // Get permissions for this user
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [roleId]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    // Create session
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, tenant.id, refreshTokenHash, expiresAt]
    );

    const flags = await getUserFlags(user.id);
    const accessToken = signAccessToken({
      sub: user.id,
      tid: tenant.id,
      role: roleSlug,
      permissions,
      is_owner: true,
      is_platform_admin: isPlatformAdmin,
      has_admin: flags.has_admin,
      has_billing: flags.has_billing,
      has_replay: flags.has_replay,
    });

    auditService.log({
      tenantId: tenant.id,
      userId: user.id,
      action: 'user.signup',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { is_platform_admin: isPlatformAdmin },
    });

    // Dispatch account.created webhook event
    import('./webhook.service').then(wh => {
      wh.dispatchEvent(tenant.id, 'account.created', {
        userId: user.id,
        email: magicLink.email,
        name: metadata.name,
        tenantId: tenant.id,
        tenantName: metadata.tenantName,
      });
    }).catch(() => {});

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

export async function completeLogin(magicLink: MagicLink, selectedTenantId?: string): Promise<TokenPair & { tenants?: { id: string; name: string; role: string }[] }> {
  // Magic-link consumption + user lookup spans every tenant that owns
  // the email (multi-tenant accounts). Admin bypass explicit — we pick
  // the tenant BEFORE binding to its context.
  return withAdminTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT u.*, r.slug as role_slug, t.name as tenant_name
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       JOIN platform.tenants t ON t.id = u.tenant_id
       WHERE u.email = $1 AND u.status = 'active'`,
      [magicLink.email]
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found or inactive');
    }

    // Filter out archived/suspended tenants for non-platform-admins
    const activeUsers = userResult.rows.filter((u: any) => {
      if (u.role_slug === 'platform_admin') return true;
      return true; // We check tenant status below per-user
    });

    // If multiple tenants and no selection yet, return tenant list
    if (activeUsers.length > 1 && !selectedTenantId) {
      // Check which tenants are active
      const tenantList: { id: string; name: string; role: string }[] = [];
      for (const u of activeUsers) {
        if (u.role_slug === 'platform_admin') {
          tenantList.push({ id: u.tenant_id, name: u.tenant_name, role: u.role_slug });
          continue;
        }
        const tResult = await client.query('SELECT status FROM platform.tenants WHERE id = $1', [u.tenant_id]);
        if (tResult.rows.length > 0 && !['archived', 'suspended'].includes(tResult.rows[0].status)) {
          tenantList.push({ id: u.tenant_id, name: u.tenant_name, role: u.role_slug });
        }
      }
      if (tenantList.length > 1) {
        return {
          accessToken: '',
          refreshToken: '',
          sessionId: '',
          tenants: tenantList,
        };
      }
      // Only one active tenant — auto-select
      if (tenantList.length === 1) {
        selectedTenantId = tenantList[0].id;
      }
    }

    // Pick the right user record
    let user: any;
    if (selectedTenantId) {
      user = activeUsers.find((u: any) => u.tenant_id === selectedTenantId);
      if (!user) throw new AppError(400, 'INVALID_TENANT', 'You do not have access to that organization');
    } else {
      user = activeUsers[0];
    }

    // Check if tenant is archived/suspended (skip for platform admins)
    if (user.role_slug !== 'platform_admin') {
      const tenantResult = await client.query(
        'SELECT status FROM platform.tenants WHERE id = $1',
        [user.tenant_id]
      );
      if (tenantResult.rows.length > 0 && ['archived', 'suspended'].includes(tenantResult.rows[0].status)) {
        throw new AppError(403, 'TENANT_INACTIVE', 'This organization is currently inactive. Please contact support.');
      }
    }

    // Update last login
    await client.query(
      'UPDATE platform.users SET last_login_at = now() WHERE id = $1',
      [user.id]
    );

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [user.role_id]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    const isPlatformAdmin = user.role_slug === 'platform_admin';

    // Create session
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, user.tenant_id, refreshTokenHash, expiresAt]
    );

    const loginFlags = await getUserFlags(user.id);
    const accessToken = signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role_slug,
      permissions,
      is_owner: user.is_owner,
      is_platform_admin: isPlatformAdmin,
      has_admin: loginFlags.has_admin,
      has_billing: loginFlags.has_billing,
      has_replay: loginFlags.has_replay,
    });

    auditService.log({
      tenantId: user.tenant_id,
      userId: user.id,
      action: 'user.login',
      resourceType: 'user',
      resourceId: user.id,
    });

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

export async function loginToTenant(email: string, tenantId: string): Promise<TokenPair> {
  // Tenant switching path — finds the user record for this email in
  // the target tenant without having been bound to that tenant's
  // context yet. Admin bypass explicit.
  return withAdminTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT u.*, r.slug as role_slug
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       WHERE u.email = $1 AND u.tenant_id = $2 AND u.status = 'active'`,
      [email, tenantId]
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found in that organization');
    }

    const user = userResult.rows[0];

    // Check if tenant is archived/suspended
    if (user.role_slug !== 'platform_admin') {
      const tenantResult = await client.query(
        'SELECT status FROM platform.tenants WHERE id = $1',
        [user.tenant_id]
      );
      if (tenantResult.rows.length > 0 && ['archived', 'suspended'].includes(tenantResult.rows[0].status)) {
        throw new AppError(403, 'TENANT_INACTIVE', 'This organization is currently inactive. Please contact support.');
      }
    }

    // Update last login
    await client.query('UPDATE platform.users SET last_login_at = now() WHERE id = $1', [user.id]);

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [user.role_id]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    const isPlatformAdmin = user.role_slug === 'platform_admin';

    // Create session
    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user.id, user.tenant_id, refreshTokenHash, expiresAt]
    );

    const tenantFlags = await getUserFlags(user.id);
    const accessToken = signAccessToken({
      sub: user.id,
      tid: user.tenant_id,
      role: user.role_slug,
      permissions,
      is_owner: user.is_owner,
      is_platform_admin: isPlatformAdmin,
      has_admin: tenantFlags.has_admin,
      has_billing: tenantFlags.has_billing,
      has_replay: tenantFlags.has_replay,
    });

    auditService.log({
      tenantId: user.tenant_id,
      userId: user.id,
      action: 'user.login',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { tenant_selected: true },
    });

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}

export async function initiateRecovery(email: string): Promise<{ message: string }> {
  // Pre-recovery lookup by email — crosses tenants by construction.
  const user = await withAdminClient(async (client) => {
    const result = await client.query(
      'SELECT id, tenant_id, name FROM platform.users WHERE email = $1 AND status = $2',
      [email, 'active']
    );
    return result.rows[0];
  });

  if (!user) {
    // Don't reveal whether user exists
    return { message: 'If an account exists, a recovery email has been sent.' };
  }

  const { code, token } = await createMagicLink(email, 'verify', user.tenant_id);

  // Fire-and-forget: don't block the response on SMTP
  sendTemplateEmail('account_recovery', email, {
    name: user.name,
    code,
    link: `${config.webauthn.origin}/auth/recover?token=${token}`,
  }).catch((err) => {
    console.error('Failed to send recovery email:', err);
  });

  return { message: 'If an account exists, a recovery email has been sent.' };
}

export async function refreshSession(refreshTokenHash: string): Promise<TokenPair> {
  // Refresh is cookie-based — no JWT context available yet. The
  // session lookup JOINs user_sessions + users + roles, which requires
  // cross-tenant visibility until we've resolved the session's tenant.
  return withAdminTransaction(async (client) => {
    // Find existing session
    const sessionResult = await client.query(
      `SELECT s.*, u.role_id, u.is_owner, u.email, u.tenant_id, r.slug as role_slug
       FROM platform.user_sessions s
       JOIN platform.users u ON u.id = s.user_id
       JOIN platform.roles r ON r.id = u.role_id
       WHERE s.refresh_token_hash = $1 AND s.expires_at > now()`,
      [refreshTokenHash]
    );

    if (sessionResult.rows.length === 0) {
      throw new AppError(401, 'INVALID_SESSION', 'Session expired or invalid');
    }

    const session = sessionResult.rows[0];
    const isPlatformAdmin = session.role_slug === 'platform_admin';

    // Rotate refresh token
    const newRefreshToken = signRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    await client.query(
      `UPDATE platform.user_sessions
       SET refresh_token_hash = $1, expires_at = $2, last_active_at = now()
       WHERE id = $3`,
      [newRefreshTokenHash, expiresAt, session.id]
    );

    // Get permissions
    const permResult = await client.query(
      `SELECT p.key FROM platform.permissions p
       JOIN platform.role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [session.role_id]
    );
    const permissions = permResult.rows.map((r: { key: string }) => r.key);

    const refreshFlags = await getUserFlags(session.user_id);
    const accessToken = signAccessToken({
      sub: session.user_id,
      tid: session.tenant_id,
      role: session.role_slug,
      permissions,
      is_owner: session.is_owner,
      is_platform_admin: isPlatformAdmin,
      has_admin: refreshFlags.has_admin,
      has_billing: refreshFlags.has_billing,
      has_replay: refreshFlags.has_replay,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
      sessionId: session.id,
    };
  });
}

export async function logout(userId: string): Promise<void> {
  // Deletes every user_sessions row for this user. Admin bypass —
  // user_sessions is RLS-gated and logout may be invoked in contexts
  // where the session's tenant context isn't already bound.
  await withAdminClient(async (client) => {
    await client.query(
      'DELETE FROM platform.user_sessions WHERE user_id = $1',
      [userId]
    );
  });
}

// ─── Passkey Authentication ──────────────────────────────

export async function beginPasskeyAuth(email?: string): Promise<unknown> {
  const webauthn = await import('../lib/webauthn');

  let allowCredentials: { id: Buffer; transports?: string[] }[] = [];
  let userId: string | null = null;

  if (email) {
    // Get passkeys for this specific user — pre-auth email lookup
    // spans every tenant, and user_passkeys is RLS-gated.
    const result = await withAdminClient(async (client) => {
      const userResult = await client.query(
        'SELECT id FROM platform.users WHERE email = $1 AND status = $2',
        [email, 'active']
      );
      if (userResult.rows.length === 0) return null;
      userId = userResult.rows[0].id;
      const pkResult = await client.query(
        'SELECT credential_id, transports FROM platform.user_passkeys WHERE user_id = $1',
        [userId]
      );
      return pkResult.rows;
    });

    if (result && result.length > 0) {
      allowCredentials = result.map((r: any) => ({
        id: r.credential_id,
        transports: r.transports,
      }));
    }
  }

  const options = await webauthn.generateAuthOptions(allowCredentials);

  // Store challenge with a unique key (UUID) to avoid collisions.
  // platform_settings is on the carve-out (no RLS) — plain withClient.
  const challengeKey = 'passkey_challenge_' + generateUUID();
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO platform.platform_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [challengeKey, JSON.stringify({ challenge: options.challenge, email, created: Date.now() })]
    );
  });

  return options;
}

export async function completePasskeyAuth(body: any): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
  const webauthn = await import('../lib/webauthn');

  // Find the credential - convert base64url to base64 with proper padding
  const credentialId = body.id;
  let b64 = credentialId.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';

  // Credential → user resolution spans tenants (a passkey uniquely
  // identifies a user; we don't know the tenant until after the look-up).
  const credential = await withAdminClient(async (client) => {
    const result = await client.query(
      `SELECT p.*, u.id as uid, u.email, u.tenant_id, u.name
       FROM platform.user_passkeys p
       JOIN platform.users u ON u.id = p.user_id
       WHERE p.credential_id = decode($1, 'base64')
       AND u.status = 'active'`,
      [b64]
    );
    return result.rows[0];
  });

  if (!credential) {
    throw new AppError(401, 'INVALID_CREDENTIAL', 'Passkey not recognized');
  }

  // Find the stored challenge — platform_settings is on the no-RLS
  // carve-out; plain withClient.
  const challengeData = await withClient(async (client) => {
    const result = await client.query(
      `SELECT key, value FROM platform.platform_settings
       WHERE key LIKE 'passkey_challenge_%' AND updated_at > now() - interval '5 minutes'
       ORDER BY updated_at DESC LIMIT 10`
    );
    return result.rows;
  });

  if (challengeData.length === 0) {
    throw new AppError(401, 'NO_CHALLENGE', 'No active passkey challenge found. Please try again.');
  }

  for (const row of challengeData) {
    try {
      const parsed = JSON.parse(row.value);
      const expectedChallenge = parsed.challenge;
      // Map DB snake_case to StoredPasskey interface camelCase
      const verification = await webauthn.verifyAuthResponse(
        body,
        expectedChallenge,
        {
          credentialId: credential.credential_id,
          publicKey: credential.public_key,
          counter: credential.counter,
          transports: credential.transports,
        }
      );

      if (verification.verified) {
        // Update counter. user_passkeys is RLS-gated — and we haven't
        // bound a tenant context yet, the user's tenant was just
        // resolved above. Admin bypass explicit.
        await withAdminClient(async (client) => {
          await client.query(
            'UPDATE platform.user_passkeys SET counter = $1, last_used_at = now() WHERE id = $2',
            [verification.authenticationInfo.newCounter, credential.id]
          );
          // Clean up used challenge
          await client.query('DELETE FROM platform.platform_settings WHERE key = $1', [row.key]);
        });

        // Create session tokens
        return createSession(credential.uid, credential.tenant_id);
      }
    } catch (e) {
      continue;
    }
  }

  throw new AppError(401, 'VERIFICATION_FAILED', 'Passkey verification failed');
}

export async function createSession(
  userId: string,
  tenantId: string,
  deviceInfo?: Record<string, unknown>
): Promise<TokenPair> {
  // Session creation runs mid-login before the caller has bound tenant
  // context; reads users / roles / permissions and writes user_sessions.
  return withAdminTransaction(async (client) => {
    const userResult = await client.query(
      `SELECT u.*, r.slug as role_slug
       FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    const user = userResult.rows[0];
    const isPlatformAdmin = user.role_slug === 'platform_admin';

    const permissions = await getUserPermissions(userId);
    const flags = await getUserFlags(userId);

    const refreshToken = signRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);
    const expiresAt = new Date(Date.now() + config.jwt.refreshTokenExpiry);

    const sessionResult = await client.query(
      `INSERT INTO platform.user_sessions (user_id, tenant_id, refresh_token_hash, device_info, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, tenantId, refreshTokenHash, deviceInfo ? JSON.stringify(deviceInfo) : null, expiresAt]
    );

    const accessToken = signAccessToken({
      sub: userId,
      tid: tenantId,
      role: user.role_slug,
      permissions,
      is_owner: user.is_owner,
      is_platform_admin: isPlatformAdmin,
      has_admin: flags.has_admin,
      has_billing: flags.has_billing,
      has_replay: flags.has_replay,
    });

    return {
      accessToken,
      refreshToken,
      sessionId: sessionResult.rows[0].id,
    };
  });
}
