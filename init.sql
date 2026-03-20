-- XRay Platform Database Initialization
-- Creates the platform schema and all tables

CREATE SCHEMA IF NOT EXISTS platform;

-- Tenants
CREATE TABLE platform.tenants (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    slug              TEXT UNIQUE NOT NULL,
    owner_user_id     UUID,
    stripe_customer_id TEXT UNIQUE,
    warehouse_host    TEXT,
    status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'cancelled')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roles (create before users since users references roles)
CREATE TABLE platform.roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    slug            TEXT UNIQUE NOT NULL,
    description     TEXT,
    is_system       BOOLEAN DEFAULT false,
    is_platform     BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permissions
CREATE TABLE platform.permissions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         TEXT UNIQUE NOT NULL,
    label       TEXT NOT NULL,
    category    TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Role Permissions
CREATE TABLE platform.role_permissions (
    role_id         UUID NOT NULL REFERENCES platform.roles(id) ON DELETE CASCADE,
    permission_id   UUID NOT NULL REFERENCES platform.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

-- Users
CREATE TABLE platform.users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    email           TEXT NOT NULL,
    name            TEXT NOT NULL,
    role_id         UUID NOT NULL REFERENCES platform.roles(id),
    is_owner        BOOLEAN NOT NULL DEFAULT false,
    auth_method     TEXT NOT NULL DEFAULT 'magic_link'
                    CHECK (auth_method IN ('passkey', 'magic_link', 'both')),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'deactivated')),
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

-- Add foreign key from tenants.owner_user_id to users after users table exists
ALTER TABLE platform.tenants ADD CONSTRAINT fk_tenants_owner
    FOREIGN KEY (owner_user_id) REFERENCES platform.users(id);

-- User Passkeys
CREATE TABLE platform.user_passkeys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    credential_id   BYTEA UNIQUE NOT NULL,
    public_key      BYTEA NOT NULL,
    counter         BIGINT NOT NULL DEFAULT 0,
    device_name     TEXT,
    transports      TEXT[],
    backed_up       BOOLEAN DEFAULT false,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User Sessions
CREATE TABLE platform.user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL REFERENCES platform.tenants(id),
    refresh_token_hash  TEXT UNIQUE NOT NULL,
    device_info         JSONB,
    expires_at          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_active_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Magic Links
CREATE TABLE platform.magic_links (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL,
    code        TEXT NOT NULL,
    token_hash  TEXT UNIQUE NOT NULL,
    purpose     TEXT NOT NULL
                CHECK (purpose IN ('signup', 'login', 'invite', 'verify')),
    tenant_id   UUID,
    metadata    JSONB,
    used        BOOLEAN DEFAULT false,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_magic_links_expires
    ON platform.magic_links(expires_at) WHERE NOT used;

-- Connections
CREATE TABLE platform.connections (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES platform.tenants(id),
    name              TEXT NOT NULL,
    source_type       TEXT NOT NULL,
    source_detail     TEXT,
    pipeline_ref      TEXT,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'active', 'error', 'disabled')),
    last_sync_at      TIMESTAMPTZ,
    stripe_payment_id TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Connection Tables
