import { withClient, withTransaction } from '../db/connection';
import { AppError } from '../middleware/error-handler';
import { gzipSync, gunzipSync } from 'zlib';

// ── Create Session ──────────────────────────────────────────────────────────

export async function createSession(
  userId: string,
  tenantId: string,
  data: { userAgent?: string; viewportWidth?: number; viewportHeight?: number }
) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.sessions (user_id, tenant_id, started_at, user_agent, viewport_width, viewport_height, is_active)
       VALUES ($1, $2, now(), $3, $4, $5, true)
       RETURNING *`,
      [userId, tenantId, data.userAgent || null, data.viewportWidth || null, data.viewportHeight || null]
    );
    return result.rows[0];
  });
}

// ── Segments ────────────────────────────────────────────────────────────────

export async function createSegment(
  sessionId: string,
  segmentType: 'platform' | 'dashboard',
  dashboardId?: string
) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.session_segments (session_id, segment_type, dashboard_id, started_at)
       VALUES ($1, $2, $3, now())
       RETURNING *`,
      [sessionId, segmentType, dashboardId || null]
    );
    return result.rows[0];
  });
}

export async function closeSegment(segmentId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.session_segments
       SET ended_at = now(),
           duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))
       WHERE id = $1
       RETURNING *`,
      [segmentId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Segment not found');
    }
    return result.rows[0];
  });
}

// ── Events / Recordings ─────────────────────────────────────────────────────

export async function storeEvents(segmentId: string, events: any[]) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Compress events
    const compressed = gzipSync(Buffer.from(JSON.stringify(events)));

    await client.query(
      `INSERT INTO platform.segment_recordings (segment_id, data)
       VALUES ($1, $2)`,
      [segmentId, compressed]
    );

    // Count clicks and pages from events
    let clickCount = 0;
    let pageCount = 0;
    for (const ev of events) {
      // Click: IncrementalSnapshot (type 3), source MouseInteraction (2), type Click (2)
      if (ev.type === 3 && ev.data?.source === 2 && ev.data?.type === 2) {
        clickCount++;
      }
      // Page: Meta event (type 4)
      if (ev.type === 4) {
        pageCount++;
      }
    }

    if (clickCount > 0 || pageCount > 0) {
      await client.query(
        `UPDATE platform.session_segments
         SET click_count = COALESCE(click_count, 0) + $2,
             page_count  = COALESCE(page_count, 0) + $3
         WHERE id = $1`,
        [segmentId, clickCount, pageCount]
      );
    }
  });
}

export async function getEvents(segmentId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT data FROM platform.segment_recordings WHERE segment_id = $1 ORDER BY id`,
      [segmentId]
    );
    const allEvents: any[] = [];
    for (const row of result.rows) {
      const decompressed = gunzipSync(row.data);
      const parsed = JSON.parse(decompressed.toString());
      allEvents.push(...parsed);
    }
    return allEvents;
  });
}

// ── List / Query ────────────────────────────────────────────────────────────

