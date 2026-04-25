import express from 'express';
import http from 'http';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { globalIpDeviceLimiter } from './middleware/rate-limit';
import { perEmailAuthAttemptLimiter } from './middleware/auth-attempts';
import { getPool } from './db/connection';
import { initWebSocketServer } from './ws';

// Route imports
import authRoutes from './routes/auth.routes';
import stripeRoutes from './routes/stripe.routes';
import tenantRoutes from './routes/tenant.routes';
import userRoutes from './routes/user.routes';
import roleRoutes from './routes/role.routes';
import bundleRoutes from './routes/bundle.routes';
import dashboardRoutes from './routes/dashboard.routes';
import connectionRoutes from './routes/connection.routes';
import dataRoutes from './routes/data.routes';
import invitationRoutes from './routes/invitation.routes';
import embedRoutes from './routes/embed.routes';
import adminRoutes from './routes/admin.routes';
import auditRoutes from './routes/audit.routes';
import apikeyRoutes from './routes/apikey.routes';
import webhookRoutes from './routes/webhook.routes';
import meetRoutes from './routes/meet.routes';
import shareRoutes from './routes/share.routes';
import inboxRoutes from './routes/inbox.routes';
import replayRoutes from './routes/replay.routes';
import aiRoutes from './routes/ai.routes';
import adminAiRoutes from './routes/admin.ai.routes';
import oauthRoutes from './routes/oauth.routes';
import integrationRoutes from './routes/integration.routes';
import { finalizeStaleActiveSessions } from './services/replay.service';
import { startScheduler as startOauthScheduler } from './lib/oauth-scheduler';
import { warnIfUnconfigured as warnIfPipelineJwtUnconfigured } from './lib/pipeline-jwt';
// Upload routes loaded lazily to avoid crash if multer not installed
let uploadRoutes: any;
try {
  uploadRoutes = require('./routes/upload.routes').default;
} catch (e) {
  console.warn('Upload routes disabled: multer not installed or upload.routes failed to load');
}

const app = express();

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Managed by NGINX
  crossOriginEmbedderPolicy: false,
}));

// CORS
app.use(cors({
  origin: config.webauthn.origin,
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
}));

// Cookie parser
app.use(cookieParser());

// Body parsing — raw for Stripe webhook and admin import, JSON for everything else
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use('/api/admin/import', express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '100mb' }));
app.use(express.json({ limit: '10mb' }));

// Request ID middleware
app.use((req, _res, next) => {
  if (!req.headers['x-request-id']) {
    req.headers['x-request-id'] = crypto.randomUUID();
  }
  next();
});

// Step 9 brute-force throttling. Two tiers run before route mounting:
//
//   Tier 1 — globalIpDeviceLimiter: 100 req/60s per (IP + UA + lang)
//            fingerprint. Skips /api/health, /api/embed/*, /api/share/*
//            (separate buckets for public surfaces).
//
//   Tier 2 — perEmailAuthAttemptLimiter: scoped to /api/auth/*. DB-backed
//            failure counter against platform.auth_attempts (migration
//            035), trailing 24h window. Hard 429 with retry-after at 20
//            failures; req.attemptCounters carries the remaining count
//            below the limit so handlers can surface a "N attempts left"
//            banner via attachAttemptCounters() in the response body.
//
// See server/src/middleware/rate-limit.ts and middleware/auth-attempts.ts
// for the exact thresholds + skip predicate.
app.use(globalIpDeviceLimiter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, data: { status: 'healthy', timestamp: new Date().toISOString() } });
});

