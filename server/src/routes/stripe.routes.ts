import { Router, raw } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as stripeService from '../services/stripe.service';
import * as tenantService from '../services/tenant.service';
import { config } from '../config';
import { z } from 'zod';
import { validateBody } from '../lib/validation';

const router = Router();

const checkoutSchema = z.object({
  items: z.array(z.object({
    productId: z.string().min(1),
    quantity: z.number().int().min(1).max(50),
  })).min(1),
  returnPath: z.string().optional(),
});

// POST /webhook - handle Stripe webhook (signature verification, raw body)
router.post('/webhook', raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const signature = req.headers['stripe-signature'];
    if (!signature || typeof signature !== 'string') {
      res.status(400).json({
        ok: false,
        error: { code: 'INVALID_REQUEST', message: 'Missing stripe-signature header' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    await stripeService.handleWebhook(req.body, signature);
    res.json({
      ok: true,
      data: { received: true },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /status - get billing status with live Stripe data (JWT, billing.view)
router.get('/status', authenticateJWT, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const result = await stripeService.getBillingStatus(req.user!.tid);
    // Check for billing override
    const { getSetting } = await import('../services/settings.service');
    const override = await getSetting('billing.override.' + req.user!.tid);
    if (override === 'true') {
      (result as any).billingOverride = true;
    }
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /plan - lightweight billing check for dashboard access (JWT, dashboards.view only)
router.get('/plan', authenticateJWT, async (req, res, next) => {
  try {
    const { getSetting } = await import('../services/settings.service');
    const override = await getSetting('billing.override.' + req.user!.tid);
    if (override === 'true') {
      res.json({ ok: true, data: { hasVision: true, dashSlots: 999, billingOverride: true } });
      return;
    }
    let hasVision = false;
    try {
      const result = await stripeService.getBillingStatus(req.user!.tid);
      // Load dynamic product list from settings
      const gateProductsRaw = await getSetting('stripe_gate_products');
      let gateProducts: Array<{ productId: string; mode: string }> = [];
      if (gateProductsRaw) {
        try { gateProducts = JSON.parse(gateProductsRaw); } catch { /* ignore bad JSON */ }
      }
      if (gateProducts.length > 0) {
        const now = new Date();
        for (const s of result.subscriptions) {
          const isActive = s.status === 'active' || s.status === 'trialing' ||
            (s.cancelAtPeriodEnd && s.currentPeriodEnd && new Date(s.currentPeriodEnd) > now);
          if (!isActive) continue;
          const matched = gateProducts.find(p => p.productId === s.productId);
          if (!matched) continue;
          if (matched.mode === 'both') {
            hasVision = true;
          } else if (matched.mode === 'past_only') {
            // Legacy: only if subscription was created before current period end
            if (s.currentPeriodEnd && new Date(s.currentPeriodEnd) > now) hasVision = true;
          } else if (matched.mode === 'future_only') {
            // Only new subscriptions (created within current billing cycle)
            hasVision = true;
          }
          if (hasVision) break;
        }
      }
      // If gate products are configured, ONLY grant access via matched subscriptions
      // (billing_state.plan_tier fallback is only for when no gate products are set up)
      if (!hasVision && gateProducts.length === 0 && result.plan !== 'free') { hasVision = true; }
    } catch {
      // Stripe not configured — fall back to billing_state table directly
      const { withClient } = await import('../db/connection');
      const bs = await withClient(async (client) => {
        await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        const r = await client.query('SELECT * FROM platform.billing_state WHERE tenant_id = $1', [req.user!.tid]);
        return r.rows[0];
      });
      if (bs && bs.plan_tier !== 'free') {
        hasVision = true;
      }
    }
    res.json({ ok: true, data: { hasVision } });
  } catch (err) {
    next(err);
  }
});

// GET /override/:tenantId/status - check billing override (platform admin only)
router.get('/override/:tenantId/status', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Platform admin only' } });
    }
    const { getSetting } = await import('../services/settings.service');
    const override = await getSetting('billing.override.' + req.params.tenantId);
    res.json({ ok: true, data: { override: override === 'true' } });
  } catch (err) {
    next(err);
  }
});

// POST /override/:tenantId - set billing override for a tenant (platform admin only)
router.post('/override/:tenantId', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Platform admin only' } });
    }
    const { updateSettings } = await import('../services/settings.service');
    const key = 'billing.override.' + req.params.tenantId;
    const enabled = req.body && req.body.enabled;
    await updateSettings({ [key]: enabled ? 'true' : null }, req.user!.sub);
    res.json({ ok: true, data: { override: !!enabled } });
  } catch (err) {
    next(err);
  }
});

// GET /portal - create Stripe customer portal session (JWT, billing.manage)
router.get('/portal', authenticateJWT, requirePermission('billing.manage'), async (req, res, next) => {
  try {
    const tenant = await tenantService.getTenant(req.user!.tid);
    if (!tenant.stripe_customer_id) {
      res.status(400).json({
        ok: false,
        error: { code: 'NO_CUSTOMER', message: 'No Stripe customer associated. Complete a purchase first.' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    const returnUrl = `${config.webauthn.origin}/#billing`;
    const result = await stripeService.createPortalSession(tenant.stripe_customer_id, returnUrl);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// POST /checkout - create Stripe checkout session (JWT, billing.manage)
router.post('/checkout', authenticateJWT, requirePermission('billing.manage'), async (req, res, next) => {
  try {
    const data = validateBody(checkoutSchema, req.body);
    const tenant = await tenantService.getTenant(req.user!.tid);

    // Get user email for new customers
    const { withClient } = await import('../db/connection');
    const userRow = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const r = await client.query('SELECT email FROM platform.users WHERE id = $1', [req.user!.sub]);
      return r.rows[0];
    });

    const returnUrl = `${config.webauthn.origin}/#${data.returnPath || 'billing'}`;
    const result = await stripeService.createCheckoutSession(
      req.user!.tid,
      tenant.stripe_customer_id,
      data.items,
      returnUrl,
      userRow?.email
    );

    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/billing - list all tenant billing statuses with Stripe details (platform admin only)
router.get('/admin/billing', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Platform admin only' } });
    }
    const { getSetting } = await import('../services/settings.service');
    const { withClient } = await import('../db/connection');

    // Load gate products config
    const gateProductsRaw = await getSetting('stripe_gate_products');
    let gateProducts: Array<{ productId: string; mode: string }> = [];
    if (gateProductsRaw) {
      try { gateProducts = JSON.parse(gateProductsRaw); } catch { /* */ }
    }
    const gateProductIds = new Set(gateProducts.map(p => p.productId));

    // Load billing override settings
    const overrideResult = await withClient(async (client) => {
      const r = await client.query(
        `SELECT key, value FROM platform.platform_settings WHERE key LIKE 'billing.override.%' AND value = 'true'`
      );
      const overrides: Record<string, boolean> = {};
      r.rows.forEach((row: any) => {
        const tid = row.key.replace('billing.override.', '');
        overrides[tid] = true;
      });
      return overrides;
    });

    const result = await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      return client.query(
        `SELECT t.id AS tenant_id, t.name AS tenant_name, t.stripe_customer_id,
                bs.plan_tier, bs.payment_status, bs.stripe_subscription_id,
                bs.dashboard_limit, bs.current_period_end, bs.updated_at AS billing_updated,
                o.email AS owner_email, t.created_at AS tenant_created
         FROM platform.tenants t
         LEFT JOIN platform.billing_state bs ON bs.tenant_id = t.id
         LEFT JOIN platform.users o ON o.id = t.owner_user_id
         ORDER BY t.created_at DESC`
      );
    });

    // Enrich each tenant with live Stripe subscription data
    const enriched = [];
    let stripeClient: any = null;
    let stripeInitError: string | null = null;
    try {
      const secretKey = await getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY;
      if (secretKey) {
        const Stripe = (await import('stripe')).default;
        stripeClient = new Stripe(secretKey, { apiVersion: '2024-06-20' as any });
      } else {
        stripeInitError = 'No Stripe secret key found in settings or environment';
      }
    } catch (e: any) {
      stripeInitError = 'Failed to init Stripe client: ' + e.message;
    }

    for (const row of result.rows) {
      const tenant: any = { ...row, stripeSubscriptions: [], hasGateAccess: false, billingOverride: !!overrideResult[row.tenant_id] };
      if (tenant.billingOverride) {
        tenant.hasGateAccess = true;
      }
      if (row.stripe_customer_id && stripeClient) {
        try {
          // Don't use expand (Stripe has a 4-level depth limit)
          // Fetch subscriptions without product expansion
          const subs = await stripeClient.subscriptions.list({
            customer: row.stripe_customer_id,
            status: 'all',
            limit: 20,
          });
          // Collect unique product IDs to fetch names in bulk
          const productIds = new Set<string>();
          for (const sub of subs.data) {
            const item = sub.items?.data?.[0];
            const prodId = typeof item?.price?.product === 'string' ? item.price.product : item?.price?.product?.id;
            if (prodId) productIds.add(prodId);
          }
          // Fetch product names
          const productNames: Record<string, string> = {};
          for (const pid of productIds) {
            try {
              const prod = await stripeClient.products.retrieve(pid);
              productNames[pid] = prod.name || pid;
            } catch { productNames[pid] = pid; }
          }

          tenant.stripeSubscriptions = subs.data.map((sub: any) => {
            const item = sub.items?.data?.[0];
            const productId = typeof item?.price?.product === 'string' ? item.price.product : (item?.price?.product?.id || '');
            return {
              id: sub.id,
              productId,
              productName: productNames[productId] || 'Subscription',
              status: sub.status,
              quantity: item?.quantity || 1,
              currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
              cancelAtPeriodEnd: sub.cancel_at_period_end,
              isGateProduct: gateProductIds.has(productId),
            };
          });
          // Check if any active gate product subscription
          const now = new Date();
          for (const s of tenant.stripeSubscriptions) {
            if (!s.isGateProduct) continue;
            const isActive = s.status === 'active' || s.status === 'trialing' ||
              (s.cancelAtPeriodEnd && s.currentPeriodEnd && new Date(s.currentPeriodEnd) > now);
            if (isActive) { tenant.hasGateAccess = true; break; }
          }
        } catch (err: any) {
          tenant.stripeError = err.message || 'Stripe API error';
        }
      }
      enriched.push(tenant);
    }

    res.json({
      ok: true,
      data: enriched,
      meta: {
        request_id: req.headers['x-request-id'] || '',
        timestamp: new Date().toISOString(),
        stripeConnected: !!stripeClient,
        stripeInitError: stripeInitError || undefined,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/link-customer - manually link a Stripe customer to a tenant (platform admin only)
router.post('/admin/link-customer', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Platform admin only' } });
    }
    const { tenantId, stripeCustomerId } = req.body;
    if (!tenantId || !stripeCustomerId) {
      return res.status(400).json({ ok: false, error: { code: 'MISSING_FIELDS', message: 'tenantId and stripeCustomerId required' } });
    }
    const { withClient } = await import('../db/connection');
    await withClient(async (client) => {
      await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      await client.query('UPDATE platform.tenants SET stripe_customer_id = $1, updated_at = now() WHERE id = $2', [stripeCustomerId, tenantId]);
      await client.query(
        `INSERT INTO platform.billing_state (tenant_id, payment_status, plan_tier, updated_at)
         VALUES ($1, 'active', 'starter', now())
         ON CONFLICT (tenant_id) DO UPDATE SET payment_status = 'active',
           plan_tier = CASE WHEN platform.billing_state.plan_tier = 'free' THEN 'starter' ELSE platform.billing_state.plan_tier END,
           updated_at = now()`,
        [tenantId]
      );
    });
    res.json({ ok: true, data: { linked: true } });
  } catch (err) {
    next(err);
  }
});

// GET /admin/debug/:customerId - debug Stripe customer subscriptions (platform admin only)
router.get('/admin/debug/:customerId', authenticateJWT, async (req, res, next) => {
  try {
    if (!req.user!.is_platform_admin) {
      return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    const { getSetting } = await import('../services/settings.service');
    const secretKey = await getSetting('stripe_secret_key') || process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      return res.json({ ok: false, error: { message: 'No Stripe secret key configured', settingFound: false, envFound: !!process.env.STRIPE_SECRET_KEY } });
    }
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' as any });
    const customerId = req.params.customerId;

    const customer = await stripe.customers.retrieve(customerId) as any;
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 20,
    });

    // Fetch product names
    const subDetails = [];
    for (const s of subs.data) {
      const item = s.items?.data?.[0];
      const productId = typeof item?.price?.product === 'string' ? item.price.product : '';
      let productName = productId;
      if (productId) {
        try { const p = await stripe.products.retrieve(productId); productName = p.name || productId; } catch {}
      }
      subDetails.push({
        id: s.id,
        status: s.status,
        productId,
        productName,
        priceId: item?.price?.id,
        currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
      });
    }

    res.json({
      ok: true,
      data: {
        keyPrefix: secretKey.substring(0, 10) + '...',
        customer: { id: customer.id, email: customer.email, name: customer.name, deleted: customer.deleted },
        subscriptionCount: subs.data.length,
        subscriptions: subDetails,
      },
    });
  } catch (err: any) {
    res.json({ ok: false, error: { message: err.message, type: err.type, statusCode: err.statusCode } });
  }
});

// GET /config - get Stripe config (JWT, billing.view)
router.get('/config', authenticateJWT, requirePermission('billing.view'), async (req, res, next) => {
  try {
    const result = await stripeService.getStripeConfig();
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
