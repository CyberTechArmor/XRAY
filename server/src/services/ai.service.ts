import { Response } from 'express';
import { withClient, withTenantContext } from '../db/connection';
import { getSetting } from './settings.service';
import { AppError } from '../middleware/error-handler';

// Anthropic Messages API. Using native fetch (Node 18+) to avoid a new npm dep.
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_HISTORY_MESSAGES = 40;
const MAX_CONTEXT_CHARS = 16_000; // hard cap on dashboard-context payload size per turn
const MAX_OUTPUT_TOKENS = 2048;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AiSettings {
  id: string;
  model_id: string;
  system_prompt: string;
  guardrails: string;
  per_user_daily_cap: number;
  enabled: boolean;
  note: string | null;
  author_user_id: string | null;
  effective_at: string;
}

export interface AiThread {
  id: string;
  tenant_id: string;
  user_id: string;
  dashboard_id: string;
  title: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface AiMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  annotations: unknown;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

// ─── Settings (platform-wide, versioned) ────────────────────────────────────

export async function getCurrentSettings(): Promise<AiSettings> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT id, model_id, system_prompt, guardrails, per_user_daily_cap, enabled,
              note, author_user_id, effective_at
       FROM platform.ai_settings_versions
       ORDER BY effective_at DESC LIMIT 1`
    );
    if (result.rows.length === 0) {
      throw new AppError(500, 'AI_SETTINGS_MISSING', 'AI settings not initialized');
    }
    return result.rows[0];
  });
}

export async function listSettingsVersions(): Promise<AiSettings[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT v.id, v.model_id, v.system_prompt, v.guardrails, v.per_user_daily_cap,
              v.enabled, v.note, v.author_user_id, v.effective_at,
              u.name as author_name, u.email as author_email
       FROM platform.ai_settings_versions v
       LEFT JOIN platform.users u ON u.id = v.author_user_id
       ORDER BY v.effective_at DESC LIMIT 100`
    );
    return result.rows;
  });
}

export async function createSettingsVersion(
  updates: Partial<Pick<AiSettings, 'model_id' | 'system_prompt' | 'guardrails' | 'per_user_daily_cap' | 'enabled' | 'note'>>,
  authorUserId: string
): Promise<AiSettings> {
  const current = await getCurrentSettings();
  const merged = {
    model_id: updates.model_id ?? current.model_id,
    system_prompt: updates.system_prompt ?? current.system_prompt,
    guardrails: updates.guardrails ?? current.guardrails,
    per_user_daily_cap: updates.per_user_daily_cap ?? current.per_user_daily_cap,
    enabled: updates.enabled ?? current.enabled,
    note: updates.note ?? null,
  };

  if (!merged.model_id || merged.model_id.trim().length === 0) {
    throw new AppError(400, 'INVALID_MODEL_ID', 'model_id is required');
  }
  if (merged.per_user_daily_cap < 0 || merged.per_user_daily_cap > 100_000) {
    throw new AppError(400, 'INVALID_CAP', 'per_user_daily_cap must be between 0 and 100000');
  }

  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.ai_settings_versions
       (model_id, system_prompt, guardrails, per_user_daily_cap, enabled, note, author_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, model_id, system_prompt, guardrails, per_user_daily_cap, enabled,
                 note, author_user_id, effective_at`,
      [
        merged.model_id,
        merged.system_prompt,
        merged.guardrails,
        merged.per_user_daily_cap,
        merged.enabled,
        merged.note,
        authorUserId,
      ]
    );
    return result.rows[0];
  });
}

// ─── Per-dashboard + per-user toggles ───────────────────────────────────────

export async function getDashboardEnabled(dashboardId: string): Promise<boolean> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT enabled FROM platform.ai_dashboard_settings WHERE dashboard_id = $1`,
      [dashboardId]
    );
    return result.rows.length > 0 && result.rows[0].enabled === true;
  });
}

