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
    is_public       BOOLEAN DEFAULT false,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('draft', 'active', 'archived')),
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