CREATE TABLE platform.connection_tables (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id   UUID NOT NULL REFERENCES platform.connections(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    table_name      TEXT NOT NULL,
    description     TEXT,
    row_count       INTEGER,
    last_refresh_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboards
CREATE TABLE platform.dashboards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    name            TEXT NOT NULL,
    description     TEXT,
    view_html       TEXT,
    view_css        TEXT,
    view_js         TEXT,
    fetch_url       TEXT,
    fetch_method    TEXT DEFAULT 'GET' CHECK (fetch_method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
    fetch_headers   JSONB DEFAULT '{}',
    fetch_body      JSONB,
    tile_image_url  TEXT,
    last_viewed_at  TIMESTAMPTZ,
    is_public       BOOLEAN DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'archived')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Connection templates for reusable HTTP request patterns
CREATE TABLE platform.connection_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    description     TEXT,
    fetch_method    TEXT DEFAULT 'GET',
    fetch_url       TEXT,
    fetch_headers   JSONB DEFAULT '{}',
    fetch_body      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenant notes
CREATE TABLE platform.tenant_notes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
    author_id       UUID NOT NULL REFERENCES platform.users(id),
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard Access
CREATE TABLE platform.dashboard_access (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    granted_by      UUID REFERENCES platform.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dashboard_id, user_id)
);

-- Dashboard Sources
CREATE TABLE platform.dashboard_sources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    connection_id   UUID REFERENCES platform.connections(id),
    source_key      TEXT NOT NULL,
    table_name      TEXT NOT NULL,
    query_template  TEXT,
    refresh_cadence TEXT NOT NULL DEFAULT 'hourly'
                    CHECK (refresh_cadence IN ('daily', 'hourly', '5min', 'realtime')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dashboard Embeds
CREATE TABLE platform.dashboard_embeds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID NOT NULL REFERENCES platform.dashboards(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    embed_token     TEXT UNIQUE NOT NULL,
    allowed_domains TEXT[],
    created_by      UUID REFERENCES platform.users(id),
    is_active       BOOLEAN DEFAULT true,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Invitations
CREATE TABLE platform.invitations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    email           TEXT NOT NULL,
    role_id         UUID NOT NULL REFERENCES platform.roles(id),
    invited_by      UUID NOT NULL REFERENCES platform.users(id),
    dashboard_ids   UUID[],
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Billing State
CREATE TABLE platform.billing_state (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id               UUID UNIQUE NOT NULL REFERENCES platform.tenants(id),
    stripe_subscription_id  TEXT,
    plan_tier               TEXT NOT NULL DEFAULT 'free'
                            CHECK (plan_tier IN ('free', 'starter', 'professional')),
    dashboard_limit         INTEGER NOT NULL DEFAULT 0,
    current_period_end      TIMESTAMPTZ,
    payment_status          TEXT DEFAULT 'none'
                            CHECK (payment_status IN ('none', 'active', 'past_due',
                                                       'cancelled', 'trialing')),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Platform Settings
CREATE TABLE platform.platform_settings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key         TEXT UNIQUE NOT NULL,
    value       TEXT,
    is_secret   BOOLEAN DEFAULT false,
    updated_by  UUID REFERENCES platform.users(id),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Email Templates
CREATE TABLE platform.email_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key    TEXT UNIQUE NOT NULL,
    subject         TEXT NOT NULL,
    body_html       TEXT NOT NULL,
    body_text       TEXT NOT NULL,
    variables       TEXT[] NOT NULL,
    description     TEXT,
    updated_by      UUID REFERENCES platform.users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- API Keys (for external integrations like n8n)
CREATE TABLE platform.api_keys (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES platform.tenants(id),
    name            TEXT NOT NULL,
    key_prefix      TEXT NOT NULL,
    key_hash        TEXT UNIQUE NOT NULL,
    scopes          TEXT[] NOT NULL DEFAULT '{}',
    created_by      UUID NOT NULL REFERENCES platform.users(id),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_hash ON platform.api_keys(key_hash) WHERE is_active;

-- Webhooks (inbound endpoints per connection)
CREATE TABLE platform.webhooks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    connection_id   UUID NOT NULL REFERENCES platform.connections(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL REFERENCES platform.tenants(id),
    name            TEXT NOT NULL,
    url_token       TEXT UNIQUE NOT NULL,
    secret          TEXT,
    events          TEXT[] NOT NULL DEFAULT '{data.push}',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    last_triggered_at TIMESTAMPTZ,
    failure_count   INTEGER NOT NULL DEFAULT 0,
    created_by      UUID NOT NULL REFERENCES platform.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhooks_url_token ON platform.webhooks(url_token) WHERE is_active;
CREATE INDEX idx_webhooks_connection ON platform.webhooks(connection_id);

-- Audit Log
CREATE TABLE platform.audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    user_id         UUID,
    action          TEXT NOT NULL,
    resource_type   TEXT,
    resource_id     UUID,
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_tenant_time
    ON platform.audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_user_time
    ON platform.audit_log(user_id, created_at DESC);

-- Row-Level Security
ALTER TABLE platform.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.dashboards ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.dashboard_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.dashboard_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.connection_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.billing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.user_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.dashboard_embeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.webhooks ENABLE ROW LEVEL SECURITY;

-- RLS Policies: tenant isolation
CREATE POLICY tenant_isolation ON platform.users USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.dashboards USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.dashboard_access USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.dashboard_sources USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.connections USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.connection_tables USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.invitations USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.billing_state USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.user_passkeys USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.user_sessions USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.audit_log USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.dashboard_embeds USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.api_keys USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
CREATE POLICY tenant_isolation ON platform.webhooks USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ─── Seed: Roles ────────────────────────────────────────────────────────────
INSERT INTO platform.roles (name, slug, description, is_system, is_platform) VALUES
  ('Platform Admin', 'platform_admin', 'Full platform access — manages all tenants and settings', true, true),
  ('Owner',          'owner',          'Tenant owner — full access within their organization',     true, false),
  ('Admin',          'admin',          'Tenant admin — manages users, dashboards, connections',    true, false),
  ('Member',         'member',         'Standard member — views dashboards, limited config',       true, false),
  ('Viewer',         'viewer',         'View-only access to assigned dashboards',                  true, false);

-- ─── Seed: Permissions ──────────────────────────────────────────────────────
INSERT INTO platform.permissions (key, label, category, description) VALUES
  -- Platform
  ('platform.admin',      'Platform admin',     'platform', 'Full platform administration'),
  -- Account
  ('account.view',        'View account',       'account',  'View own profile and sessions'),
  ('account.edit',        'Edit account',       'account',  'Edit own profile, register passkeys'),
  -- Users / Team
  ('users.view',          'View users',         'users',    'View team members and invitations'),
  ('users.manage',        'Manage users',       'users',    'Invite, edit roles, suspend users'),
  -- Dashboards
  ('dashboards.view',     'View dashboards',    'dashboards', 'View assigned dashboards'),
  ('dashboards.manage',   'Manage dashboards',  'dashboards', 'Create, edit, delete dashboards'),
  -- Connections
  ('connections.view',    'View connections',    'connections', 'View data connections'),
  ('connections.manage',  'Manage connections',  'connections', 'Create, edit, delete connections'),
  -- Billing
  ('billing.view',        'View billing',       'billing',  'View plan and invoices'),
  ('billing.manage',      'Manage billing',     'billing',  'Change plan, update payment method'),
  -- Audit
  ('audit.view',          'View audit log',     'audit',    'View tenant audit log');

-- ─── Seed: Role → Permission mappings ───────────────────────────────────────
-- platform_admin gets everything
INSERT INTO platform.role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
  WHERE r.slug = 'platform_admin';

-- owner gets everything except platform.admin
INSERT INTO platform.role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
  WHERE r.slug = 'owner' AND p.key != 'platform.admin';

-- admin gets most things except billing.manage and platform.admin
INSERT INTO platform.role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
  WHERE r.slug = 'admin' AND p.key NOT IN ('platform.admin', 'billing.manage');

-- member gets view permissions + account
INSERT INTO platform.role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
  WHERE r.slug = 'member' AND p.key IN (
    'account.view', 'account.edit', 'dashboards.view', 'connections.view',
    'users.view', 'billing.view', 'audit.view'
  );

-- viewer gets minimal access
INSERT INTO platform.role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM platform.roles r CROSS JOIN platform.permissions p
  WHERE r.slug = 'viewer' AND p.key IN ('account.view', 'account.edit', 'dashboards.view');

-- ─── Seed: Email Templates ──────────────────────────────────────────────────
INSERT INTO platform.email_templates (template_key, subject, body_html, body_text, variables, description) VALUES
(
  'signup_verification',
  'Verify your XRay account',
  '<h2>Welcome to XRay!</h2><p>Hi {{name}},</p><p>Your verification code is:</p><h1 style="letter-spacing:.2em;font-size:32px;text-align:center">{{code}}</h1><p>Or click the link below:</p><p><a href="{{link}}">Complete signup</a></p><p>This code expires in 10 minutes.</p>',
  'Hi {{name}}, your verification code is: {{code}}. Or visit: {{link}}. Expires in 10 minutes.',
  ARRAY['name', 'code', 'link'],
  'Sent when a new user signs up'
),
(
  'login_code',
  'Your XRay sign-in code',
  '<h2>Sign in to XRay</h2><p>Hi {{name}},</p><p>Your sign-in code is:</p><h1 style="letter-spacing:.2em;font-size:32px;text-align:center">{{code}}</h1><p>Or click the link below:</p><p><a href="{{link}}">Sign in</a></p><p>This code expires in 10 minutes.</p>',
  'Hi {{name}}, your sign-in code is: {{code}}. Or visit: {{link}}. Expires in 10 minutes.',
  ARRAY['name', 'code', 'link'],
  'Sent when a user requests a magic link login'
),
(
  'account_recovery',
  'XRay account recovery',
  '<h2>Account recovery</h2><p>Hi {{name}},</p><p>Your recovery code is:</p><h1 style="letter-spacing:.2em;font-size:32px;text-align:center">{{code}}</h1><p>Or click the link below:</p><p><a href="{{link}}">Recover account</a></p><p>This code expires in 10 minutes.</p>',
  'Hi {{name}}, your recovery code is: {{code}}. Or visit: {{link}}. Expires in 10 minutes.',
  ARRAY['name', 'code', 'link'],
  'Sent when a user requests account recovery'
),
(
  'invitation',
  'You''re invited to join {{tenant_name}} on XRay',
  '<h2>You''re invited!</h2><p>Hi,</p><p>{{inviter_name}} has invited you to join <strong>{{tenant_name}}</strong> on XRay BI.</p><p><a href="{{link}}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>',
  '{{inviter_name}} has invited you to join {{tenant_name}} on XRay BI. Visit: {{link}}. Expires in 7 days.',
  ARRAY['inviter_name', 'tenant_name', 'link'],
  'Sent when a team member is invited'
);

-- RLS Policies: platform admin bypass
CREATE POLICY platform_admin_bypass ON platform.users USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.dashboards USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.dashboard_access USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.dashboard_sources USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.connections USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.connection_tables USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.invitations USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.billing_state USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.user_passkeys USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.user_sessions USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.audit_log USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.dashboard_embeds USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.api_keys USING (current_setting('app.is_platform_admin', true)::boolean = true);
CREATE POLICY platform_admin_bypass ON platform.webhooks USING (current_setting('app.is_platform_admin', true)::boolean = true);
