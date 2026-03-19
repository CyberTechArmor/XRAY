import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { errorHandler } from './middleware/error-handler';
import { apiRateLimit, authRateLimit } from './middleware/rate-limit';
import { getPool } from './db/connection';

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

// Body parsing — raw for Stripe webhook, JSON for everything else
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Request ID middleware
app.use((req, _res, next) => {
  if (!req.headers['x-request-id']) {
    req.headers['x-request-id'] = crypto.randomUUID();
  }
  next();
});

// Rate limiting
app.use('/api/auth', authRateLimit);
app.use('/api', apiRateLimit);

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

    app.listen(config.port, () => {
      console.log(`XRay server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();

export default app;
