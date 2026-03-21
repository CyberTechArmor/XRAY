import { withClient } from '../db/connection';

// ── Types ──
export interface Thread {
  id: string;
  subject: string;
  is_starred: boolean;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  last_sender_name: string;
  last_sender_id: string;
  last_preview: string;
  is_read: boolean;
  participant_count: number;
  message_count: number;
  participants: { id: string; name: string; email: string }[];
}

export interface Message {
  id: string;
  thread_id: string;
  sender_id: string;
  sender_name: string;
  sender_email: string;
  body: string;
  created_at: string;
}

// ── List threads for a user ──
export async function listThreads(
  userId: string,
  tenantId: string,
  isPlatformAdmin: boolean,
  search?: string,
  limit = 50,
  offset = 0,
  archived = false
): Promise<Thread[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    let whereClause = `tp.user_id = $1`;
    const params: any[] = [userId, limit, offset];

    // Filter by archive status
    whereClause += ` AND COALESCE(tp.is_archived, false) = ${archived}`;

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (t.subject ILIKE $${params.length} OR EXISTS (
        SELECT 1 FROM platform.inbox_messages m2 WHERE m2.thread_id = t.id AND m2.body ILIKE $${params.length}
      ))`;
    }

    const result = await client.query(`
      SELECT t.id, t.subject, t.created_at, t.updated_at, t.tag,
        tp.is_starred, tp.is_read, COALESCE(tp.is_archived, false) AS is_archived,
        (SELECT COUNT(*) FROM platform.inbox_messages m WHERE m.thread_id = t.id) AS message_count,
        (SELECT COUNT(*) FROM platform.inbox_thread_participants tp2 WHERE tp2.thread_id = t.id) AS participant_count,
        lm.created_at AS last_message_at,
        lm.body AS last_preview,
        lu.name AS last_sender_name,
        lm.sender_id AS last_sender_id
      FROM platform.inbox_threads t
      JOIN platform.inbox_thread_participants tp ON tp.thread_id = t.id
      LEFT JOIN LATERAL (
        SELECT m.body, m.sender_id, m.created_at
        FROM platform.inbox_messages m
        WHERE m.thread_id = t.id
        ORDER BY m.created_at DESC LIMIT 1
      ) lm ON true
      LEFT JOIN platform.users lu ON lu.id = lm.sender_id
      WHERE ${whereClause}
      ORDER BY COALESCE(lm.created_at, t.created_at) DESC
      LIMIT $2 OFFSET $3
    `, params);

    // Get participants for each thread
    if (result.rows.length > 0) {
      const threadIds = result.rows.map((r: any) => r.id);
      const partResult = await client.query(`
        SELECT tp.thread_id, u.id, u.name, u.email
        FROM platform.inbox_thread_participants tp
        JOIN platform.users u ON u.id = tp.user_id
        WHERE tp.thread_id = ANY($1)
      `, [threadIds]);

      const partMap: Record<string, any[]> = {};
      for (const p of partResult.rows) {
        if (!partMap[p.thread_id]) partMap[p.thread_id] = [];
        partMap[p.thread_id].push({ id: p.id, name: p.name, email: p.email });
      }
      for (const row of result.rows) {
        (row as any).participants = partMap[row.id] || [];
        (row as any).last_preview = ((row as any).last_preview || '').substring(0, 120);
      }
    }

    return result.rows;
  });
}

// ── Get messages in a thread ──
export async function getThreadMessages(
  threadId: string,
  userId: string
): Promise<Message[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    // Verify user is a participant
    const partCheck = await client.query(
      `SELECT 1 FROM platform.inbox_thread_participants WHERE thread_id = $1 AND user_id = $2`,
      [threadId, userId]
    );
    if (partCheck.rows.length === 0) {
      throw Object.assign(new Error('Not a participant in this thread'), { statusCode: 403 });
    }

    // Mark as read
    await client.query(
      `UPDATE platform.inbox_thread_participants SET is_read = true WHERE thread_id = $1 AND user_id = $2`,
      [threadId, userId]
    );

    // Get messages (oldest first, newest at bottom)
    const result = await client.query(`
      SELECT m.id, m.thread_id, m.sender_id, m.body, m.created_at,
        u.name AS sender_name, u.email AS sender_email
      FROM platform.inbox_messages m
      JOIN platform.users u ON u.id = m.sender_id
      WHERE m.thread_id = $1
      ORDER BY m.created_at ASC
    `, [threadId]);

    return result.rows;
  });
}

// ── Send a new message (creates thread or replies) ──
export async function sendMessage(
  senderId: string,
  senderTenantId: string,
  isPlatformAdmin: boolean,
  opts: {
    threadId?: string;
    recipientIds?: string[];
    subject?: string;
    body: string;
    tag?: string;
  }
): Promise<{ threadId: string; messageId: string }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    let threadId: string | undefined = opts.threadId;

    if (threadId) {
      // Reply to existing thread
      const partCheck = await client.query(
        `SELECT 1 FROM platform.inbox_thread_participants WHERE thread_id = $1 AND user_id = $2`,
        [threadId, senderId]
      );
      if (partCheck.rows.length === 0) {
        throw Object.assign(new Error('Not a participant in this thread'), { statusCode: 403 });
      }

      // Insert message
      const msgResult = await client.query(
        `INSERT INTO platform.inbox_messages (thread_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id`,
        [threadId, senderId, opts.body]
      );

      // Update thread timestamp
      await client.query(
        `UPDATE platform.inbox_threads SET updated_at = now() WHERE id = $1`,
        [threadId]
      );

      // Mark unread for all participants except sender
      await client.query(
        `UPDATE platform.inbox_thread_participants SET is_read = false WHERE thread_id = $1 AND user_id != $2`,
        [threadId, senderId]
      );

      return { threadId: threadId!, messageId: msgResult.rows[0].id };
    }

    // New thread
    if (!opts.recipientIds || opts.recipientIds.length === 0) {
      throw Object.assign(new Error('Recipients are required for new threads'), { statusCode: 400 });
    }
    if (!opts.subject) {
      throw Object.assign(new Error('Subject is required for new threads'), { statusCode: 400 });
    }

    // Create thread
    const threadResult = await client.query(
      `INSERT INTO platform.inbox_threads (subject, tag) VALUES ($1, $2) RETURNING id`,
      [opts.subject, opts.tag || null]
    );
    threadId = threadResult.rows[0].id;

    // Add all participants (sender + recipients)
    const allParticipants = [senderId, ...opts.recipientIds.filter((id: string) => id !== senderId)];
    for (const pid of allParticipants) {
      await client.query(
        `INSERT INTO platform.inbox_thread_participants (thread_id, user_id, is_read) VALUES ($1, $2, $3)
         ON CONFLICT (thread_id, user_id) DO NOTHING`,
        [threadId, pid, pid === senderId]
      );
    }

    // Insert message
    const msgResult = await client.query(
      `INSERT INTO platform.inbox_messages (thread_id, sender_id, body) VALUES ($1, $2, $3) RETURNING id`,
      [threadId, senderId, opts.body]
    );

    return { threadId: threadId!, messageId: msgResult.rows[0].id };
  });
}

// ── Toggle star ──
export async function toggleStar(threadId: string, userId: string): Promise<boolean> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.inbox_thread_participants SET is_starred = NOT is_starred
       WHERE thread_id = $1 AND user_id = $2 RETURNING is_starred`,
      [threadId, userId]
    );
    if (result.rows.length === 0) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    return result.rows[0].is_starred;
  });
}