export async function setDashboardEnabled(
  dashboardId: string,
  enabled: boolean,
  updatedBy: string
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO platform.ai_dashboard_settings (dashboard_id, enabled, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (dashboard_id) DO UPDATE
       SET enabled = $2, updated_by = $3, updated_at = now()`,
      [dashboardId, enabled, updatedBy]
    );
  });
}

export async function listDashboardSettings(): Promise<
  Array<{ dashboard_id: string; dashboard_name: string; tenant_name: string; enabled: boolean; updated_at: string | null }>
> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT d.id as dashboard_id, d.name as dashboard_name, t.name as tenant_name,
              COALESCE(ads.enabled, false) as enabled, ads.updated_at
       FROM platform.dashboards d
       JOIN platform.tenants t ON t.id = d.tenant_id
       LEFT JOIN platform.ai_dashboard_settings ads ON ads.dashboard_id = d.id
       ORDER BY t.name, d.name`
    );
    return result.rows;
  });
}

export async function getUserPref(userId: string, dashboardId: string): Promise<boolean> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT enabled FROM platform.ai_user_dashboard_prefs WHERE user_id = $1 AND dashboard_id = $2`,
      [userId, dashboardId]
    );
    // Default on if no row
    return result.rows.length === 0 ? true : result.rows[0].enabled === true;
  });
}

export async function setUserPref(
  userId: string,
  dashboardId: string,
  tenantId: string,
  enabled: boolean
): Promise<void> {
  await withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `INSERT INTO platform.ai_user_dashboard_prefs (user_id, dashboard_id, tenant_id, enabled, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, dashboard_id) DO UPDATE SET enabled = $4, updated_at = now()`,
      [userId, dashboardId, tenantId, enabled]
    );
  });
}

/**
 * Decides whether the AI rail should render for this (user, dashboard).
 * Checks: global enabled, per-dashboard enabled, per-user not-disabled.
 */
export async function isAiAvailableForUser(
  userId: string,
  dashboardId: string
): Promise<{ available: boolean; reason?: string }> {
  const settings = await getCurrentSettings();
  if (!settings.enabled) return { available: false, reason: 'disabled_platform_wide' };
  const apiKey = await getSetting('ai.anthropic_api_key');
  if (!apiKey) return { available: false, reason: 'no_api_key' };
  const dashEnabled = await getDashboardEnabled(dashboardId);
  if (!dashEnabled) return { available: false, reason: 'disabled_for_dashboard' };
  const userPref = await getUserPref(userId, dashboardId);
  if (!userPref) return { available: false, reason: 'disabled_by_user' };
  return { available: true };
}

// ─── Threads + Messages ─────────────────────────────────────────────────────

export async function listThreads(
  tenantId: string,
  userId: string,
  dashboardId: string
): Promise<AiThread[]> {
  return withTenantContext(tenantId, false, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, user_id, dashboard_id, title, archived, created_at, updated_at
       FROM platform.ai_threads
       WHERE user_id = $1 AND dashboard_id = $2 AND NOT archived
       ORDER BY updated_at DESC LIMIT 100`,
      [userId, dashboardId]
    );
    return result.rows;
  });
}

export async function createThread(
  tenantId: string,
  userId: string,
  dashboardId: string,
  title?: string
): Promise<AiThread> {
  return withTenantContext(tenantId, false, async (client) => {
    const result = await client.query(
      `INSERT INTO platform.ai_threads (tenant_id, user_id, dashboard_id, title)
       VALUES ($1, $2, $3, $4)
       RETURNING id, tenant_id, user_id, dashboard_id, title, archived, created_at, updated_at`,
      [tenantId, userId, dashboardId, (title && title.trim()) || 'New thread']
    );
    return result.rows[0];
  });
}

async function loadThreadForUser(
  threadId: string,
  tenantId: string,
  userId: string
): Promise<AiThread> {
  return withTenantContext(tenantId, false, async (client) => {
    const result = await client.query(
      `SELECT id, tenant_id, user_id, dashboard_id, title, archived, created_at, updated_at
       FROM platform.ai_threads WHERE id = $1 AND user_id = $2`,
      [threadId, userId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'THREAD_NOT_FOUND', 'Thread not found');
    }
    return result.rows[0];
  });
}

export async function renameThread(
  threadId: string,
  tenantId: string,
  userId: string,
  title: string
): Promise<void> {
  await loadThreadForUser(threadId, tenantId, userId);
  const clean = (title || '').trim().slice(0, 200);
  if (!clean) throw new AppError(400, 'INVALID_TITLE', 'Title is required');
  await withTenantContext(tenantId, false, async (client) => {
    await client.query(
      `UPDATE platform.ai_threads SET title = $1, updated_at = now() WHERE id = $2 AND user_id = $3`,
      [clean, threadId, userId]
    );
  });
}

