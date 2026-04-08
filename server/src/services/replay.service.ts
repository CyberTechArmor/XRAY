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
      `INSERT INTO platform.segment_recordings (segment_id, events)
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
      // Update the segment where events are stored
      await client.query(
        `UPDATE platform.session_segments
         SET click_count = COALESCE(click_count, 0) + $2,
             page_count  = COALESCE(page_count, 0) + $3
         WHERE id = $1`,
        [segmentId, clickCount, pageCount]
      );
      // Also update the latest open segment in the same session (for dashboard segments)
      await client.query(
        `UPDATE platform.session_segments
         SET click_count = COALESCE(click_count, 0) + $2,
             page_count  = COALESCE(page_count, 0) + $3
         WHERE id != $1
           AND session_id = (SELECT session_id FROM platform.session_segments WHERE id = $1)
           AND ended_at IS NULL`,
        [segmentId, clickCount, pageCount]
      );
    }
  });
}

export async function getEvents(segmentId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Get the session ID for this segment
    const segResult = await client.query(
      `SELECT session_id FROM platform.session_segments WHERE id = $1`,
      [segmentId]
    );
    if (segResult.rows.length === 0) return [];

    const sessionId = segResult.rows[0].session_id;

    // Get ALL events from ALL segments in this session (ordered by recording time).
    // This ensures the FullSnapshot from session start is always included,
    // making every segment independently playable. The rrweb player needs
    // a FullSnapshot (type 2) as the first event to render anything.
    const result = await client.query(
      `SELECT r.events FROM platform.segment_recordings r
       JOIN platform.session_segments s ON s.id = r.segment_id
       WHERE s.session_id = $1
       ORDER BY r.id`,
      [sessionId]
    );

    const allEvents: any[] = [];
    for (const row of result.rows) {
      const decompressed = gunzipSync(row.events);
      const parsed = JSON.parse(decompressed.toString());
      allEvents.push(...parsed);
    }

    // Sort events by timestamp to ensure correct playback order
    allEvents.sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));

    return allEvents;
  });
}

// ── Click Details ──────────────────────────────────────────────────────────

export async function getClickDetails(segmentId: string) {
  const events = await getEvents(segmentId);

  // Build node map from FullSnapshot AND ALL incremental mutations
  const nodeMap = new Map<number, any>();
  function walkNodes(node: any, parentId?: number) {
    if (!node) return;
    if (parentId !== undefined) node.parentId = parentId;
    nodeMap.set(node.id, node);
    if (node.childNodes) node.childNodes.forEach((child: any) => walkNodes(child, node.id));
  }
  for (const ev of events) {
    // FullSnapshot (type 2)
    if (ev.type === 2 && ev.data?.node) {
      walkNodes(ev.data.node);
    }
    // IncrementalSnapshot (type 3) with DOM mutations - source 0 = Mutation
    if (ev.type === 3 && ev.data?.source === 0) {
      // Added nodes
      if (ev.data.adds) {
        for (const add of ev.data.adds) {
          if (add.node) walkNodes(add.node, add.parentId);
        }
      }
      // Text changes — update existing nodes
      if (ev.data.texts) {
        for (const t of ev.data.texts) {
          const existing = nodeMap.get(t.id);
          if (existing) existing.textContent = t.value;
        }
      }
      // Attribute changes — update existing nodes
      if (ev.data.attributes) {
        for (const a of ev.data.attributes) {
          const existing = nodeMap.get(a.id);
          if (existing && existing.attributes) {
            Object.assign(existing.attributes, a.attributes);
          }
        }
      }
    }
  }

  console.log(`[Click Details] Node map size: ${nodeMap.size}, Events: ${events.length}`);

  // Extract click events with element info
  const clicks: any[] = [];
  const sessionStart = events.length > 0 ? events[0].timestamp : 0;

  for (const ev of events) {
    if (ev.type === 3 && ev.data?.source === 2 && ev.data?.type === 2) {
      const nodeId = ev.data.id;
      const node = nodeMap.get(nodeId);
      if (!node) {
        console.log(`[Click Details] Click at node ${nodeId} not found in map (map has ${nodeMap.size} nodes)`);
      }
      const elInfo = describeNode(node, nodeMap);
      // Gather ancestor context: walk up to find meaningful parent content
      const context = getClickContext(node, nodeMap);
      clicks.push({
        timestamp: ev.timestamp,
        timeOffset: ev.timestamp - sessionStart,
        timeFormatted: formatMs(ev.timestamp - sessionStart),
        x: ev.data.x,
        y: ev.data.y,
        element: elInfo.tag,
        text: elInfo.text,
        selector: elInfo.selector,
        attributes: elInfo.attributes,
        context: context,
      });
    }
  }
  return clicks;
}

function describeNode(node: any, nodeMap: Map<number, any>): { tag: string; text: string; selector: string; attributes: Record<string, string> } {
  if (!node) return { tag: 'unknown', text: '', selector: '', attributes: {} };

  const tag = (node.tagName || (node.type === 3 ? 'text' : 'unknown')).toLowerCase();
  const attrs: Record<string, string> = {};
  if (node.attributes) {
    for (const [k, v] of Object.entries(node.attributes)) {
      if (k !== 'style' && typeof v === 'string') attrs[k] = v as string;
    }
  }

  // Get text content: check direct textContent, child text nodes, and value attrs
  let text = '';
  if (node.type === 3) {
    text = (node.textContent || '').trim();
  }
  if (!text && node.childNodes) {
    for (const child of node.childNodes) {
      if (child.type === 3) {
        text += (child.textContent || '').trim() + ' ';
      }
    }
    text = text.trim();
  }
  if (!text && attrs.value) text = attrs.value;
  if (!text && attrs.placeholder) text = attrs.placeholder;
  if (!text && attrs.title) text = attrs.title;
  if (!text && attrs['aria-label']) text = attrs['aria-label'];
  if (!text && attrs.alt) text = attrs.alt;

  // Search up to 3 parent levels for text if we're on a non-text element
  if (!text) {
    let searchNode = node;
    for (let depth = 0; depth < 3 && !text && searchNode; depth++) {
      if (searchNode.childNodes) {
        for (const child of searchNode.childNodes) {
          if (child.type === 3 && (child.textContent || '').trim()) {
            text = (child.textContent || '').trim();
            break;
          }
        }
      }
      // Walk up via nodeMap (find parent by checking all nodes)
      if (!text && searchNode.parentId) {
        searchNode = nodeMap.get(searchNode.parentId);
      } else break;
    }
  }

  if (text.length > 100) text = text.substring(0, 100) + '...';

  // Build a CSS-like selector
  let selector = tag;
  if (attrs.id) selector += '#' + attrs.id;
  if (attrs.class) selector += '.' + attrs.class.split(/\s+/).filter(Boolean).join('.');

  return { tag, text, selector, attributes: attrs };
}

function getClickContext(node: any, nodeMap: Map<number, any>): { nearbyText: string[]; parentChain: string[]; rowContent: string } {
  const nearbyText: string[] = [];
  const parentChain: string[] = [];
  let rowContent = '';

  // Collect text from a subtree (limited depth)
  function collectText(n: any, depth: number): void {
    if (!n || depth > 3) return;
    if (n.type === 3 && n.textContent?.trim()) {
      const t = n.textContent.trim();
      if (t.length > 0 && t.length < 200) nearbyText.push(t);
    }
    if (n.childNodes) {
      for (const child of n.childNodes) collectText(child, depth + 1);
    }
  }

  // Walk up the ancestor chain to find context
  let current = node;
  for (let i = 0; i < 10 && current; i++) {
    if (current.tagName) {
      const tag = current.tagName.toLowerCase();
      const cls = current.attributes?.class || '';
      const role = current.attributes?.role || '';
      parentChain.push(tag + (cls ? '.' + cls.split(/\s+/)[0] : ''));

      // Table row: collect all cell text
      if (tag === 'tr' && !rowContent) {
        const rowTexts: string[] = [];
        function walkRow(rn: any) {
          if (rn.type === 3 && rn.textContent?.trim()) rowTexts.push(rn.textContent.trim());
          if (rn.childNodes) rn.childNodes.forEach(walkRow);
        }
        walkRow(current);
        rowContent = rowTexts.join(' | ');
        if (rowContent.length > 400) rowContent = rowContent.substring(0, 400) + '...';
      }

      // Modal/dialog: collect title and visible content
      if ((role === 'dialog' || cls.includes('modal') || cls.includes('dialog') || cls.includes('overlay') || cls.includes('popup')) && !rowContent) {
        const modalTexts: string[] = [];
        function walkModal(mn: any, d: number) {
          if (!mn || d > 4) return;
          if (mn.type === 3 && mn.textContent?.trim()) modalTexts.push(mn.textContent.trim());
          if (mn.childNodes) mn.childNodes.forEach((c: any) => walkModal(c, d + 1));
        }
        walkModal(current, 0);
        rowContent = 'Modal: ' + modalTexts.slice(0, 10).join(' | ');
        if (rowContent.length > 400) rowContent = rowContent.substring(0, 400) + '...';
      }

      // Card/panel: collect heading + content
      if ((cls.includes('card') || cls.includes('panel') || cls.includes('section')) && !rowContent && i <= 4) {
        collectText(current, 0);
      }

      // Meaningful containers: collect text
      if (['button', 'a', 'li', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'td', 'th', 'select', 'option'].includes(tag) && i <= 4) {
        collectText(current, 0);
      }
    }
    current = current.parentId ? nodeMap.get(current.parentId) : null;
  }

  return {
    nearbyText: [...new Set(nearbyText)].slice(0, 8),
    parentChain: parentChain.slice(0, 6),
    rowContent,
  };
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

// ── Storage Size ───────────────────────────────────────────────────────────

export async function getSegmentStorageSize(segmentId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Get the session for this segment to sum all session recordings
    const segResult = await client.query(
      `SELECT session_id FROM platform.session_segments WHERE id = $1`,
      [segmentId]
    );
    if (segResult.rows.length === 0) return { segmentBytes: 0, sessionBytes: 0 };
    const sessionId = segResult.rows[0].session_id;

    // Segment-specific size
    const segSize = await client.query(
      `SELECT COALESCE(SUM(octet_length(events)), 0)::bigint AS bytes
       FROM platform.segment_recordings WHERE segment_id = $1`,
      [segmentId]
    );

    // Total session size (all segments)
    const sessSize = await client.query(
      `SELECT COALESCE(SUM(octet_length(r.events)), 0)::bigint AS bytes
       FROM platform.segment_recordings r
       JOIN platform.session_segments s ON s.id = r.segment_id
       WHERE s.session_id = $1`,
      [sessionId]
    );

    return {
      segmentBytes: parseInt(segSize.rows[0].bytes, 10),
      sessionBytes: parseInt(sessSize.rows[0].bytes, 10),
      segmentFormatted: formatBytes(parseInt(segSize.rows[0].bytes, 10)),
      sessionFormatted: formatBytes(parseInt(sessSize.rows[0].bytes, 10)),
    };
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ── Export ──────────────────────────────────────────────────────────────────

export async function exportSegment(segmentId: string, format: string) {
  const segment = await getSegment(segmentId);
  const clicks = await getClickDetails(segmentId);
  const storage = await getSegmentStorageSize(segmentId);

  const exportData = {
    session: {
      segmentId: segment.id,
      sessionId: segment.session_id,
      user: { name: segment.user_name, email: segment.user_email },
      tenant: segment.tenant_name || undefined,
      dashboard: segment.dashboard_name || undefined,
      segmentType: segment.segment_type,
      startedAt: segment.started_at,
      endedAt: segment.ended_at,
      durationSeconds: segment.duration_seconds,
      viewport: { width: segment.viewport_width, height: segment.viewport_height },
      userAgent: segment.user_agent,
    },
    metrics: {
      clickCount: segment.click_count,
      pageCount: segment.page_count,
      storageSizeCompressed: storage.segmentFormatted,
      storageBytesCompressed: storage.segmentBytes,
      totalSessionStorage: storage.sessionFormatted,
    },
    clicks: clicks.map((c: any) => ({
      time: c.timeFormatted,
      timeMs: c.timeOffset,
      element: c.element,
      text: c.text,
      selector: c.selector,
      coordinates: { x: c.x, y: c.y },
      attributes: c.attributes,
      context: c.context,
    })),
    tags: (segment.tags || []).map((t: any) => t.tag || t.name || t),
    comments: (segment.comments || []).map((c: any) => ({
      author: c.user_name || c.user_email,
      body: c.body,
      timestampSeconds: c.timestamp_seconds,
    })),
    flags: {
      isTraining: segment.is_training,
      isPermanent: segment.is_permanent,
    },
    _exportedAt: new Date().toISOString(),
    _format: 'xray-session-replay-v1',
    _aiReviewPrompt: 'This is a session replay export from XRay BI. Review the user\'s click sequence, timing between clicks, and the elements they interacted with. Identify: 1) User intent and workflow patterns, 2) Potential UX friction points (long gaps, repeated clicks, back-and-forth), 3) Feature adoption metrics, 4) Suggested improvements.',
  };

  if (format === 'csv') {
    // CSV format: one row per click
    const header = 'Time,Element,Text,Selector,X,Y,Attributes';
    const rows = clicks.map((c: any) =>
      `"${c.timeFormatted}","${c.element}","${(c.text || '').replace(/"/g, '""')}","${c.selector}",${c.x},${c.y},"${JSON.stringify(c.attributes).replace(/"/g, '""')}"`
    );
    return header + '\n' + rows.join('\n');
  }

  return exportData;
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
  search?: string;
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
    if (filters?.search) {
      conditions.push(`(u.name ILIKE $${idx} OR u.email ILIKE $${idx} OR t.name ILIKE $${idx})`);
      values.push(`%${filters.search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const limit = Math.min(filters?.limit || 50, 200);
    const offset = filters?.offset || 0;

    const countResult = await client.query(
      `SELECT count(*)::int AS total
       FROM platform.session_segments seg
       JOIN platform.sessions s ON s.id = seg.session_id
       LEFT JOIN platform.users u ON u.id = s.user_id
       LEFT JOIN platform.tenants t ON t.id = s.tenant_id
       ${where}`,
      values
    );

    const result = await client.query(
      `SELECT seg.*, s.user_id, s.tenant_id, s.user_agent,
              s.is_active AS session_is_active, s.id AS session_id,
              s.duration_seconds AS session_duration_seconds,
              u.name AS user_name, u.email AS user_email,
              d.name AS dashboard_name,
              t.name AS tenant_name
       FROM platform.session_segments seg
       JOIN platform.sessions s ON s.id = seg.session_id
       LEFT JOIN platform.users u ON u.id = s.user_id
       LEFT JOIN platform.dashboards d ON d.id = seg.dashboard_id
       LEFT JOIN platform.tenants t ON t.id = s.tenant_id
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
       LEFT JOIN platform.users u ON u.id = t.created_by
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

// ── Delete Segment ─────────────────────────────────────────────────────────

export async function deleteSegment(segmentId: string) {
  return withTransaction(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    // Delete recordings, tags, comments, then the segment itself (CASCADE handles most)
    await client.query(`DELETE FROM platform.segment_recordings WHERE segment_id = $1`, [segmentId]);
    await client.query(`DELETE FROM platform.segment_tags WHERE segment_id = $1`, [segmentId]);
    await client.query(`DELETE FROM platform.segment_comments WHERE segment_id = $1`, [segmentId]);
    const result = await client.query(
      `DELETE FROM platform.session_segments WHERE id = $1 RETURNING id`,
      [segmentId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Segment not found');
  });
}

// ── Tags ────────────────────────────────────────────────────────────────────

export async function addTag(segmentId: string, tag: string, userId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `INSERT INTO platform.segment_tags (segment_id, tag, created_by)
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

// ── Finalize User Sessions (on WS disconnect) ────────────────────────────

export async function finalizeUserSessions(userId: string) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT id FROM platform.sessions WHERE user_id = $1 AND is_active = true`,
      [userId]
    );
    for (const row of result.rows) {
      try {
        await finalizeStaleSession(row.id);
      } catch (e) {
        // Non-fatal
      }
    }
    if (result.rows.length > 0) {
      console.log(`[Replay] Finalized ${result.rows.length} sessions for disconnected user ${userId}`);
    }
  });
}

// ── Stale Session Cleanup ──────────────────────────────────────────────────

export async function finalizeStaleActiveSessions(maxAgeMinutes: number = 120) {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Find active sessions where the most recent activity is older than maxAgeMinutes.
    // "Most recent activity" = latest segment start, or session start if no segments.
    const result = await client.query(
      `SELECT s.id FROM platform.sessions s
       WHERE s.is_active = true
         AND COALESCE(
           (SELECT MAX(seg.started_at) FROM platform.session_segments seg WHERE seg.session_id = s.id),
           s.started_at
         ) < now() - ($1 || ' minutes')::interval`,
      [maxAgeMinutes]
    );

    let count = 0;
    for (const row of result.rows) {
      try {
        await finalizeStaleSession(row.id);
        count++;
      } catch (e) {
        // Non-fatal: session may have been finalized concurrently
      }
    }
    if (count > 0) console.log(`[Replay] Finalized ${count} stale sessions`);
    return { finalized: count };
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