// ── Toggle archive ──
export async function toggleArchive(threadId: string, userId: string): Promise<boolean> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.inbox_thread_participants SET is_archived = NOT COALESCE(is_archived, false)
       WHERE thread_id = $1 AND user_id = $2 RETURNING is_archived`,
      [threadId, userId]
    );
    if (result.rows.length === 0) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    return result.rows[0].is_archived;
  });
}

// ── Set thread tag ──
export async function setThreadTag(threadId: string, tag: string | null): Promise<string | null> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `UPDATE platform.inbox_threads SET tag = $1 WHERE id = $2 RETURNING tag`,
      [tag, threadId]
    );
    if (result.rows.length === 0) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    return result.rows[0].tag;
  });
}

// ── Get recipients (tenant members + XRay Support) ──
export async function getRecipients(
  userId: string,
  tenantId: string,
  isPlatformAdmin: boolean
): Promise<{ members: any[]; tenants?: any[] }> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);

    if (isPlatformAdmin) {
      // Platform admin: get all tenants
      const tenants = await client.query(
        `SELECT id, name, slug FROM platform.tenants ORDER BY name`
      );
      return { members: [], tenants: tenants.rows };
    }

    // Regular user: get tenant members + platform admin as "XRay Support"
    const members = await client.query(
      `SELECT u.id, u.name, u.email FROM platform.users u
       WHERE u.tenant_id = $1 AND u.id != $2 AND u.status = 'active'
       ORDER BY u.name`,
      [tenantId, userId]
    );

    // Add platform admins as "XRay Support"
    const admins = await client.query(
      `SELECT u.id, u.name, u.email FROM platform.users u
       JOIN platform.roles r ON r.id = u.role_id
       WHERE r.slug = 'platform_admin' AND u.status = 'active'`
    );

    const supportMembers = admins.rows.map((a: any) => ({
      id: a.id,
      name: 'XRay Support',
      email: a.email,
      is_support: true
    }));

    return { members: [...members.rows, ...supportMembers] };
  });
}

// ── Get tenant members (for platform admin compose) ──
export async function getTenantMembers(tenantId: string): Promise<any[]> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT u.id, u.name, u.email FROM platform.users u
       WHERE u.tenant_id = $1 AND u.status = 'active' ORDER BY u.name`,
      [tenantId]
    );
    return result.rows;
  });
}

// ── Get unread count ──
export async function getUnreadCount(userId: string): Promise<number> {
  return withClient(async (client) => {
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    const result = await client.query(
      `SELECT COUNT(*) FROM platform.inbox_thread_participants WHERE user_id = $1 AND is_read = false`,
      [userId]
    );
    return parseInt(result.rows[0].count, 10);
  });
}
