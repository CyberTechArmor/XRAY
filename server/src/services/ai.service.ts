import { Response } from 'express';
import { withAdminClient, getPool } from '../db/connection';
import type { PoolClient } from '../db/connection';
import { getSetting } from './settings.service';
import { AppError } from '../middleware/error-handler';

// Per-user RLS helper (migration 016): sets BOTH app.current_tenant and
// app.current_user_id so the user_scope policies on ai_threads, ai_messages,
// ai_pins, ai_user_dashboard_prefs, ai_usage_daily, ai_message_feedback
// match the row's user_id. Everything that touches those tables goes through
// this helper so the DB enforces isolation even if the app layer forgets a
// WHERE clause.
async function withAiUserContext<T>(
  tenantId: string,
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [tenantId]);
    await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
    await client.query(`SELECT set_config('app.is_platform_admin', 'false', true)`);
    return await fn(client);
  } finally {
    client.release();
  }
}

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
  rating?: -1 | 1 | null;
  rating_note?: string | null;
}

// ─── Settings (platform-wide, versioned) ────────────────────────────────────

export async function getCurrentSettings(): Promise<AiSettings> {
  return withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {
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

  return withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {
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
  await withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {
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
  return withAdminClient(async (client) => {
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
  await withAdminClient(async (client) => {
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
  return withAiUserContext(tenantId, userId, async (client) => {
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
  return withAiUserContext(tenantId, userId, async (client) => {
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
  return withAiUserContext(tenantId, userId, async (client) => {
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
  await withAiUserContext(tenantId, userId, async (client) => {
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
  await withAiUserContext(tenantId, userId, async (client) => {
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
  return withAiUserContext(tenantId, userId, async (client) => {
    const result = await client.query(
      `SELECT m.id, m.thread_id, m.role, m.content, m.annotations, m.model_id,
              m.input_tokens, m.output_tokens, m.created_at,
              f.rating, f.note as rating_note
       FROM platform.ai_messages m
       LEFT JOIN platform.ai_message_feedback f
              ON f.message_id = m.id AND f.user_id = $2
       WHERE m.thread_id = $1
       ORDER BY m.created_at ASC`,
      [threadId, userId]
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
  const row = await withAiUserContext(tenantId, userId, async (client) => {
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
  await withAiUserContext(tenantId, userId, async (client) => {
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
      res.end(); return;
    }

    const usage = await getTodayUsage(tenantId, userId);
    if (usage.remaining <= 0) {
      sseWrite(res, { type: 'limit', cap: usage.cap, count: usage.count, remaining: 0 });
      res.end(); return;
    }

    // 3. Load API key
    const apiKey = await getSetting('ai.anthropic_api_key');
    if (!apiKey) {
      sseWrite(res, { type: 'error', code: 'NO_API_KEY', message: 'AI API key is not configured.' });
      res.end(); return;
    }

    // 4. Save user message
    const cleanUser = (userContent || '').trim().slice(0, 20_000);
    if (!cleanUser) {
      sseWrite(res, { type: 'error', code: 'EMPTY_MESSAGE', message: 'Message is empty.' });
      res.end(); return;
    }

    const userMsgId = await withAiUserContext(tenantId, userId, async (client) => {
      const r = await client.query(
        `INSERT INTO platform.ai_messages (thread_id, tenant_id, user_id, role, content)
         VALUES ($1, $2, $3, 'user', $4) RETURNING id`,
        [threadId, tenantId, userId, cleanUser]
      );
      // Auto-name the thread on the first user message if it still has the
      // default "New thread" title. Takes the first ~60 chars of the message
      // and trims trailing punctuation / whitespace.
      await client.query(
        `UPDATE platform.ai_threads
         SET title = CASE
           WHEN title = 'New thread'
             THEN trim(both ' .?!,;:' from substring($2 for 60))
           ELSE title END,
             updated_at = now()
         WHERE id = $1`,
        [threadId, cleanUser]
      );
      return r.rows[0].id as string;
    });

    // 5. Build messages array for Anthropic (history + this turn w/ context injected)
    const historyRows = await withAiUserContext(tenantId, userId, async (client) => {
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
        'Reading the dashboard context:',
        '- <current_view> is a JSON snapshot of what is rendered on the page right now. It may contain: title, filters, kpis (label/value pairs), tables (headers + rows), visibleText (a line-per-block snapshot), and sometimes a `posted` field pushed by the dashboard via postMessage.',
        '- If `posted` is present, trust it as the dashboard\'s own canonical description — it is more reliable than any DOM-scraped data.',
        '- If kpis or tables contain real numbers and labels, the dashboard has loaded. Answer using them. Do not describe the dashboard as loading in that case.',
        '- visibleText may include decorative loader strings like "Initializing", "Loading Metrics", "Connecting API", "Streaming Data", "Building Layout", or animated HUD copy even after real data has arrived — those are cosmetic and should be ignored if any structured data (kpis/tables/posted) or any numeric values are present elsewhere in visibleText.',
        '- Only say the data is unavailable when kpis AND tables AND posted are empty AND visibleText contains no numeric values — and even then, ask a clarifying question rather than assume the dashboard is broken.',
        '- Prefer structured kpis/tables/posted fields when they match the question. Fall back to visibleText for chart labels, captions, and grid-based leaderboards that weren\'t captured as tables.',
        '- Never invent numbers — cite specific values from the context.',
      ].join('\n'),
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
        res.end(); return;
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
      res.end(); return;
    }

    if (streamEnded) { res.end(); return; }

    // 8. Extract xray-actions JSON block (if any) from fullText for server-side annotation record
    const actions = extractXrayActions(fullText);

    // 9. Persist assistant message + increment usage
    const assistantId = await withAiUserContext(tenantId, userId, async (client) => {
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
    res.end(); return;
  } catch (err: any) {
    try {
      sseWrite(res, {
        type: 'error',
        code: err?.code || 'INTERNAL',
        message: err?.message || 'Internal error',
      });
    } catch {}
    res.end(); return;
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
  return withAiUserContext(tenantId, userId, async (client) => {
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
  await withAiUserContext(tenantId, userId, async (client) => {
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
  return withAiUserContext(tenantId, userId, async (client) => {
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

// ─── Model catalog + pricing ────────────────────────────────────────────────

export interface ModelPricing {
  model_id: string;
  display_name: string;
  provider: string;
  tier: 'flagship' | 'standard' | 'fast';
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million: number;
  cache_write_per_million: number;
  context_window: number | null;
  description: string | null;
  is_active: boolean;
  updated_at: string;
}

export async function listModelPricing(): Promise<ModelPricing[]> {
  return withAdminClient(async (client) => {
    const r = await client.query(
      `SELECT model_id, display_name, provider, tier,
              input_per_million::float8 as input_per_million,
              output_per_million::float8 as output_per_million,
              cache_read_per_million::float8 as cache_read_per_million,
              cache_write_per_million::float8 as cache_write_per_million,
              context_window, description, is_active, updated_at
       FROM platform.ai_model_pricing
       ORDER BY is_active DESC,
         CASE tier WHEN 'flagship' THEN 1 WHEN 'standard' THEN 2 WHEN 'fast' THEN 3 ELSE 4 END,
         display_name`
    );
    return r.rows;
  });
}

export async function getModelPricing(modelId: string): Promise<ModelPricing | null> {
  const all = await listModelPricing();
  // Exact match first; otherwise match by prefix (e.g. "claude-sonnet-4-6-20260101" ~ "claude-sonnet-4-6")
  return (
    all.find((m) => m.model_id === modelId) ||
    all.find((m) => modelId.startsWith(m.model_id)) ||
    null
  );
}

export async function updateModelPricing(
  modelId: string,
  updates: Partial<Pick<ModelPricing, 'display_name' | 'tier' | 'input_per_million' | 'output_per_million' | 'cache_read_per_million' | 'cache_write_per_million' | 'context_window' | 'description' | 'is_active'>>,
  userId: string
): Promise<ModelPricing> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i}`);
    values.push(v);
    i++;
  }
  fields.push(`updated_by = $${i}`);
  values.push(userId);
  i++;
  fields.push(`updated_at = now()`);
  values.push(modelId);
  const sql = `UPDATE platform.ai_model_pricing SET ${fields.join(', ')} WHERE model_id = $${i} RETURNING model_id`;
  await withAdminClient(async (client) => {
    const r = await client.query(sql, values);
    if (r.rows.length === 0) {
      throw new AppError(404, 'MODEL_NOT_FOUND', 'Unknown model_id');
    }
  });
  const updated = await getModelPricing(modelId);
  if (!updated) throw new AppError(404, 'MODEL_NOT_FOUND', 'Model vanished after update');
  return updated;
}

export async function upsertModelPricing(
  row: Omit<ModelPricing, 'updated_at'> & { is_active?: boolean },
  userId: string
): Promise<ModelPricing> {
  await withAdminClient(async (client) => {
    await client.query(
      `INSERT INTO platform.ai_model_pricing
         (model_id, display_name, provider, tier, input_per_million, output_per_million,
          cache_read_per_million, cache_write_per_million, context_window, description,
          is_active, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (model_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         tier = EXCLUDED.tier,
         input_per_million = EXCLUDED.input_per_million,
         output_per_million = EXCLUDED.output_per_million,
         cache_read_per_million = EXCLUDED.cache_read_per_million,
         cache_write_per_million = EXCLUDED.cache_write_per_million,
         context_window = EXCLUDED.context_window,
         description = EXCLUDED.description,
         is_active = EXCLUDED.is_active,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()`,
      [
        row.model_id,
        row.display_name,
        row.provider || 'anthropic',
        row.tier,
        row.input_per_million,
        row.output_per_million,
        row.cache_read_per_million || 0,
        row.cache_write_per_million || 0,
        row.context_window || null,
        row.description || null,
        row.is_active !== false,
        userId,
      ]
    );
  });
  const updated = await getModelPricing(row.model_id);
  if (!updated) throw new AppError(500, 'UPSERT_FAILED', 'Failed to read model after upsert');
  return updated;
}

/**
 * List models available for the model picker.
 *
 * Tries Anthropic's /v1/models live (so newly-released snapshots show up without
 * requiring a DB update), then merges pricing from the DB catalog. Falls back to
 * the DB catalog alone if the API is unreachable or no key is set.
 *
 * Returned shape: { modelId, displayName, tier, input_per_million, output_per_million,
 *                   context_window, description, source: 'anthropic'|'db' }
 */
export async function listAvailableModels(): Promise<
  Array<{
    model_id: string;
    display_name: string;
    tier: string;
    input_per_million: number;
    output_per_million: number;
    cache_read_per_million: number;
    cache_write_per_million: number;
    context_window: number | null;
    description: string | null;
    source: 'anthropic' | 'db';
  }>
> {
  const dbCatalog = await listModelPricing();
  const dbMap = new Map(dbCatalog.filter((m) => m.is_active).map((m) => [m.model_id, m]));

  const apiKey = await getSetting('ai.anthropic_api_key');
  if (!apiKey) {
    return Array.from(dbMap.values()).map((m) => ({
      model_id: m.model_id,
      display_name: m.display_name,
      tier: m.tier,
      input_per_million: m.input_per_million,
      output_per_million: m.output_per_million,
      cache_read_per_million: m.cache_read_per_million,
      cache_write_per_million: m.cache_write_per_million,
      context_window: m.context_window,
      description: m.description,
      source: 'db' as const,
    }));
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=50', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) throw new Error(`models api returned ${resp.status}`);
    const body = (await resp.json()) as { data?: Array<{ id: string; display_name?: string; type?: string; created_at?: string }> };
    const live = (body.data || []).filter((m) => m && m.id && m.id.startsWith('claude'));

    type ModelRow = {
      model_id: string; display_name: string; tier: string;
      input_per_million: number; output_per_million: number;
      cache_read_per_million: number; cache_write_per_million: number;
      context_window: number | null; description: string | null;
      source: 'anthropic' | 'db';
    };
    const merged: ModelRow[] = live.map((m): ModelRow => {
      // Find best pricing match: exact, then prefix (drops date suffix)
      const exact = dbMap.get(m.id);
      const prefixMatch =
        exact ||
        Array.from(dbMap.values()).find((db) => m.id.startsWith(db.model_id));
      const priced = prefixMatch;
      return {
        model_id: m.id,
        display_name: m.display_name || priced?.display_name || m.id,
        tier: priced?.tier || 'standard',
        input_per_million: priced?.input_per_million ?? 0,
        output_per_million: priced?.output_per_million ?? 0,
        cache_read_per_million: priced?.cache_read_per_million ?? 0,
        cache_write_per_million: priced?.cache_write_per_million ?? 0,
        context_window: priced?.context_window ?? null,
        description: priced?.description ?? null,
        source: 'anthropic' as const,
      };
    });

    // Ensure the DB catalog entries are included even if Anthropic didn't list them
    // (e.g. aliases like "claude-sonnet-4-6" which the API returns as dated snapshots).
    const seen = new Set(merged.map((m) => m.model_id));
    for (const db of dbMap.values()) {
      if (!seen.has(db.model_id)) {
        merged.unshift({
          model_id: db.model_id,
          display_name: db.display_name,
          tier: db.tier,
          input_per_million: db.input_per_million,
          output_per_million: db.output_per_million,
          cache_read_per_million: db.cache_read_per_million,
          cache_write_per_million: db.cache_write_per_million,
          context_window: db.context_window,
          description: db.description,
          source: 'db',
        });
      }
    }
    return merged;
  } catch {
    // Fallback to DB catalog
    return Array.from(dbMap.values()).map((m) => ({
      model_id: m.model_id,
      display_name: m.display_name,
      tier: m.tier,
      input_per_million: m.input_per_million,
      output_per_million: m.output_per_million,
      cache_read_per_million: m.cache_read_per_million,
      cache_write_per_million: m.cache_write_per_million,
      context_window: m.context_window,
      description: m.description,
      source: 'db',
    }));
  }
}

// ─── Feedback (ratings) ─────────────────────────────────────────────────────

export interface MessageFeedback {
  message_id: string;
  rating: -1 | 1;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export async function setMessageFeedback(
  messageId: string,
  tenantId: string,
  userId: string,
  rating: -1 | 1,
  note: string | null
): Promise<MessageFeedback> {
  if (rating !== 1 && rating !== -1) {
    throw new AppError(400, 'INVALID_RATING', 'rating must be 1 or -1');
  }
  const trimmedNote = (note || '').trim().slice(0, 2000) || null;
  return withAiUserContext(tenantId, userId, async (client) => {
    // Verify user owns the thread containing this message
    const owner = await client.query(
      `SELECT m.thread_id
       FROM platform.ai_messages m
       JOIN platform.ai_threads t ON t.id = m.thread_id
       WHERE m.id = $1 AND t.user_id = $2 AND m.role = 'assistant'`,
      [messageId, userId]
    );
    if (owner.rows.length === 0) {
      throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found');
    }
    const threadId = owner.rows[0].thread_id;
    const r = await client.query(
      `INSERT INTO platform.ai_message_feedback (message_id, thread_id, tenant_id, user_id, rating, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (message_id) DO UPDATE
       SET rating = EXCLUDED.rating, note = EXCLUDED.note, updated_at = now()
       RETURNING message_id, rating, note, created_at, updated_at`,
      [messageId, threadId, tenantId, userId, rating, trimmedNote]
    );
    return r.rows[0];
  });
}

export async function clearMessageFeedback(
  messageId: string,
  tenantId: string,
  userId: string
): Promise<void> {
  await withAiUserContext(tenantId, userId, async (client) => {
    await client.query(
      `DELETE FROM platform.ai_message_feedback
       WHERE message_id = $1 AND user_id = $2`,
      [messageId, userId]
    );
  });
}

export async function getMessageFeedback(
  messageId: string,
  tenantId: string,
  userId: string
): Promise<MessageFeedback | null> {
  return withAiUserContext(tenantId, userId, async (client) => {
    const r = await client.query(
      `SELECT message_id, rating, note, created_at, updated_at
       FROM platform.ai_message_feedback
       WHERE message_id = $1 AND user_id = $2`,
      [messageId, userId]
    );
    return r.rows[0] || null;
  });
}

// ─── Usage analytics (admin) ────────────────────────────────────────────────

export interface UsageRollup {
  period_start: string;
  model_id: string | null;
  tenant_id: string | null;
  tenant_name?: string | null;
  user_id: string | null;
  user_name?: string | null;
  user_email?: string | null;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_input_usd: number;
  cost_output_usd: number;
  cost_cache_usd: number;
  cost_total_usd: number;
  thumbs_up: number;
  thumbs_down: number;
}

/**
 * Admin-scoped aggregate usage. Computes cost from ai_messages + pricing catalog.
 * groupBy: 'day' | 'tenant' | 'user' | 'model'
 */
export async function getUsageSummary(opts: {
  groupBy?: 'day' | 'tenant' | 'user' | 'model';
  from?: string;        // ISO date
  to?: string;          // ISO date
  tenantId?: string;
  userId?: string;
  limit?: number;
}): Promise<{ totals: UsageRollup; rows: UsageRollup[] }> {
  const groupBy = opts.groupBy || 'day';
  const limit = Math.min(Math.max(opts.limit || 90, 1), 1000);

  // Build grouping + select columns
  const selects: string[] = [];
  const groups: string[] = [];
  const joins: string[] = [];
  let periodExpr = `NULL::timestamptz`;

  if (groupBy === 'day') {
    periodExpr = `date_trunc('day', m.created_at)`;
    selects.push(`${periodExpr} as period_start`);
    selects.push(`m.model_id`);
    groups.push(periodExpr, 'm.model_id');
  } else if (groupBy === 'tenant') {
    selects.push(`m.tenant_id`);
    selects.push(`t.name as tenant_name`);
    joins.push(`LEFT JOIN platform.tenants t ON t.id = m.tenant_id`);
    groups.push('m.tenant_id', 't.name');
  } else if (groupBy === 'user') {
    selects.push(`m.tenant_id`);
    selects.push(`m.user_id`);
    selects.push(`u.name as user_name`);
    selects.push(`u.email as user_email`);
    joins.push(`LEFT JOIN platform.users u ON u.id = m.user_id`);
    groups.push('m.tenant_id', 'm.user_id', 'u.name', 'u.email');
  } else if (groupBy === 'model') {
    selects.push(`m.model_id`);
    groups.push('m.model_id');
  }

  selects.push(`COUNT(*)::int as message_count`);
  selects.push(`COALESCE(SUM(m.input_tokens),0)::bigint as input_tokens`);
  selects.push(`COALESCE(SUM(m.output_tokens),0)::bigint as output_tokens`);
  selects.push(`COALESCE(SUM(m.cache_read_tokens),0)::bigint as cache_read_tokens`);
  selects.push(`COALESCE(SUM(m.cache_write_tokens),0)::bigint as cache_write_tokens`);
  // Cost computed inline against pricing catalog via LATERAL match on model prefix
  selects.push(`COALESCE(SUM(m.input_tokens * COALESCE(p.input_per_million, 0)) / 1000000.0, 0)::float8 as cost_input_usd`);
  selects.push(`COALESCE(SUM(m.output_tokens * COALESCE(p.output_per_million, 0)) / 1000000.0, 0)::float8 as cost_output_usd`);
  selects.push(
    `COALESCE(
       SUM(m.cache_read_tokens * COALESCE(p.cache_read_per_million, 0)
         + m.cache_write_tokens * COALESCE(p.cache_write_per_million, 0)) / 1000000.0, 0)::float8 as cost_cache_usd`
  );
  selects.push(
    `COALESCE(
       SUM(m.input_tokens * COALESCE(p.input_per_million, 0)
         + m.output_tokens * COALESCE(p.output_per_million, 0)
         + m.cache_read_tokens * COALESCE(p.cache_read_per_million, 0)
         + m.cache_write_tokens * COALESCE(p.cache_write_per_million, 0)) / 1000000.0, 0)::float8 as cost_total_usd`
  );
  selects.push(`COUNT(*) FILTER (WHERE f.rating = 1)::int as thumbs_up`);
  selects.push(`COUNT(*) FILTER (WHERE f.rating = -1)::int as thumbs_down`);

  const where: string[] = [`m.role = 'assistant'`];
  const values: unknown[] = [];
  if (opts.from) { values.push(opts.from); where.push(`m.created_at >= $${values.length}`); }
  if (opts.to)   { values.push(opts.to);   where.push(`m.created_at <  $${values.length}`); }
  if (opts.tenantId) { values.push(opts.tenantId); where.push(`m.tenant_id = $${values.length}`); }
  if (opts.userId)   { values.push(opts.userId);   where.push(`m.user_id = $${values.length}`); }

  // Build pricing join: prefer exact model_id, else prefix match
  const pricingJoin = `LEFT JOIN LATERAL (
    SELECT input_per_million, output_per_million, cache_read_per_million, cache_write_per_million
    FROM platform.ai_model_pricing
    WHERE m.model_id = model_id
       OR (m.model_id IS NOT NULL AND m.model_id LIKE model_id || '%')
    ORDER BY (m.model_id = model_id) DESC, length(model_id) DESC
    LIMIT 1
  ) p ON true`;

  const sql = `
    SELECT ${selects.join(', ')}
    FROM platform.ai_messages m
    ${pricingJoin}
    LEFT JOIN platform.ai_message_feedback f ON f.message_id = m.id
    ${joins.join('\n')}
    WHERE ${where.join(' AND ')}
    ${groups.length ? 'GROUP BY ' + groups.join(', ') : ''}
    ORDER BY ${groupBy === 'day' ? 'period_start DESC' : 'cost_total_usd DESC'}
    LIMIT ${limit}
  `;

  return withAdminClient(async (client) => {
    const rowsRes = await client.query(sql, values);
    // Totals: same query without group by
    const totalsSql = `
      SELECT
        COUNT(*)::int as message_count,
        COALESCE(SUM(m.input_tokens),0)::bigint as input_tokens,
        COALESCE(SUM(m.output_tokens),0)::bigint as output_tokens,
        COALESCE(SUM(m.cache_read_tokens),0)::bigint as cache_read_tokens,
        COALESCE(SUM(m.cache_write_tokens),0)::bigint as cache_write_tokens,
        COALESCE(SUM(m.input_tokens * COALESCE(p.input_per_million,0))/1000000.0, 0)::float8 as cost_input_usd,
        COALESCE(SUM(m.output_tokens * COALESCE(p.output_per_million,0))/1000000.0, 0)::float8 as cost_output_usd,
        COALESCE(SUM(m.cache_read_tokens * COALESCE(p.cache_read_per_million,0)
               + m.cache_write_tokens * COALESCE(p.cache_write_per_million,0))/1000000.0, 0)::float8 as cost_cache_usd,
        COALESCE(SUM(m.input_tokens * COALESCE(p.input_per_million,0)
               + m.output_tokens * COALESCE(p.output_per_million,0)
               + m.cache_read_tokens * COALESCE(p.cache_read_per_million,0)
               + m.cache_write_tokens * COALESCE(p.cache_write_per_million,0))/1000000.0, 0)::float8 as cost_total_usd,
        COUNT(*) FILTER (WHERE f.rating = 1)::int as thumbs_up,
        COUNT(*) FILTER (WHERE f.rating = -1)::int as thumbs_down
      FROM platform.ai_messages m
      ${pricingJoin}
      LEFT JOIN platform.ai_message_feedback f ON f.message_id = m.id
      WHERE ${where.join(' AND ')}
    `;
    const totalsRes = await client.query(totalsSql, values);
    return { totals: totalsRes.rows[0], rows: rowsRes.rows };
  });
}

/**
 * Paginated Q&A log for admin analysis. Returns user question + assistant reply pairs
 * with the assistant message's tokens/cost/rating, ordered by recency.
 */
export async function listConversations(opts: {
  from?: string;
  to?: string;
  tenantId?: string;
  userId?: string;
  rating?: -1 | 1 | 0;        // 0 = only unrated
  search?: string;             // ILIKE against question + answer
  limit?: number;
  offset?: number;
}): Promise<{
  rows: Array<{
    thread_id: string;
    assistant_message_id: string;
    tenant_id: string;
    tenant_name: string | null;
    user_id: string;
    user_name: string | null;
    user_email: string | null;
    dashboard_id: string;
    dashboard_name: string | null;
    model_id: string | null;
    question: string;
    answer: string;
    input_tokens: number;
    output_tokens: number;
    cost_total_usd: number;
    rating: number | null;
    rating_note: string | null;
    created_at: string;
  }>;
  total: number;
}> {
  const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
  const offset = Math.max(opts.offset || 0, 0);

  const where: string[] = [`a.role = 'assistant'`];
  const countWhere: string[] = [`a.role = 'assistant'`];  // mirrors `where` but without q.content reference
  const values: unknown[] = [];
  if (opts.from) {
    values.push(opts.from);
    where.push(`a.created_at >= $${values.length}`);
    countWhere.push(`a.created_at >= $${values.length}`);
  }
  if (opts.to) {
    values.push(opts.to);
    where.push(`a.created_at <  $${values.length}`);
    countWhere.push(`a.created_at <  $${values.length}`);
  }
  if (opts.tenantId) {
    values.push(opts.tenantId);
    where.push(`a.tenant_id = $${values.length}`);
    countWhere.push(`a.tenant_id = $${values.length}`);
  }
  if (opts.userId) {
    values.push(opts.userId);
    where.push(`a.user_id = $${values.length}`);
    countWhere.push(`a.user_id = $${values.length}`);
  }
  if (opts.rating === 1 || opts.rating === -1) {
    values.push(opts.rating);
    where.push(`f.rating = $${values.length}`);
    countWhere.push(`f.rating = $${values.length}`);
  } else if (opts.rating === 0) {
    where.push(`f.rating IS NULL`);
    countWhere.push(`f.rating IS NULL`);
  }
  if (opts.search && opts.search.trim()) {
    values.push('%' + opts.search.trim() + '%');
    const p = values.length;
    where.push(`(a.content ILIKE $${p} OR q.content ILIKE $${p})`);
    countWhere.push(`a.content ILIKE $${p}`);
  }

  const pricingJoin = `LEFT JOIN LATERAL (
    SELECT input_per_million, output_per_million, cache_read_per_million, cache_write_per_million
    FROM platform.ai_model_pricing
    WHERE a.model_id = model_id OR (a.model_id IS NOT NULL AND a.model_id LIKE model_id || '%')
    ORDER BY (a.model_id = model_id) DESC, length(model_id) DESC
    LIMIT 1
  ) p ON true`;

  // For each assistant message, pull the most recent user message in the same thread
  // that came *before* it (i.e. the question).
  const questionJoin = `LEFT JOIN LATERAL (
    SELECT content
    FROM platform.ai_messages
    WHERE thread_id = a.thread_id AND role = 'user' AND created_at < a.created_at
    ORDER BY created_at DESC LIMIT 1
  ) q ON true`;

  const sql = `
    SELECT a.thread_id, a.id as assistant_message_id,
           a.tenant_id, tn.name as tenant_name,
           a.user_id, u.name as user_name, u.email as user_email,
           th.dashboard_id, d.name as dashboard_name,
           a.model_id,
           COALESCE(q.content, '') as question,
           a.content as answer,
           a.input_tokens, a.output_tokens,
           COALESCE(
             (a.input_tokens * COALESCE(p.input_per_million,0)
            + a.output_tokens * COALESCE(p.output_per_million,0)
            + a.cache_read_tokens * COALESCE(p.cache_read_per_million,0)
            + a.cache_write_tokens * COALESCE(p.cache_write_per_million,0)) / 1000000.0, 0)::float8 as cost_total_usd,
           f.rating, f.note as rating_note,
           a.created_at
    FROM platform.ai_messages a
    ${pricingJoin}
    ${questionJoin}
    LEFT JOIN platform.ai_message_feedback f ON f.message_id = a.id
    LEFT JOIN platform.ai_threads th ON th.id = a.thread_id
    LEFT JOIN platform.dashboards d ON d.id = th.dashboard_id
    LEFT JOIN platform.tenants tn ON tn.id = a.tenant_id
    LEFT JOIN platform.users u ON u.id = a.user_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const countSql = `
    SELECT COUNT(*)::int as total
    FROM platform.ai_messages a
    LEFT JOIN platform.ai_message_feedback f ON f.message_id = a.id
    WHERE ${countWhere.join(' AND ')}
  `;

  return withAdminClient(async (client) => {
    const rowsRes = await client.query(sql, values);
    const totalRes = await client.query(countSql, values);
    return { rows: rowsRes.rows, total: totalRes.rows[0].total };
  });
}
