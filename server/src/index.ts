import express from 'express';
import http from 'http';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
// Rate limiting removed
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

// Rate limiting removed

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, data: { status: 'healthy', timestamp: new Date().toISOString() } });
});

// Mount routes
app.use('/api/auth', authRoutes);
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

    const server = http.createServer(app);
    initWebSocketServer(server);
    server.listen(config.port, () => {
      console.log(`XRay server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });

    // Periodically finalize stale replay sessions (every 5 minutes)
    try {
      const { finalizeStaleActiveSessions } = require('./services/replay.service');
      setInterval(() => {
        finalizeStaleActiveSessions(120).catch((err: any) => {
          console.error('[Replay] Stale session cleanup error:', err);
        });
      }, 5 * 60 * 1000);
    } catch (e) {
      // Non-fatal if replay service not available
    }
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

export default app;
