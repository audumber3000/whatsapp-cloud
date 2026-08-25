/**
 * Team inbox.
 *
 * The Inbox screen has existed in the UI for a while and has never worked:
 * `InboxView` fetches /api/inbox, /api/inbox/:number and .../reply, and none
 * of those routes were ever written. Every call 404'd, the component swallowed
 * the error, and the screen showed "No replies yet" no matter how many replies
 * had actually arrived. That is the real reason it read as useless.
 *
 * A conversation is one row per (org, contact). Messages themselves stay where
 * they already live — inbound_messages for what the patient sent,
 * automation_logs for what we sent — and this joins them into one stream.
 */

const express = require('express');
const db = require('./db');
const whatsapp = require('./whatsapp');

/** Free-text search and label filters both need the same base scoping. */
const BASE_JOIN = `
      FROM conversations cv
      JOIN contacts c ON c.id = cv.contact_id
 LEFT JOIN users u ON u.id = cv.assignee_id
`;

const SELECT_CONVERSATION = `
    SELECT cv.id, cv.status, cv.assignee_id, cv.assigned_at, cv.unread_count,
           cv.last_message_at, cv.last_inbound_at, cv.last_outbound_at,
           cv.first_response_at, cv.resolved_at,
           c.id AS contact_id, c.name, c.phone, c.opted_out, c.wa_valid,
           u.username AS assignee_name, u.full_name AS assignee_full_name,
           COALESCE(
             (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'colour', l.colour))
                FROM conversation_labels cl JOIN labels l ON l.id = cl.label_id
               WHERE cl.conversation_id = cv.id), '[]'::json) AS labels
`;