export async function listSessions(
  tenantId?: string,
  filters?: {
    userId?: string;
    dateFrom?: string;
    dateTo?: string;
    isActive?: boolean;
    limit?: number;
    offset?: number;
  }
) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (tenantId) {
      conditions.push(`s.tenant_id = $${idx++}`);
      values.push(tenantId);
    }
    if (filters?.userId) {
      conditions.push(`s.user_id = $${idx++}`);
      values.push(filters.userId);
    }
    if (filters?.dateFrom) {
      conditions.push(`s.started_at >= $${idx++}`);
      values.push(filters.dateFrom);
    }
    if (filters?.dateTo) {
      conditions.push(`s.started_at <= $${idx++}`);
      values.push(filters.dateTo);
    }
    if (filters?.isActive !== undefined) {
      conditions.push(`s.is_active = $${idx++}`);
      values.push(filters.isActive);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.min(filters?.limit || 50, 200);
    const offset = filters?.offset || 0;

    const countResult = await client.query(
      `SELECT count(*)::int AS total FROM platform.sessions s ${where}`,
      values
    );

    const result = await client.query(
      `SELECT s.*, u.name AS user_name, u.email AS user_email
       FROM platform.sessions s
       LEFT JOIN platform.users u ON u.id = s.user_id
       ${where}
       ORDER BY s.started_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );

    return { data: result.rows, total: countResult.rows[0].total, limit, offset };
  });
}

export async function listSegments(filters?: {
  sessionId?: string;
  dashboardId?: string;
  segmentType?: string;
  userId?: string;
  tenantId?: string;
  dateFrom?: string;
  dateTo?: string;
  isTraining?: boolean;
  isPermanent?: boolean;
  limit?: number;
  offset?: number;
}) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (filters?.sessionId) {
      conditions.push(`seg.session_id = $${idx++}`);
      values.push(filters.sessionId);
    }
    if (filters?.dashboardId) {
      conditions.push(`seg.dashboard_id = $${idx++}`);
      values.push(filters.dashboardId);
    }
    if (filters?.segmentType) {
      conditions.push(`seg.segment_type = $${idx++}`);
      values.push(filters.segmentType);
    }
    if (filters?.userId) {
      conditions.push(`s.user_id = $${idx++}`);
      values.push(filters.userId);
    }
    if (filters?.tenantId) {
      conditions.push(`s.tenant_id = $${idx++}`);
      values.push(filters.tenantId);
    }
    if (filters?.dateFrom) {
      conditions.push(`seg.started_at >= $${idx++}`);
      values.push(filters.dateFrom);
    }
    if (filters?.dateTo) {
      conditions.push(`seg.started_at <= $${idx++}`);
      values.push(filters.dateTo);
    }
    if (filters?.isTraining !== undefined) {
      conditions.push(`seg.is_training = $${idx++}`);
      values.push(filters.isTraining);
    }
    if (filters?.isPermanent !== undefined) {
      conditions.push(`seg.is_permanent = $${idx++}`);
      values.push(filters.isPermanent);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.min(filters?.limit || 50, 200);
    const offset = filters?.offset || 0;

    const countResult = await client.query(
      `SELECT count(*)::int AS total
       FROM platform.session_segments seg
       JOIN platform.sessions s ON s.id = seg.session_id
       ${where}`,
      values
    );

    const result = await client.query(
      `SELECT seg.*, s.user_id, s.tenant_id, s.user_agent,
              u.name AS user_name, u.email AS user_email,
              d.name AS dashboard_name
       FROM platform.session_segments seg
       JOIN platform.sessions s ON s.id = seg.session_id
       LEFT JOIN platform.users u ON u.id = s.user_id
       LEFT JOIN platform.dashboards d ON d.id = seg.dashboard_id
       ${where}
       ORDER BY seg.started_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...values, limit, offset]
    );

    return { data: result.rows, total: countResult.rows[0].total, limit, offset };
  });
}

export async function getSegment(segmentId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    const result = await client.query(
      `SELECT seg.*, s.user_id, s.tenant_id, s.user_agent, s.viewport_width, s.viewport_height,
              u.name AS user_name, u.email AS user_email,
              d.name AS dashboard_name
       FROM platform.session_segments seg
       JOIN platform.sessions s ON s.id = seg.session_id
       LEFT JOIN platform.users u ON u.id = s.user_id
       LEFT JOIN platform.dashboards d ON d.id = seg.dashboard_id
       WHERE seg.id = $1`,
      [segmentId]
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Segment not found');
    }

    const segment = result.rows[0];

    // Fetch tags
    const tags = await client.query(
      `SELECT t.*, u.name AS created_by_name
       FROM platform.segment_tags t
       LEFT JOIN platform.users u ON u.id = t.user_id
       WHERE t.segment_id = $1
       ORDER BY t.created_at`,
      [segmentId]
    );
    segment.tags = tags.rows;

    // Fetch comments
    const comments = await client.query(
      `SELECT c.*, u.name AS user_name, u.email AS user_email
       FROM platform.segment_comments c
       LEFT JOIN platform.users u ON u.id = c.user_id
       WHERE c.segment_id = $1
       ORDER BY c.created_at ASC`,
      [segmentId]
    );
    segment.comments = comments.rows;

    return segment;
  });
}

// ── Flags ───────────────────────────────────────────────────────────────────

export async function flagTraining(segmentId: string, isTraining: boolean) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // If setting is_training = true, also set is_permanent = true
    if (isTraining) {
      const result = await client.query(
        `UPDATE platform.session_segments
         SET is_training = true, is_permanent = true
         WHERE id = $1
         RETURNING *`,
        [segmentId]
      );
      if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Segment not found');
      return result.rows[0];
    }

    const result = await client.query(
      `UPDATE platform.session_segments
       SET is_training = false
       WHERE id = $1
       RETURNING *`,
      [segmentId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Segment not found');
    return result.rows[0];
  });
}

export async function flagPermanent(segmentId: string, isPermanent: boolean) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    if (!isPermanent) {
      // Cannot unset permanent if is_training is true
      const check = await client.query(
        `SELECT is_training FROM platform.session_segments WHERE id = $1`,
        [segmentId]
      );
      if (check.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Segment not found');
      if (check.rows[0].is_training) {
        throw new AppError(400, 'INVALID_OPERATION', 'Cannot remove permanent flag from a training segment');
      }
    }

    const result = await client.query(
      `UPDATE platform.session_segments SET is_permanent = $2 WHERE id = $1 RETURNING *`,
      [segmentId, isPermanent]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Segment not found');
    return result.rows[0];
  });
}

