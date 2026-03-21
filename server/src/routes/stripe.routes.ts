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
    const result = await stripeService.getBillingStatus(req.user!.tid);
    const VISION_PRODUCT = 'prod_UB9nZ8qktPbtyi';
    const DASHBOARD_PRODUCT = 'prod_UB9fsE1JmQjRgw';
    let hasVision = false;
    let dashSlots = 0;
    for (const s of result.subscriptions) {
      if (s.status === 'active' || s.status === 'trialing' || (s.cancelAtPeriodEnd && s.currentPeriodEnd && new Date(s.currentPeriodEnd) > new Date())) {
        if (s.productId === VISION_PRODUCT) hasVision = true;
        if (s.productId === DASHBOARD_PRODUCT) dashSlots += s.quantity;
      }
    }
    res.json({ ok: true, data: { hasVision, dashSlots } });
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