export async function archiveThread(
  threadId: string,
  tenantId: string,
  userId: string
): Promise<void> {
  await loadThreadForUser(threadId, tenantId, userId);
  await withTenantContext(tenantId, false, async (client) => {
    await client.query(
      `UPDATE platform.ai_threads SET archived = true, updated_at = now() WHERE id = $1 AND user_id = $2`,
      [threadId, userId]
    );
  });
}

export async function listMessages(
  threadId: string,
  tenantId: string,
  userId: string
): Promise<AiMessage[]> {
  await loadThreadForUser(threadId, tenantId, userId);
  return withTenantContext(tenantId, false, async (client) => {
    const result = await client.query(
      `SELECT id, thread_id, role, content, annotations, model_id, input_tokens, output_tokens, created_at
       FROM platform.ai_messages WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [threadId]
    );
    return result.rows;
  });
}

// ─── Usage (per-user-per-day cap) ───────────────────────────────────────────

export async function getTodayUsage(
  tenantId: string,
  userId: string
): Promise<{ count: number; cap: number; remaining: number }> {
  const settings = await getCurrentSettings();
  const row = await withTenantContext(tenantId, false, async (client) => {
    const r = await client.query(
      `SELECT message_count FROM platform.ai_usage_daily
       WHERE tenant_id = $1 AND user_id = $2 AND usage_date = CURRENT_DATE`,
      [tenantId, userId]
    );
    return r.rows[0];
  });
  const count = row ? Number(row.message_count) : 0;
  return { count, cap: settings.per_user_daily_cap, remaining: Math.max(0, settings.per_user_daily_cap - count) };
}

async function incrementUsage(
  tenantId: string,
  userId: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  await withTenantContext(tenantId, false, async (client) => {
    await client.query(
      `INSERT INTO platform.ai_usage_daily (tenant_id, user_id, usage_date, message_count, input_tokens, output_tokens)
       VALUES ($1, $2, CURRENT_DATE, 1, $3, $4)
       ON CONFLICT (tenant_id, user_id, usage_date)
       DO UPDATE SET message_count = platform.ai_usage_daily.message_count + 1,
                     input_tokens = platform.ai_usage_daily.input_tokens + $3,
                     output_tokens = platform.ai_usage_daily.output_tokens + $4`,
      [tenantId, userId, inputTokens, outputTokens]
    );
  });
}

// ─── Streaming reply (SSE) ──────────────────────────────────────────────────

interface DashboardContext {
  dashboardId: string;
  title?: string;
  schema?: unknown;
  context?: unknown;
  elements?: Record<string, string>;
  suggestedPrompts?: string[];
}

function sseWrite(res: Response, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…[truncated]';
}

/**
 * Stream a reply over SSE.
 * SSE events emitted:
 *   {type:'start',  messageId, threadId}
 *   {type:'delta',  text}
 *   {type:'done',   messageId, inputTokens, outputTokens}
 *   {type:'error',  code, message}
 *   {type:'limit',  cap, count, remaining}   (if cap hit — emitted instead of start)
 */
export async function streamReply(
  res: Response,
  threadId: string,
  tenantId: string,
  userId: string,
  userContent: string,
  dashboardContext: DashboardContext
): Promise<void> {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  try {
    // 1. Validate thread ownership + load
    const thread = await loadThreadForUser(threadId, tenantId, userId);

    // 2. Check per-user daily cap
    const settings = await getCurrentSettings();
    if (!settings.enabled) {
      sseWrite(res, { type: 'error', code: 'AI_DISABLED', message: 'AI is currently disabled by the platform admin.' });
      return res.end();
    }

    const usage = await getTodayUsage(tenantId, userId);
    if (usage.remaining <= 0) {
      sseWrite(res, { type: 'limit', cap: usage.cap, count: usage.count, remaining: 0 });
      return res.end();
    }

    // 3. Load API key
    const apiKey = await getSetting('ai.anthropic_api_key');
    if (!apiKey) {
      sseWrite(res, { type: 'error', code: 'NO_API_KEY', message: 'AI API key is not configured.' });
      return res.end();
    }

    // 4. Save user message
    const cleanUser = (userContent || '').trim().slice(0, 20_000);
    if (!cleanUser) {
      sseWrite(res, { type: 'error', code: 'EMPTY_MESSAGE', message: 'Message is empty.' });
      return res.end();
    }

    const userMsgId = await withTenantContext(tenantId, false, async (client) => {
      const r = await client.query(
        `INSERT INTO platform.ai_messages (thread_id, tenant_id, user_id, role, content)
         VALUES ($1, $2, $3, 'user', $4) RETURNING id`,
        [threadId, tenantId, userId, cleanUser]
      );
      await client.query(`UPDATE platform.ai_threads SET updated_at = now() WHERE id = $1`, [threadId]);
      return r.rows[0].id as string;
    });

    // 5. Build messages array for Anthropic (history + this turn w/ context injected)
    const historyRows = await withTenantContext(tenantId, false, async (client) => {
      const r = await client.query(
        `SELECT role, content FROM platform.ai_messages
         WHERE thread_id = $1 AND role IN ('user','assistant')
         ORDER BY created_at ASC LIMIT $2`,
        [threadId, MAX_HISTORY_MESSAGES]
      );
      return r.rows as Array<{ role: string; content: string }>;
    });

    // Replace the last user message content with the context-injected version
    const contextBlock = truncate(
      [
        `<dashboard_context dashboard_id="${dashboardContext.dashboardId}" title="${escapeAttr(dashboardContext.title || '')}">`,
        dashboardContext.schema ? `<schema>${JSON.stringify(dashboardContext.schema)}</schema>` : '',
        dashboardContext.context ? `<current_view>${JSON.stringify(dashboardContext.context)}</current_view>` : '',
        dashboardContext.elements ? `<elements>${JSON.stringify(dashboardContext.elements)}</elements>` : '',
        dashboardContext.suggestedPrompts ? `<suggested>${JSON.stringify(dashboardContext.suggestedPrompts)}</suggested>` : '',
        `</dashboard_context>`,
      ].filter(Boolean).join('\n'),
      MAX_CONTEXT_CHARS
    );

    const apiMessages = historyRows.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    // Replace last element (which should be the just-inserted user message) with context-wrapped version
    if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'user') {
      apiMessages[apiMessages.length - 1] = {
        role: 'user',
        content: `${contextBlock}\n\n${cleanUser}`,
      };
    }

    const systemParts = [
      settings.system_prompt,
      settings.guardrails,
      [
        'When you want to highlight on the dashboard, change filters, clear annotations, reset the view, or undo — emit a SINGLE fenced code block at the END of your reply tagged `xray-actions` containing a JSON array. Example:',
        '```xray-actions',
        '[{"action":"highlight","target":"leaderboard.row","params":{"rowId":"3","note":"Top margin"}}]',
        '```',
        'Valid actions: highlight, clearAnnotations, setFilter, resetView, undo. target must be a key from <elements>. params.rowId/cellCol must match the dashboard schema.',
      ].join('\n'),
    ]
      .filter((s) => s && s.trim().length > 0)
      .join('\n\n');

    // 6. Emit start
    sseWrite(res, { type: 'start', threadId, dashboardId: thread.dashboard_id });

    // 7. Call Anthropic streaming endpoint
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    let fullText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let streamEnded = false;

    try {
      const resp = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: settings.model_id,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemParts,
          messages: apiMessages,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!resp.ok || !resp.body) {
        const errBody = await resp.text().catch(() => '');
        sseWrite(res, {
          type: 'error',
          code: 'UPSTREAM_ERROR',
          message: `Anthropic returned ${resp.status}`,
          detail: errBody.slice(0, 500),
        });
        return res.end();
      }

      // Parse Anthropic SSE stream and re-emit delta events
      const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Anthropic SSE frames are delimited by \n\n
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // Each frame may have lines: "event: ..." and "data: ..."
          const lines = frame.split('\n');
          let dataLine = '';
          for (const ln of lines) {
            if (ln.startsWith('data:')) dataLine += ln.slice(5).trim();
          }
          if (!dataLine) continue;
          try {
            const ev = JSON.parse(dataLine);
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              const text = ev.delta.text || '';
              if (text) {
                fullText += text;
                sseWrite(res, { type: 'delta', text });
              }
            } else if (ev.type === 'message_start' && ev.message?.usage) {
              inputTokens = ev.message.usage.input_tokens || 0;
            } else if (ev.type === 'message_delta' && ev.usage) {
              outputTokens = ev.usage.output_tokens || outputTokens;
            } else if (ev.type === 'error') {
              sseWrite(res, {
                type: 'error',
                code: 'UPSTREAM_ERROR',
                message: ev.error?.message || 'Upstream error',
              });
              streamEnded = true;
            }
          } catch {
            // ignore malformed frames
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // client disconnected
      sseWrite(res, { type: 'error', code: 'STREAM_ERROR', message: err?.message || 'Stream failed' });
      return res.end();
    }

    if (streamEnded) return res.end();

    // 8. Extract xray-actions JSON block (if any) from fullText for server-side annotation record
    const actions = extractXrayActions(fullText);

    // 9. Persist assistant message + increment usage
    const assistantId = await withTenantContext(tenantId, false, async (client) => {
      const r = await client.query(
        `INSERT INTO platform.ai_messages
         (thread_id, tenant_id, user_id, role, content, annotations, model_id,
          input_tokens, output_tokens)
         VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          threadId,
          tenantId,
          userId,
          fullText,
          actions.length > 0 ? JSON.stringify(actions) : null,
          settings.model_id,
          inputTokens,
          outputTokens,
        ]
      );
      await client.query(
        `UPDATE platform.ai_threads SET updated_at = now() WHERE id = $1`,
        [threadId]
      );
      return r.rows[0].id as string;
    });

    await incrementUsage(tenantId, userId, inputTokens, outputTokens);

    sseWrite(res, {
      type: 'done',
      messageId: assistantId,
      userMessageId: userMsgId,
      inputTokens,
      outputTokens,
      actions,
    });
    return res.end();
  } catch (err: any) {
    try {
      sseWrite(res, {
        type: 'error',
        code: err?.code || 'INTERNAL',
        message: err?.message || 'Internal error',
      });
    } catch {}
    return res.end();
  }
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Pulls the last ```xray-actions ... ``` fenced block from the text and parses it.
 * Returns [] on any parse failure. Returned actions are validated shallowly.
 */
export function extractXrayActions(text: string): Array<Record<string, unknown>> {
  const re = /```xray-actions\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let lastBody = '';
  while ((match = re.exec(text)) !== null) {
    lastBody = match[1].trim();
  }
  if (!lastBody) return [];
  try {
    const parsed = JSON.parse(lastBody);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a) => a && typeof a === 'object' && typeof (a as Record<string, unknown>).action === 'string'
    );
  } catch {
    return [];
  }
}

// ─── Pins ───────────────────────────────────────────────────────────────────

export async function pinMessage(
  messageId: string,
  tenantId: string,
  userId: string,
  note: string | null
): Promise<{ id: string }> {
  // Verify message belongs to one of this user's threads
  return withTenantContext(tenantId, false, async (client) => {
    const m = await client.query(
      `SELECT m.id, m.thread_id
       FROM platform.ai_messages m
       JOIN platform.ai_threads t ON t.id = m.thread_id
       WHERE m.id = $1 AND t.user_id = $2`,
      [messageId, userId]
    );
    if (m.rows.length === 0) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found');
    const r = await client.query(
      `INSERT INTO platform.ai_pins (thread_id, message_id, tenant_id, user_id, note)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [m.rows[0].thread_id, messageId, tenantId, userId, note]
    );
    return { id: r.rows[0].id };
  });
}

export async function unpinMessage(
  pinId: string,
  tenantId: string,
  userId: string
): Promise<void> {
  await withTenantContext(tenantId, false, async (client) => {
    await client.query(
      `DELETE FROM platform.ai_pins WHERE id = $1 AND user_id = $2`,
      [pinId, userId]
    );
  });
}

export async function listPins(
  tenantId: string,
  userId: string,
  dashboardId: string
): Promise<
  Array<{ pin_id: string; message_id: string; thread_id: string; thread_title: string; note: string | null; content: string; created_at: string }>
> {
  return withTenantContext(tenantId, false, async (client) => {
    const result = await client.query(
      `SELECT p.id as pin_id, p.message_id, p.thread_id, t.title as thread_title,
              p.note, m.content, p.created_at
       FROM platform.ai_pins p
       JOIN platform.ai_messages m ON m.id = p.message_id
       JOIN platform.ai_threads t ON t.id = p.thread_id
       WHERE p.user_id = $1 AND t.dashboard_id = $2
       ORDER BY p.created_at DESC LIMIT 100`,
      [userId, dashboardId]
    );
    return result.rows;
  });
}