// Mount routes
app.use('/api/auth', perEmailAuthAttemptLimiter, authRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/bundles', bundleRoutes);
app.use('/api/dashboards', dashboardRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/invitations', invitationRoutes);
app.use('/api/embed', embedRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/api-keys', apikeyRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/meet', meetRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/v1/replay', replayRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin/ai', adminAiRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/integrations', integrationRoutes);
if (uploadRoutes) app.use('/api/uploads', uploadRoutes);

// Serve frontend static files (fallback when nginx is not in front)
const frontendDir = path.resolve(__dirname, '../../frontend');
app.use(express.static(frontendDir, { maxAge: 0 }));

// Serve public share page (serves the HTML page for /share/:token)
app.get('/share/:token', (_req, res) => {

  const sharePage = path.resolve(__dirname, '../../frontend/share.html');
  res.sendFile(sharePage, (err: Error) => {
    if (err) {
      // Fallback: redirect to API endpoint
      res.redirect('/api/share/' + _req.params.token);
    }
  });
});

// Serve invite page (serves the main index.html for /invite/:token)
app.get('/invite/:token', (_req, res) => {

  const indexPage = path.resolve(__dirname, '../../frontend/index.html');
  res.sendFile(indexPage, (err: Error) => {
    if (err) {
      res.redirect('/');
    }
  });
});

// SPA fallback — serve index.html for non-API, non-file routes
app.get('*', (_req, res) => {
  const indexPage = path.resolve(__dirname, '../../frontend/index.html');
  res.sendFile(indexPage, (err: Error) => {
    if (err) res.status(404).end();
  });
});

// Error handler (must be last)
app.use(errorHandler);

// Start server
async function start() {
  try {
    // Test database connection
    const pool = getPool();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('Database connected successfully');

    // Run seed on first boot (idempotent)
    try {
      const { execSync } = require('child_process');
      // Check if platform schema exists
      const schemaCheck = await pool.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'platform'"
      );
      if (schemaCheck.rows.length === 0) {
        console.log('First boot detected — running migrations...');
        execSync('npm run migrate', { stdio: 'inherit' });
        console.log('Migrations completed');
      }
    } catch (migrationErr) {
      console.error('Migration check/run failed:', migrationErr);
    }

    // Auto-add missing columns for incremental migrations
    try {
      await pool.query(`ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS replay_enabled BOOLEAN NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS replay_visible BOOLEAN NOT NULL DEFAULT false`);
    } catch (colErr) {
      console.error('Column migration failed:', colErr);
    }

    // Self-healing migrations: any migration SQL we depend on is applied on boot
    // if the feature table is missing. In the container, migrations/ lives at
    // /app/migrations (copied by the Dockerfile from the repo root). __dirname
    // is /app/dist, so the SQL files are one level up.
    const applyMigration = async (sqlFile: string, tableCheck: string, label: string) => {
      try {
        const exists = await pool.query(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = 'platform' AND table_name = $1`,
          [tableCheck]
        );
        if (exists.rows.length > 0) return;
        const fs = require('fs');
        const pathMod = require('path');
        // Try the in-image path first (/app/migrations), then fall back to a
        // host-mount path for bare-metal / tsx dev (server/src/../../migrations).
        const candidates = [
          pathMod.resolve(__dirname, '../migrations', sqlFile),
          pathMod.resolve(__dirname, '../../migrations', sqlFile),
          pathMod.resolve(process.cwd(), 'migrations', sqlFile),
          pathMod.resolve(process.cwd(), '../migrations', sqlFile),
        ];
        const found = candidates.find((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
        if (!found) {
          console.warn(`[migration ${label}] ${sqlFile} not found in any known location:`, candidates);
          return;
        }
        const sql = fs.readFileSync(found, 'utf-8');
        await pool.query(sql);
        console.log(`[migration ${label}] applied ${sqlFile} from ${found}`);
      } catch (err) {
        console.error(`[migration ${label}] failed for ${sqlFile}:`, err);
      }
    };

    await applyMigration('014_ai_integration.sql', 'ai_settings_versions', '014');
    await applyMigration('015_ai_pricing_feedback.sql', 'ai_model_pricing', '015');

    // Migration 016 swaps tenant_isolation for user_scope on AI tables. No new
    // table is added, so the usual "check if table exists" gate doesn't apply.
    // Detect via pg_policies: if user_scope isn't on ai_threads yet, run it.
    try {
      const hasUserScope = await pool.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'platform' AND tablename = 'ai_threads' AND policyname = 'user_scope'`
      );
      if (hasUserScope.rows.length === 0) {
        const fs = require('fs');
        const pathMod = require('path');
        const candidates = [
          pathMod.resolve(__dirname, '../migrations/016_ai_user_rls.sql'),
          pathMod.resolve(__dirname, '../../migrations/016_ai_user_rls.sql'),
          pathMod.resolve(process.cwd(), 'migrations/016_ai_user_rls.sql'),
          pathMod.resolve(process.cwd(), '../migrations/016_ai_user_rls.sql'),
        ];
        const found = candidates.find((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
        if (found) {
          await pool.query(fs.readFileSync(found, 'utf-8'));
          console.log('[migration 016] applied user-scope RLS');
        } else {
          console.warn('[migration 016] file not found in any candidate path');
        }
      }
    } catch (err) {
      console.error('[migration 016] failed:', err);
    }

    // Seed any missing default email templates. Admin-edited rows are
    // preserved via ON CONFLICT DO NOTHING on template_key; upgrades
    // that introduce new templates (passkey_registered, billing_locked,
    // etc.) pick them up on first boot without requiring a migration.
    try {
      const { seedDefaultTemplates } = await import('./services/email-templates');
      const result = await seedDefaultTemplates();
      if (result.inserted > 0) {
        console.log(`[email-templates] seeded ${result.inserted} new default template(s) (${result.skipped} already present)`);
      }
    } catch (err) {
      console.error('[email-templates] seed failed:', err);
    }

    const server = http.createServer(app);
    initWebSocketServer(server);
    server.listen(config.port, () => {
      console.log(`XRay server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });

    // Finalize stale replay sessions: run on startup + every 2 minutes
    // Sessions inactive for >30 minutes are considered stale
    finalizeStaleActiveSessions(30).catch(() => {});
    setInterval(() => {
      finalizeStaleActiveSessions(30).catch((err: unknown) => {
        console.error('[Replay] Stale session cleanup error:', err);
      });
    }, 2 * 60 * 1000);

    // OAuth token refresh scheduler: 5-min tick keeps tenant access
    // tokens fresh so render paths become a pure DB read. Boot after
    // the server is listening so the first tick doesn't race anything
    // upstream. warnIfPipelineJwtUnconfigured surfaces the absent-keypair
    // state once so ops see it in logs without boot-breaking.
    warnIfPipelineJwtUnconfigured();
    startOauthScheduler();

  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

export default app;
