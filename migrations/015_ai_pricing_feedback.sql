-- Migration 015: AI pricing catalog + message feedback (ratings)
--
-- Adds:
--   ai_model_pricing     — catalog of available models + prices/MTok. Drives the model
--                          picker in the admin UI and cost accounting at analysis time.
--                          Seeded with Anthropic Opus 4.7, Sonnet 4.6, Haiku 4.5.
--   ai_message_feedback  — per-message user rating (+1 / -1) + optional note. Used to
--                          identify which answers were helpful and to run analysis on
--                          question/answer quality over time.

CREATE TABLE IF NOT EXISTS platform.ai_model_pricing (
    model_id                  TEXT PRIMARY KEY,
    display_name              TEXT NOT NULL,
    provider                  TEXT NOT NULL DEFAULT 'anthropic',
    tier                      TEXT NOT NULL DEFAULT 'standard'
                              CHECK (tier IN ('flagship', 'standard', 'fast')),
    input_per_million         NUMERIC(12,4) NOT NULL DEFAULT 0,
    output_per_million        NUMERIC(12,4) NOT NULL DEFAULT 0,
    cache_read_per_million    NUMERIC(12,4) NOT NULL DEFAULT 0,
    cache_write_per_million   NUMERIC(12,4) NOT NULL DEFAULT 0,
    context_window            INTEGER,
    description               TEXT,
    is_active                 BOOLEAN NOT NULL DEFAULT true,
    updated_by                UUID REFERENCES platform.users(id),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform.ai_message_feedback (
    message_id     UUID PRIMARY KEY REFERENCES platform.ai_messages(id) ON DELETE CASCADE,
    thread_id      UUID NOT NULL REFERENCES platform.ai_threads(id) ON DELETE CASCADE,
    tenant_id      UUID NOT NULL REFERENCES platform.tenants(id),
    user_id        UUID NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    rating         SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
    note           TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_feedback_tenant_time
    ON platform.ai_message_feedback(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_rating
    ON platform.ai_message_feedback(rating, created_at DESC);

ALTER TABLE platform.ai_message_feedback ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY tenant_isolation ON platform.ai_message_feedback
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY platform_admin_bypass ON platform.ai_message_feedback
        USING (current_setting('app.is_platform_admin', true)::boolean = true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed Anthropic pricing (from claude.com/pricing#api, USD per million tokens).
-- Admins can update these via the admin UI if Anthropic changes prices.
INSERT INTO platform.ai_model_pricing
    (model_id, display_name, provider, tier, input_per_million, output_per_million,
     cache_read_per_million, cache_write_per_million, context_window, description, is_active)
VALUES
    ('claude-opus-4-7', 'Claude Opus 4.7', 'anthropic', 'flagship',
     5.00, 25.00, 0.50, 6.25, 200000,
     'Most intelligent model for agents and coding. Best for deep analysis and nightly briefs.', true),
    ('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'anthropic', 'standard',
     3.00, 15.00, 0.30, 3.75, 200000,
     'Optimal balance of intelligence, cost, and speed. Recommended default for chat.', true),
    ('claude-haiku-4-5', 'Claude Haiku 4.5', 'anthropic', 'fast',
     1.00, 5.00, 0.10, 1.25, 200000,
     'Fastest, most cost-efficient model. Good for high-volume, low-latency use.', true)
ON CONFLICT (model_id) DO NOTHING;