/** WhatsApp only allows free-form replies within 24h of the patient's last message. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
const windowState = (lastInboundAt) => {
    if (!lastInboundAt) return { open: false, expiresAt: null, reason: 'never_messaged' };
    const expires = new Date(lastInboundAt).getTime() + WINDOW_MS;
    return { open: Date.now() < expires, expiresAt: new Date(expires).toISOString(), reason: null };
};

const decorate = (row) => ({ ...row, window: windowState(row.last_inbound_at) });

function router({ authenticateToken, requireRole }) {
    const r = express.Router();
    r.use(express.json({ limit: '1mb' }));
    r.use(authenticateToken);

    /** Ownership check, so no route ever trusts a conversation id from the client. */
    const load = async (req, res) => {
        const cv = await db.one(
            'SELECT * FROM conversations WHERE id = ? AND org_id = ?',
            [req.params.id, req.user.org_id]);
        if (!cv) { res.status(404).json({ error: 'Conversation not found' }); return null; }
        return cv;
    };

    const logEvent = (conversationId, actor, kind, detail = {}) =>
        db.query(
            'INSERT INTO conversation_events (conversation_id, actor_user_id, kind, detail) VALUES (?, ?, ?, ?)',
            [conversationId, actor, kind, JSON.stringify(detail)]).catch(() => {});

    /* ── list ───────────────────────────────────────────────────────────── */
    r.get('/', async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

        const where = ['cv.org_id = ?', 'c.deleted_at IS NULL'];
        const params = [req.user.org_id];

        // 'all' deliberately still hides resolved — an inbox is a work queue,
        // not an archive. Resolved is its own explicit view.
        const status = req.query.status || 'open';
        if (status === 'open') where.push("cv.status = 'open'");
        else if (status === 'pending') where.push("cv.status = 'pending'");
        else if (status === 'resolved') where.push("cv.status = 'resolved'");
        else where.push("cv.status <> 'resolved'");

        const assignee = req.query.assignee || 'all';
        if (assignee === 'me') { where.push('cv.assignee_id = ?'); params.push(req.user.id); }
        else if (assignee === 'unassigned') where.push('cv.assignee_id IS NULL');
        else if (assignee !== 'all') { where.push('cv.assignee_id = ?'); params.push(assignee); }

        if (req.query.label) {
            where.push(`EXISTS (SELECT 1 FROM conversation_labels cl JOIN labels l ON l.id = cl.label_id
                                 WHERE cl.conversation_id = cv.id AND l.name = ?)`);
            params.push(req.query.label);
        }
        const search = (req.query.search || '').trim();
        if (search) {
            where.push('(c.name ILIKE ? OR c.phone LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        const whereSql = where.join(' AND ');

        try {
            const [total, rows, counts] = await Promise.all([
                db.one(`SELECT COUNT(*)::int AS n ${BASE_JOIN} WHERE ${whereSql}`, params),
                db.many(
                    `${SELECT_CONVERSATION},
                     (SELECT json_build_object('body', m.body, 'at', m.at, 'direction', m.direction)
                        FROM (
                          SELECT body, received_at AS at, 'in' AS direction
                            FROM inbound_messages WHERE contact_id = c.id
                           UNION ALL
                          SELECT content, sent_time, 'out'
                            FROM automation_logs
                           WHERE contact_id = c.id AND sent_time IS NOT NULL AND status <> 'pending'
                        ) m ORDER BY m.at DESC LIMIT 1) AS last_message
                     ${BASE_JOIN}
                     WHERE ${whereSql}
                     ORDER BY cv.last_message_at DESC NULLS LAST
                     LIMIT ? OFFSET ?`,
                    [...params, limit, (page - 1) * limit]),
                // The filter chips carry their own counts, so switching views is
                // not a guess about where the work is.
                db.many(
                    `SELECT cv.status,
                            COUNT(*)::int AS n,
                            COUNT(*) FILTER (WHERE cv.assignee_id = ?)::int AS mine,
                            COUNT(*) FILTER (WHERE cv.assignee_id IS NULL)::int AS unassigned
                       FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
                      WHERE cv.org_id = ? AND c.deleted_at IS NULL
                      GROUP BY cv.status`,
                    [req.user.id, req.user.org_id]),
            ]);

            res.json({
                data: rows.map(decorate),
                counts: counts.reduce((acc, c) => {
                    acc[c.status] = c.n;
                    acc.mine = (acc.mine || 0) + (c.status === 'resolved' ? 0 : c.mine);
                    acc.unassigned = (acc.unassigned || 0) + (c.status === 'resolved' ? 0 : c.unassigned);
                    return acc;
                }, { open: 0, pending: 0, resolved: 0, mine: 0, unassigned: 0 }),
                pagination: { page, limit, total: total.n, totalPages: Math.max(Math.ceil(total.n / limit), 1) },
            });
        } catch (e) {
            console.error('[inbox] list failed:', e.message);
            res.status(500).json({ error: 'Could not load the inbox' });
        }
    });

    /** Who can be assigned work. */
    r.get('/members', async (req, res) => {
        try {
            const rows = await db.many(
                `SELECT u.id, u.username, u.full_name, m.role
                   FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.org_id = ? AND m.status = 'active' AND u.deleted_at IS NULL
                  ORDER BY lower(COALESCE(u.full_name, u.username))`,
                [req.user.org_id]);
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: 'Could not load members' });
        }
    });

    /* ── one conversation ───────────────────────────────────────────────── */
    r.get('/:id', async (req, res) => {
        try {
            const cv = await db.one(
                `${SELECT_CONVERSATION} ${BASE_JOIN} WHERE cv.id = ? AND cv.org_id = ?`,
                [req.params.id, req.user.org_id]);
            if (!cv) return res.status(404).json({ error: 'Conversation not found' });

            // Notes and events interleave with the messages, so the thread reads
            // as one history rather than three lists to reconcile by timestamp.
            const messages = await db.many(
                `SELECT 'in' AS kind, im.received_at AS at, im.body, im.media_type, im.media_path,
                        im.intent, NULL AS status, NULL AS delivery_status, NULL AS author,
                        NULL AS event_kind, NULL::jsonb AS detail
                   FROM inbound_messages im WHERE im.contact_id = ?
                 UNION ALL
                 SELECT 'out', al.sent_time, al.content, NULL, NULL,
                        NULL, al.status, al.delivery_status,
                        COALESCE(su.full_name, su.username, a.name), NULL, NULL
                   FROM automation_logs al
                   LEFT JOIN users su ON su.id = al.sent_by
                   LEFT JOIN automations a ON a.id = al.automation_id
                  WHERE al.contact_id = ? AND al.sent_time IS NOT NULL AND al.status <> 'pending'
                 UNION ALL
                 SELECT 'note', n.created_at, n.body, NULL, NULL,
                        NULL, NULL, NULL, COALESCE(nu.full_name, nu.username), NULL, NULL
                   FROM conversation_notes n LEFT JOIN users nu ON nu.id = n.author_user_id
                  WHERE n.conversation_id = ?
                 UNION ALL
                 SELECT 'event', e.created_at, NULL, NULL, NULL,
                        NULL, NULL, NULL, COALESCE(eu.full_name, eu.username), e.kind, e.detail
                   FROM conversation_events e LEFT JOIN users eu ON eu.id = e.actor_user_id
                  WHERE e.conversation_id = ?
                 ORDER BY at ASC
                 LIMIT 500`,
                [cv.contact_id, cv.contact_id, cv.id, cv.id]);

            res.json({ conversation: decorate(cv), messages });
        } catch (e) {
            console.error('[inbox] thread failed:', e.message);
            res.status(500).json({ error: 'Could not load that conversation' });
        }
    });

    /* ── reply ──────────────────────────────────────────────────────────── */
    r.post('/:id/reply', async (req, res) => {
        const body = String(req.body?.body || '').trim();
        if (!body) return res.status(400).json({ error: 'Nothing to send' });
        if (body.length > 4096) return res.status(400).json({ error: 'Message is too long (max 4096 characters)' });

        try {
            const cv = await load(req, res);
            if (!cv) return;

            const contact = await db.one(
                'SELECT phone, name, opted_out FROM contacts WHERE id = ?', [cv.contact_id]);
            // The same hard stop the automations and the public API honour.
            if (contact?.opted_out) return res.status(403).json({ error: 'This contact has opted out of messages' });

            const win = windowState(cv.last_inbound_at);
            if (!win.open) {
                return res.status(409).json({
                    error: 'Outside the 24-hour window',
                    detail: 'WhatsApp only allows a free-form reply within 24 hours of the customer\'s last message.',
                    window: win,
                });
            }

            // Separate "the number is unlinked" from "the send failed", because
            // sendMessage returns false for both and they need different fixes.
            if (!whatsapp.getStatus(req.user.org_id).isConnected) {
                return res.status(409).json({ error: 'WhatsApp is not connected. Re-link the number in Settings.' });
            }
            const sent = await whatsapp.sendMessage(req.user.org_id, contact.phone, body);
            if (!sent) return res.status(502).json({ error: 'WhatsApp could not send that message' });

            const log = await db.one(
                `INSERT INTO automation_logs
                   (org_id, contact_id, status, content, sent_time, wa_message_id, sent_by)
                 VALUES (?, ?, 'sent', ?, NOW(), ?, ?)
                 RETURNING id, sent_time`,
                [req.user.org_id, cv.contact_id, body, typeof sent === 'string' ? sent : null, req.user.id]);

            // first_response_at is per-round: it is cleared on each new inbound,
            // so the SLA measures this exchange, not the conversation's lifetime.
            await db.query(
                `UPDATE conversations
                    SET last_outbound_at = NOW(), last_message_at = NOW(),
                        first_response_at = COALESCE(first_response_at, NOW()),
                        status = CASE WHEN status = 'resolved' THEN 'pending' ELSE status END,
                        unread_count = 0, updated_at = NOW()
                  WHERE id = ?`, [cv.id]);

            await db.query('UPDATE contacts SET last_contacted_at = NOW() WHERE id = ?', [cv.contact_id]);

            whatsapp.emitToOrg(req.user.org_id, 'inbox:message', {
                conversationId: cv.id,
                message: { kind: 'out', at: log.sent_time, body, status: 'sent',
                           author: req.user.username, delivery_status: null },
            });

            res.json({ success: true, id: log.id, at: log.sent_time });
        } catch (e) {
            console.error('[inbox] reply failed:', e.message);
            res.status(500).json({ error: 'Could not send that reply' });
        }
    });

    /* ── internal note ──────────────────────────────────────────────────── */
    r.post('/:id/notes', async (req, res) => {
        const body = String(req.body?.body || '').trim();
        if (!body) return res.status(400).json({ error: 'A note needs some text' });
        try {
            const cv = await load(req, res);
            if (!cv) return;
            const note = await db.one(
                `INSERT INTO conversation_notes (conversation_id, author_user_id, body)
                 VALUES (?, ?, ?) RETURNING id, created_at`,
                [cv.id, req.user.id, body]);
            whatsapp.emitToOrg(req.user.org_id, 'inbox:message', {
                conversationId: cv.id,
                message: { kind: 'note', at: note.created_at, body, author: req.user.username },
            });
            res.json({ id: note.id, at: note.created_at });
        } catch (e) {
            res.status(500).json({ error: 'Could not save that note' });
        }
    });

    /* ── assignment, status, read ───────────────────────────────────────── */
    r.patch('/:id', async (req, res) => {
        const { assignee_id, status, read } = req.body || {};
        try {
            const cv = await load(req, res);
            if (!cv) return;

            if (assignee_id !== undefined) {
                if (assignee_id) {
                    // An agent from another org must never appear on this queue.
                    const member = await db.one(
                        `SELECT u.id, COALESCE(u.full_name, u.username) AS name
                           FROM memberships m JOIN users u ON u.id = m.user_id
                          WHERE m.org_id = ? AND m.user_id = ? AND m.status = 'active'`,
                        [req.user.org_id, assignee_id]);
                    if (!member) return res.status(400).json({ error: 'That person is not in this workspace' });
                    await db.query(
                        'UPDATE conversations SET assignee_id = ?, assigned_at = NOW(), updated_at = NOW() WHERE id = ?',
                        [assignee_id, cv.id]);
                    await logEvent(cv.id, req.user.id, 'assigned', { to: member.name });
                } else {
                    await db.query(
                        'UPDATE conversations SET assignee_id = NULL, assigned_at = NULL, updated_at = NOW() WHERE id = ?',
                        [cv.id]);
                    await logEvent(cv.id, req.user.id, 'unassigned', {});
                }
            }

            if (status !== undefined) {
                if (!['open', 'pending', 'resolved'].includes(status)) {
                    return res.status(400).json({ error: 'Unknown status' });
                }
                await db.query(
                    `UPDATE conversations
                        SET status = ?,
                            resolved_at = CASE WHEN ? = 'resolved' THEN NOW() ELSE NULL END,
                            resolved_by = CASE WHEN ? = 'resolved' THEN ?::uuid ELSE NULL END,
                            updated_at = NOW()
                      WHERE id = ?`,
                    [status, status, status, req.user.id, cv.id]);
                await logEvent(cv.id, req.user.id, 'status', { to: status });
            }

            if (read) {
                await db.query('UPDATE conversations SET unread_count = 0, updated_at = NOW() WHERE id = ?', [cv.id]);
                await db.query('UPDATE inbound_messages SET is_read = TRUE WHERE contact_id = ? AND NOT is_read',
                    [cv.contact_id]);
            }

            const fresh = await db.one(
                `${SELECT_CONVERSATION} ${BASE_JOIN} WHERE cv.id = ?`, [cv.id]);
            whatsapp.emitToOrg(req.user.org_id, 'inbox:updated', { conversation: decorate(fresh) });
            res.json(decorate(fresh));
        } catch (e) {
            console.error('[inbox] update failed:', e.message);
            res.status(500).json({ error: 'Could not update that conversation' });
        }
    });

    /* ── labels on a conversation ───────────────────────────────────────── */
    r.put('/:id/labels', async (req, res) => {
        const ids = Array.isArray(req.body?.label_ids) ? req.body.label_ids : [];
        try {
            const cv = await load(req, res);
            if (!cv) return;
            await db.query('DELETE FROM conversation_labels WHERE conversation_id = ?', [cv.id]);
            if (ids.length) {
                await db.query(
                    `INSERT INTO conversation_labels (conversation_id, label_id)
                     SELECT ?, l.id FROM labels l WHERE l.id = ANY(?::uuid[]) AND l.org_id = ?`,
                    [cv.id, ids, req.user.org_id]);
            }
            const fresh = await db.one(`${SELECT_CONVERSATION} ${BASE_JOIN} WHERE cv.id = ?`, [cv.id]);
            res.json(decorate(fresh));
        } catch (e) {
            res.status(500).json({ error: 'Could not update labels' });
        }
    });

    return r;
}

