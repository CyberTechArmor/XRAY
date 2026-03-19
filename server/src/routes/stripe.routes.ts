import { Router, raw } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as stripeService from '../services/stripe.service';

const router = Router();

// POST /webhook - handle Stripe webhook (signature verification, raw body)
router.post('/webhook', raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    const result = await stripeService.handleWebhook(req.body, signature);
    res.json({
      ok: true,
      data: result,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /portal - create Stripe customer portal session (JWT, billing.manage)
router.get('/portal', authenticateJWT, requirePermission('billing.manage'), async (req, res, next) => {
  try {
    const result = await stripeService.createPortalSession(req.user!.tid);
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
