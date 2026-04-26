import { Router } from 'express';
import * as policyService from '../services/policy.service';
import { getSetting } from '../services/settings.service';
import { AppError } from '../middleware/error-handler';

// Step 11 — public legal-pages surface.
//
// All routes here are GET-only and require no auth. Backed by the
// policy_documents carve-out (migration 039, no RLS) so logged-out
// visitors can hit /legal/<slug> and have the SPA hydrate the
// content. CSRF middleware skips them via methodIsSafe (GET is
// always bypassed).

const router = Router();

// GET /api/legal — public legal index.
//
// Returns:
//   - policies: list of slugs with their latest published version,
//     title, is_required, is_placeholder, published_at.
//   - settings.cookie_banner_enabled / essential_only_default —
//     booleans derived from platform_settings so the landing-page
//     cookie banner can decide whether to render before the user
//     authenticates. Folded into this endpoint (rather than a new
//     /api/public/settings) to keep the public surface area tight.
router.get('/', async (req, res, next) => {
  try {
    const policies = await policyService.listLatest();
    const enabledRaw = (await getSetting('cookie_banner_enabled')) ?? 'true';
    const essentialOnlyRaw = (await getSetting('cookie_banner_essential_only_default')) ?? 'false';
    res.json({
      ok: true,
      data: {
        policies,
        settings: {
          cookie_banner_enabled: enabledRaw === 'true',
          cookie_banner_essential_only_default: essentialOnlyRaw === 'true',
        },
      },
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/legal/:slug — full latest version of one slug.
router.get('/:slug', async (req, res, next) => {
  try {
    const doc = await policyService.getLatest(req.params.slug);
    if (!doc) {
      throw new AppError(404, 'LEGAL_SLUG_NOT_FOUND', 'No published version for that slug');
    }
    res.json({
      ok: true,
      data: doc,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/legal/:slug/v/:version — historical fetch.
//
// Backs the "view archived version" link in Account → Privacy when
// the user wants to read the version they accepted. Independent of
// whether the version is the current latest.
router.get('/:slug/v/:version', async (req, res, next) => {
  try {
    const v = parseInt(req.params.version, 10);
    if (!Number.isFinite(v) || v < 1) {
      throw new AppError(400, 'INVALID_VERSION', 'version must be a positive integer');
    }
    const doc = await policyService.getVersion(req.params.slug, v);
    if (!doc) {
      throw new AppError(404, 'LEGAL_SLUG_NOT_FOUND', 'No such (slug, version)');
    }
    res.json({
      ok: true,
      data: doc,
      meta: { request_id: req.headers['x-request-id'] || '', timestamp: new Date().toISOString() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
