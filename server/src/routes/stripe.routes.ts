import { Router, raw } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as stripeService from '../services/stripe.service';
import * as tenantService from '../services/tenant.service';
import { config } from '../config';

const router = Router();

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

// GET /portal - create Stripe customer portal session (JWT, billing.manage)
router.get('/portal', authenticateJWT, requirePermission('billing.manage'), async (req, res, next) => {
  try {
    const tenant = await tenantService.getTenant(req.user!.tid);
    if (!tenant.stripe_customer_id) {
      res.status(400).json({
        ok: false,
        error: { code: 'NO_CUSTOMER', message: 'No Stripe customer associated with this tenant' },
        meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
      });
      return;
    }
    const returnUrl = `${config.webauthn.origin}/billing`;
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
