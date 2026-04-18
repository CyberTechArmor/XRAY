import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as aiService from '../services/ai.service';
import { getSetting, updateSettings } from '../services/settings.service';

const router = Router();

// All routes here require platform admin (the ai.admin permission is granted only to platform_admin)
router.use(authenticateJWT, requirePermission('platform.admin'));

// GET /api/admin/ai/settings — current settings + version history head
router.get('/settings', async (_req, res, next) => {
  try {
    const current = await aiService.getCurrentSettings();
    const apiKeySet = !!(await getSetting('ai.anthropic_api_key'));
    res.json({
      ok: true,
      data: {
        current,
        api_key_configured: apiKeySet,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/ai/settings — create a new version (update)
router.post('/settings', async (req, res, next) => {
  try {
    const { model_id, system_prompt, guardrails, per_user_daily_cap, enabled, note } = req.body || {};
    const result = await aiService.createSettingsVersion(
      { model_id, system_prompt, guardrails, per_user_daily_cap, enabled, note },
      req.user!.sub
    );
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/ai/settings/versions — full version history
router.get('/settings/versions', async (_req, res, next) => {
  try {
    const result = await aiService.listSettingsVersions();
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/ai/settings/api-key — set or clear the Anthropic API key (stored encrypted)
router.patch('/settings/api-key', async (req, res, next) => {
  try {
    const { api_key } = req.body || {};
    if (api_key !== null && typeof api_key !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'api_key must be a string or null' } });
    }
    // Empty string or null clears the key
    const toStore = api_key && api_key.trim().length > 0 ? api_key.trim() : null;
    await updateSettings({ 'ai.anthropic_api_key': toStore }, req.user!.sub);
    res.json({ ok: true, data: { configured: !!toStore } });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/ai/dashboards — list all dashboards with their AI enabled state
router.get('/dashboards', async (_req, res, next) => {
  try {
    const result = await aiService.listDashboardSettings();
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/ai/dashboards/:id — toggle AI for a dashboard
router.patch('/dashboards/:id', async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    await aiService.setDashboardEnabled(req.params.id, !!enabled, req.user!.sub);
    res.json({ ok: true, data: { dashboard_id: req.params.id, enabled: !!enabled } });
  } catch (err) {
    next(err);
  }
});

export default router;