/* ── org-level configuration: labels and canned replies ─────────────────── */
function configRouter({ authenticateToken, requireRole }) {
    const r = express.Router();
    r.use(express.json({ limit: '256kb' }));

    r.get('/labels', authenticateToken, async (req, res) => {
        try {
            res.json(await db.many(
                `SELECT l.id, l.name, l.colour,
                        (SELECT COUNT(*)::int FROM conversation_labels cl WHERE cl.label_id = l.id) AS use_count
                   FROM labels l WHERE l.org_id = ? ORDER BY lower(l.name)`,
                [req.user.org_id]));
        } catch (e) { res.status(500).json({ error: 'Could not load labels' }); }
    });

    r.post('/labels', authenticateToken, requireRole('manager'), async (req, res) => {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'A label needs a name' });
        try {
            const row = await db.one(
                `INSERT INTO labels (org_id, name, colour) VALUES (?, ?, ?)
                 ON CONFLICT (org_id, name) DO UPDATE SET colour = EXCLUDED.colour
                 RETURNING id, name, colour`,
                [req.user.org_id, name, req.body?.colour || '#00A884']);
            res.json(row);
        } catch (e) { res.status(500).json({ error: 'Could not create that label' }); }
    });

    r.delete('/labels/:id', authenticateToken, requireRole('manager'), async (req, res) => {
        try {
            await db.query('DELETE FROM labels WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Could not delete that label' }); }
    });

    r.get('/canned-replies', authenticateToken, async (req, res) => {
        try {
            res.json(await db.many(
                'SELECT id, shortcut, title, body, use_count FROM canned_replies WHERE org_id = ? ORDER BY lower(shortcut)',
                [req.user.org_id]));
        } catch (e) { res.status(500).json({ error: 'Could not load canned replies' }); }
    });

    r.post('/canned-replies', authenticateToken, async (req, res) => {
        const shortcut = String(req.body?.shortcut || '').trim().replace(/^\//, '').toLowerCase();
        const title = String(req.body?.title || '').trim();
        const body = String(req.body?.body || '').trim();
        if (!shortcut || !body) return res.status(400).json({ error: 'A shortcut and a message are both required' });
        if (!/^[a-z0-9-]{1,32}$/.test(shortcut)) {
            return res.status(400).json({ error: 'Shortcuts can use letters, numbers and hyphens only' });
        }
        try {
            const row = await db.one(
                `INSERT INTO canned_replies (org_id, shortcut, title, body, created_by)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (org_id, shortcut) DO UPDATE
                   SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = NOW()
                 RETURNING id, shortcut, title, body, use_count`,
                [req.user.org_id, shortcut, title || shortcut, body, req.user.id]);
            res.json(row);
        } catch (e) { res.status(500).json({ error: 'Could not save that reply' }); }
    });

    r.delete('/canned-replies/:id', authenticateToken, async (req, res) => {
        try {
            await db.query('DELETE FROM canned_replies WHERE id = ? AND org_id = ?',
                [req.params.id, req.user.org_id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Could not delete that reply' }); }
    });

    return r;
}

module.exports = { router, configRouter, windowState };