// ── Tags ────────────────────────────────────────────────────────────────────

export async function addTag(segmentId: string, tag: string, userId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.segment_tags (segment_id, tag, user_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [segmentId, tag, userId]
    );
    return result.rows[0];
  });
}

export async function removeTag(tagId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `DELETE FROM platform.segment_tags WHERE id = $1 RETURNING id`,
      [tagId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Tag not found');
  });
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function addComment(
  segmentId: string,
  userId: string,
  body: string,
  timestampSeconds?: number
) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.segment_comments (segment_id, user_id, body, timestamp_seconds)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [segmentId, userId, body, timestampSeconds ?? null]
    );
    return result.rows[0];
  });
}

export async function listComments(segmentId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT c.*, u.name AS user_name, u.email AS user_email
       FROM platform.segment_comments c
       LEFT JOIN platform.users u ON u.id = c.user_id
       WHERE c.segment_id = $1
       ORDER BY c.created_at ASC`,
      [segmentId]
    );
    return result.rows;
  });
}

// ── Active Sessions / Shadow Viewing ────────────────────────────────────────

export async function getActiveSessions(tenantId?: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    const conditions = ['s.is_active = true'];
    const values: unknown[] = [];
    let idx = 1;

    if (tenantId) {
      conditions.push(`s.tenant_id = $${idx++}`);
      values.push(tenantId);
    }

    const result = await client.query(
      `SELECT s.*, u.name AS user_name, u.email AS user_email,
              latest_seg.segment_type AS current_segment_type,
              latest_seg.dashboard_id AS current_dashboard_id,
              d.name AS current_dashboard_name
       FROM platform.sessions s
       LEFT JOIN platform.users u ON u.id = s.user_id
       LEFT JOIN LATERAL (
         SELECT seg.segment_type, seg.dashboard_id
         FROM platform.session_segments seg
         WHERE seg.session_id = s.id AND seg.ended_at IS NULL
         ORDER BY seg.started_at DESC
         LIMIT 1
       ) latest_seg ON true
       LEFT JOIN platform.dashboards d ON d.id = latest_seg.dashboard_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.started_at DESC`,
      values
    );

    return result.rows;
  });
}

export async function finalizeStaleSession(sessionId: string) {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Close any open segments
    await client.query(
      `UPDATE platform.session_segments
       SET ended_at = now(),
           duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))
       WHERE session_id = $1 AND ended_at IS NULL`,
      [sessionId]
    );

    // Finalize the session
    const result = await client.query(
      `UPDATE platform.sessions
       SET is_active = false,
           ended_at = now(),
           duration_seconds = EXTRACT(EPOCH FROM (now() - started_at))
       WHERE id = $1
       RETURNING *`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Session not found');
    }
    return result.rows[0];
  });
}

// ── Shadow View Tracking ────────────────────────────────────────────────────

export async function recordShadowView(segmentId: string, userId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await client.query(
      `UPDATE platform.session_segments
       SET shadow_views = COALESCE(shadow_views, '[]'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [segmentId, JSON.stringify({ user_id: userId, joined_at: new Date().toISOString() })]
    );
  });
}

export async function updateShadowViewEnd(segmentId: string, userId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Find the index of the matching shadow view entry and update it
    const seg = await client.query(
      `SELECT shadow_views FROM platform.session_segments WHERE id = $1`,
      [segmentId]
    );
    if (seg.rows.length === 0) return;

    const views: any[] = seg.rows[0].shadow_views || [];
    // Find the last entry for this user that has no left_at
    for (let i = views.length - 1; i >= 0; i--) {
      if (views[i].user_id === userId && !views[i].left_at) {
        views[i].left_at = new Date().toISOString();
        break;
      }
    }

    await client.query(
      `UPDATE platform.session_segments SET shadow_views = $2::jsonb WHERE id = $1`,
      [segmentId, JSON.stringify(views)]
    );
  });
}

// ── Retention Cleanup ───────────────────────────────────────────────────────

export async function runRetentionCleanup(retentionDays: number) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Find segments that are past retention and not permanent
    const result = await client.query(
      `SELECT seg.id
       FROM platform.session_segments seg
       WHERE seg.created_at < now() - ($1 || ' days')::interval
         AND seg.is_permanent = false
         AND seg.recording_deleted = false`,
      [retentionDays]
    );

    const segmentIds = result.rows.map((r: any) => r.id);
    if (segmentIds.length === 0) return { deleted: 0 };

    // Delete recording data
    await client.query(
      `DELETE FROM platform.segment_recordings WHERE segment_id = ANY($1)`,
      [segmentIds]
    );

    // Mark segments as recording_deleted
    await client.query(
      `UPDATE platform.session_segments SET recording_deleted = true WHERE id = ANY($1)`,
      [segmentIds]
    );

    return { deleted: segmentIds.length };
  });
}
