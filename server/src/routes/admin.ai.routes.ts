import { Router } from 'express';
import { authenticateJWT } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import * as aiService from '../services/ai.service';
import { getSetting, updateSettings } from '../services/settings.service';

const router = Router();

// Build-time version marker so an admin can tell at a glance whether the server
// they are talking to has the current code. Bump this whenever shipping changes
// that the admin diagnostic page should surface.
const AI_BACKEND_VERSION = 'ai-2026-04-19-02';

// All routes here require platform admin (the ai.admin permission is granted only to platform_admin)
router.use(authenticateJWT, requirePermission('platform.admin'));

// GET /api/admin/ai/_health — diagnostic probe. Always returns ok:true so the
// admin UI always has something concrete to render. Each probe is wrapped in
// its own try/catch; whichever one throws leaves its field null and its error
// message in the errors[] array. This stops one bad query from breaking the
// whole endpoint behind a generic INTERNAL_ERROR.
router.get('/_health', async (_req, res) => {
  const tablesWanted = [
    'ai_settings_versions',
    'ai_dashboard_settings',
    'ai_user_dashboard_prefs',
    'ai_threads',
    'ai_messages',
    'ai_pins',
    'ai_usage_daily',
    'ai_model_pricing',
    'ai_message_feedback',
  ];

  const errors: string[] = [];
  const probe = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err: any) {
      const msg = `${label}: ${err?.code || ''} ${err?.message || String(err)}`.trim();
      console.error('[ai/_health]', msg);
      errors.push(msg);
      return fallback;
    }
  };

  let tables: Record<string, boolean> = {};
  let catalog = 0;
  let settingsCount = 0;
  let currentModel: string | null = null;
  let apiKeyConfigured = false;

  try {
    const { withClient } = await import('../db/connection');

    tables = await probe('tables-present', async () => {
      return await withClient(async (client) => {
        await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
        const tbl = await client.query(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'platform' AND table_name = ANY($1::text[])`,
          [tablesWanted]
        );
        const present = new Set(tbl.rows.map((r: { table_name: string }) => r.table_name));
        const out: Record<string, boolean> = {};
        for (const t of tablesWanted) out[t] = present.has(t);
        return out;
      });
    }, Object.fromEntries(tablesWanted.map((t) => [t, false])));

    if (tables['ai_model_pricing']) {
      catalog = await probe('model-catalog-count', async () => {
        return await withClient(async (client) => {
          await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
          const r = await client.query(`SELECT COUNT(*)::int as c FROM platform.ai_model_pricing WHERE is_active`);
          return r.rows[0]?.c ?? 0;
        });
      }, 0);
    }

    if (tables['ai_settings_versions']) {
      settingsCount = await probe('settings-versions-count', async () => {
        return await withClient(async (client) => {
          await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
          const r = await client.query(`SELECT COUNT(*)::int as c FROM platform.ai_settings_versions`);
          return r.rows[0]?.c ?? 0;
        });
      }, 0);

      currentModel = await probe('current-model-id', async () => {
        return await withClient(async (client) => {
          await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
          const r = await client.query(
            `SELECT model_id FROM platform.ai_settings_versions ORDER BY effective_at DESC LIMIT 1`
          );
          return r.rows[0]?.model_id ?? null;
        });
      }, null);
    }

    apiKeyConfigured = await probe('api-key-setting', async () => {
      const { getSetting } = await import('../services/settings.service');
      return !!(await getSetting('ai.anthropic_api_key'));
    }, false);
  } catch (err: any) {
    errors.push(`outer: ${err?.code || ''} ${err?.message || String(err)}`.trim());
  }

  res.json({
    ok: true,
    data: {
      version: AI_BACKEND_VERSION,
      tables,
      all_tables_present: Object.values(tables).every(Boolean),
      model_catalog_count: catalog,
      settings_versions_count: settingsCount,
      current_model_id: currentModel,
      api_key_configured: apiKeyConfigured,
      errors,
    },
  });
});

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

// GET /api/admin/ai/models — merged list (Anthropic /v1/models + DB catalog)
router.get('/models', async (_req, res, next) => {
  try {
    const result = await aiService.listAvailableModels();
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/ai/pricing — DB pricing catalog (editable)
router.get('/pricing', async (_req, res, next) => {
  try {
    const result = await aiService.listModelPricing();
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/admin/ai/pricing/:modelId — update price/metadata for a model
router.patch('/pricing/:modelId', async (req, res, next) => {
  try {
    const allowed = [
      'display_name', 'tier',
      'input_per_million', 'output_per_million',
      'cache_read_per_million', 'cache_write_per_million',
      'context_window', 'description', 'is_active',
    ] as const;
    const updates: Record<string, unknown> = {};
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
    }
    const result = await aiService.updateModelPricing(req.params.modelId, updates, req.user!.sub);
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/ai/pricing — add a new model to the catalog
router.post('/pricing', async (req, res, next) => {
  try {
    const {
      model_id, display_name, provider, tier,
      input_per_million, output_per_million,
      cache_read_per_million, cache_write_per_million,
      context_window, description, is_active,
    } = req.body || {};
    if (!model_id || !display_name || tier === undefined) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: 'model_id, display_name, tier required' } });
    }
    const result = await aiService.upsertModelPricing(
      {
        model_id,
        display_name,
        provider: provider || 'anthropic',
        tier,
        input_per_million: Number(input_per_million) || 0,
        output_per_million: Number(output_per_million) || 0,
        cache_read_per_million: Number(cache_read_per_million) || 0,
        cache_write_per_million: Number(cache_write_per_million) || 0,
        context_window: context_window ? Number(context_window) : null,
        description: description || null,
        is_active: is_active !== false,
      },
      req.user!.sub
    );
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/ai/usage — aggregated usage + cost
// Query params: groupBy=day|tenant|user|model, from, to, tenantId, userId, limit
router.get('/usage', async (req, res, next) => {
  try {
    const groupBy = (req.query.groupBy as 'day'|'tenant'|'user'|'model') || 'day';
    if (!['day','tenant','user','model'].includes(groupBy)) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_GROUP', message: 'groupBy must be day, tenant, user, or model' } });
    }
    const result = await aiService.getUsageSummary({
      groupBy,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      tenantId: req.query.tenantId as string | undefined,
      userId: req.query.userId as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/ai/conversations — paginated Q&A log with ratings, for analysis
// Query: from, to, tenantId, userId, rating=-1|1|0 (0 = unrated), search, limit, offset
router.get('/conversations', async (req, res, next) => {
  try {
    const ratingRaw = req.query.rating;
    let rating: -1 | 0 | 1 | undefined;
    if (ratingRaw !== undefined) {
      const r = Number(ratingRaw);
      if (r === -1 || r === 0 || r === 1) rating = r as -1 | 0 | 1;
    }
    const result = await aiService.listConversations({
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      tenantId: req.query.tenantId as string | undefined,
      userId: req.query.userId as string | undefined,
      rating,
      search: req.query.search as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      offset: req.query.offset ? parseInt(req.query.offset as string, 10) : undefined,
    });
    res.json({ ok: true, data: result.rows, meta: { total: result.total } });
  } catch (err) {
    next(err);
  }
});

export default router;
