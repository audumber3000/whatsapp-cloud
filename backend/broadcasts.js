/**
 * Broadcasts — a template, an audience, and a schedule.
 *
 * The existing bulk path is an automation whose "contacts" field is a pasted
 * comma-separated list of numbers. That cannot be re-targeted, cannot exclude
 * opt-outs by construction, and when sends fail it leaves a count rather than
 * a list. A broadcast resolves its audience into one row per recipient before
 * it sends anything, so "43 failures" is answerable without SQL.
 *
 * Sending reuses the scheduler's pacing: a randomised gap between recipients,
 * because a burst of identical messages from one number is what gets a number
 * flagged.
 */

const express = require('express');
const path = require('path');
const db = require('./db');
const whatsapp = require('./whatsapp');
const { render, variablesIn } = require('./templates');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEDIA_DIR = path.join(__dirname, 'uploads', 'media');

/** sendMedia wants a path on disk, not the row. Same mapping the scheduler uses. */
const toMediaPayload = (row) => row && ({
    filePath: path.join(MEDIA_DIR, row.stored_name),
    mimetype: row.mimetype,
    filename: row.original_name,
});

/* ── audience ───────────────────────────────────────────────────────────── */

/**
 * Turn a saved filter into SQL.
 *
 * Opted-out contacts are excluded here rather than skipped later, so an
 * audience count never promises to message someone we must not message.
 */
function audienceSql(filter = {}, orgId) {
    const where = ['c.org_id = ?', 'c.deleted_at IS NULL', 'c.opted_out = FALSE'];
    const params = [orgId];

    if (filter.tag) {
        where.push(`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                             WHERE ct.contact_id = c.id AND t.name = ?)`);
        params.push(filter.tag);
    }
    if (filter.search) {
        where.push('(c.name ILIKE ? OR c.phone LIKE ?)');
        params.push(`%${filter.search}%`, `%${filter.search}%`);
    }
    // Numbers already known not to be on WhatsApp are excluded by default;
    // `include_invalid` is for the case where the check itself is stale.
    if (!filter.include_invalid) where.push('(c.wa_valid IS NULL OR c.wa_valid = TRUE)');
    if (filter.has_replied) {
        where.push('EXISTS (SELECT 1 FROM inbound_messages im WHERE im.contact_id = c.id)');
    }
    if (filter.never_contacted) where.push('c.last_contacted_at IS NULL');

    return { where: where.join(' AND '), params };
}

const resolveFilter = async (orgId, segmentId, audience) => {
    if (segmentId) {
        const seg = await db.one('SELECT filter FROM segments WHERE id = ? AND org_id = ?', [segmentId, orgId]);
        if (seg) return seg.filter || {};
    }
    return audience || {};
};

/* ── sending ────────────────────────────────────────────────────────────── */

// One broadcast at a time per process. Two overlapping runs would interleave
// sends from the same number and defeat the pacing that keeps it unflagged.
const running = new Set();

async function runBroadcast(broadcastId) {
    if (running.has(broadcastId)) return;
    running.add(broadcastId);
    try {
        const b = await db.one('SELECT * FROM broadcasts WHERE id = ?', [broadcastId]);
        if (!b || !['scheduled', 'sending'].includes(b.status)) return;

        if (!whatsapp.getStatus(b.org_id).isConnected) {
            await db.query(
                `UPDATE broadcasts SET status = 'failed', finished_at = NOW(), updated_at = NOW() WHERE id = ?`,
                [broadcastId]);
            whatsapp.notifyUser(b.org_id, 'error',
                `Broadcast "${b.name}" could not start — WhatsApp is not connected.`);
            return;
        }

        await db.query(
            `UPDATE broadcasts SET status = 'sending', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
              WHERE id = ?`, [broadcastId]);

        const media = b.media_id
            ? toMediaPayload(await db.one(
                'SELECT * FROM media_attachments WHERE id = ? AND org_id = ?', [b.media_id, b.org_id]))
            : null;

        // Only pending rows, so a resumed run never messages anyone twice.
        const pending = await db.many(
            `SELECT r.id, r.contact_id, c.name, c.phone, c.email, c.custom, c.opted_out
               FROM broadcast_recipients r JOIN contacts c ON c.id = r.contact_id
              WHERE r.broadcast_id = ? AND r.status = 'pending'
              ORDER BY r.id`, [broadcastId]);

        for (const p of pending) {
            const fresh = await db.one('SELECT status FROM broadcasts WHERE id = ?', [broadcastId]);
            if (fresh?.status === 'cancelled') break;

            // Re-checked per recipient: someone can opt out mid-run, and the
            // whole point of honouring it is that it takes effect immediately.
            if (p.opted_out) {
                await db.query(
                    `UPDATE broadcast_recipients SET status = 'skipped', skip_reason = 'opted_out' WHERE id = ?`,
                    [p.id]);
                await db.query('UPDATE broadcasts SET skipped_count = skipped_count + 1 WHERE id = ?', [broadcastId]);
                continue;
            }

            const body = render(b.body, p, b.variables || {});
            let messageId = null;
            let ok = false;

            try {
                if (media) {
                    messageId = await whatsapp.sendMedia(b.org_id, p.phone, { ...media, caption: body });
                } else if (Array.isArray(b.buttons) && b.buttons.length) {
                    messageId = await whatsapp.sendButtons(b.org_id, p.phone, {
                        title: b.name, body, footer: b.footer || '', buttons: b.buttons,
                    });
                } else {
                    await whatsapp.showTyping(b.org_id, p.phone, 900).catch(() => {});
                    messageId = await whatsapp.sendMessage(b.org_id, p.phone, body);
                }
                ok = !!messageId;
            } catch (e) {
                ok = false;
            }

            await db.query(
                `UPDATE broadcast_recipients
                    SET status = ?, wa_message_id = ?, body = ?, sent_at = NOW(), error_reason = ?
                  WHERE id = ?`,
                [ok ? 'sent' : 'failed', typeof messageId === 'string' ? messageId : null, body,
                 ok ? null : 'WhatsApp did not accept the message', p.id]);

            await db.query(
                ok ? 'UPDATE broadcasts SET sent_count = sent_count + 1 WHERE id = ?'
                   : 'UPDATE broadcasts SET failed_count = failed_count + 1 WHERE id = ?',
                [broadcastId]);

            if (ok) await db.query('UPDATE contacts SET last_contacted_at = NOW() WHERE id = ?', [p.contact_id]);

            // The same jitter the reminder scheduler uses. A burst of identical
            // messages from one number is what gets that number flagged.
            await sleep(Math.floor(Math.random() * 3000) + 2000);
        }

        const final = await db.one('SELECT status FROM broadcasts WHERE id = ?', [broadcastId]);
        if (final?.status !== 'cancelled') {
            await db.query(
                `UPDATE broadcasts SET status = 'sent', finished_at = NOW(), updated_at = NOW() WHERE id = ?`,
                [broadcastId]);
        }
        const done = await db.one('SELECT name, sent_count, failed_count FROM broadcasts WHERE id = ?', [broadcastId]);
        whatsapp.notifyUser(b.org_id, done.failed_count ? 'warning' : 'success',
            `Broadcast "${done.name}" finished — ${done.sent_count} sent${done.failed_count ? `, ${done.failed_count} failed` : ''}.`);
    } catch (e) {
        console.error('[broadcasts] run failed:', e.message);
        await db.query(
            `UPDATE broadcasts SET status = 'failed', finished_at = NOW(), updated_at = NOW() WHERE id = ?`,
            [broadcastId]).catch(() => {});
    } finally {
        running.delete(broadcastId);
    }
}

/** Called by the scheduler tick. Anything scheduled and due starts now. */
async function processDue() {
    try {
        const due = await db.many(
            `SELECT id FROM broadcasts
              WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
              LIMIT 5`);
        for (const b of due) runBroadcast(b.id);   // deliberately not awaited
    } catch (e) {
        console.error('[broadcasts] due sweep failed:', e.message);
    }
}

/* ── routes ─────────────────────────────────────────────────────────────── */

function router({ authenticateToken, requireRole }) {
    const r = express.Router();
    r.use(express.json({ limit: '512kb' }));
    r.use(authenticateToken);

    /** How many people a filter actually reaches, with a sample to sanity-check it. */
    r.post('/audience', async (req, res) => {
        try {
            const filter = await resolveFilter(req.user.org_id, req.body?.segment_id, req.body?.audience);
            const { where, params } = audienceSql(filter, req.user.org_id);
            const [total, sample, excluded] = await Promise.all([
                db.one(`SELECT COUNT(*)::int AS n FROM contacts c WHERE ${where}`, params),
                db.many(`SELECT c.id, c.name, c.phone FROM contacts c WHERE ${where} ORDER BY lower(c.name) LIMIT 5`, params),
                // Named explicitly, so "why is this 8 and not 12" has an answer.
                db.one(
                    `SELECT COUNT(*) FILTER (WHERE opted_out)::int AS opted_out,
                            COUNT(*) FILTER (WHERE wa_valid = FALSE)::int AS not_on_whatsapp
                       FROM contacts WHERE org_id = ? AND deleted_at IS NULL`, [req.user.org_id]),
            ]);
            res.json({ total: total.n, sample, excluded, filter });
        } catch (e) {
            console.error('[broadcasts] audience failed:', e.message);
            res.status(500).json({ error: 'Could not work out that audience' });
        }
    });

    r.get('/', async (req, res) => {
        try {
            res.json(await db.many(
                `SELECT b.id, b.name, b.status, b.scheduled_at, b.started_at, b.finished_at,
                        b.total_count, b.sent_count, b.failed_count, b.skipped_count,
                        b.created_at, b.body, t.name AS template_name,
                        COALESCE(u.full_name, u.username) AS created_by_name
                   FROM broadcasts b
                   LEFT JOIN templates t ON t.id = b.template_id
                   LEFT JOIN users u ON u.id = b.created_by
                  WHERE b.org_id = ?
                  ORDER BY b.created_at DESC LIMIT 100`,
                [req.user.org_id]));
        } catch (e) {
            res.status(500).json({ error: 'Could not load broadcasts' });
        }
    });

    /** The per-recipient delivery report. */
    r.get('/:id', async (req, res) => {
        try {
            const b = await db.one(
                `SELECT b.*, t.name AS template_name FROM broadcasts b
                   LEFT JOIN templates t ON t.id = b.template_id
                  WHERE b.id = ? AND b.org_id = ?`,
                [req.params.id, req.user.org_id]);
            if (!b) return res.status(404).json({ error: 'Broadcast not found' });

            const recipients = await db.many(
                `SELECT r.status, r.skip_reason, r.error_reason, r.delivery_status, r.sent_at, r.body,
                        c.id AS contact_id, c.name, c.phone
                   FROM broadcast_recipients r JOIN contacts c ON c.id = r.contact_id
                  WHERE r.broadcast_id = ?
                  ORDER BY CASE r.status WHEN 'failed' THEN 0 WHEN 'pending' THEN 1
                                         WHEN 'skipped' THEN 2 ELSE 3 END, lower(c.name)`,
                [b.id]);
            res.json({ broadcast: b, recipients });
        } catch (e) {
            res.status(500).json({ error: 'Could not load that broadcast' });
        }
    });

    r.post('/', requireRole('manager'), async (req, res) => {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'A broadcast needs a name' });

        try {
            // The wording is copied in, not referenced: editing the template
            // later must not rewrite what this broadcast actually sent.
            let body = String(req.body?.body || '').trim();
            let footer = req.body?.footer || null;
            let mediaId = req.body?.media_id || null;
            let buttons = Array.isArray(req.body?.buttons) ? req.body.buttons : [];

            if (req.body?.template_id) {
                const t = await db.one(
                    'SELECT * FROM templates WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
                    [req.body.template_id, req.user.org_id]);
                if (!t) return res.status(400).json({ error: 'That template does not exist' });
                body = body || t.body;
                footer = footer ?? t.footer;
                mediaId = mediaId ?? t.media_id;
                if (!buttons.length) buttons = t.buttons || [];
            }
            if (!body) return res.status(400).json({ error: 'A broadcast needs a message' });

            if (mediaId) {
                const m = await db.one('SELECT id FROM media_attachments WHERE id = ? AND org_id = ?',
                    [mediaId, req.user.org_id]);
                if (!m) return res.status(400).json({ error: 'That attachment does not belong to this workspace' });
            }

            const row = await db.one(
                `INSERT INTO broadcasts
                   (org_id, name, template_id, body, footer, media_id, buttons,
                    segment_id, audience, variables, status, scheduled_at, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
                 RETURNING *`,
                [req.user.org_id, name, req.body?.template_id || null, body, footer, mediaId,
                 JSON.stringify(buttons), req.body?.segment_id || null,
                 JSON.stringify(req.body?.audience || {}), JSON.stringify(req.body?.variables || {}),
                 req.body?.scheduled_at || null, req.user.id]);
            res.json(row);
        } catch (e) {
            console.error('[broadcasts] create failed:', e.message);
            res.status(500).json({ error: 'Could not save that broadcast' });
        }
    });

    /**
     * Send now, or schedule. Either way the audience is frozen into rows first,
     * so the report describes who was actually targeted.
     */
    r.post('/:id/send', requireRole('manager'), async (req, res) => {
        try {
            const b = await db.one('SELECT * FROM broadcasts WHERE id = ? AND org_id = ?',
                [req.params.id, req.user.org_id]);
            if (!b) return res.status(404).json({ error: 'Broadcast not found' });
            // 'failed' is retryable: it means the run never got going (usually
            // an unlinked number), and only pending rows are ever processed, so
            // a retry cannot message anyone twice.
            if (!['draft', 'scheduled', 'failed'].includes(b.status)) {
                return res.status(409).json({ error: `This broadcast is already ${b.status}` });
            }

            // Validated before anything is written: a malformed request should
            // not leave a frozen audience behind.
            const when = req.body?.scheduled_at ? new Date(req.body.scheduled_at) : null;
            if (when && isNaN(when.getTime())) {
                return res.status(400).json({ error: 'That send time is not a valid date' });
            }

            const filter = await resolveFilter(b.org_id, b.segment_id, b.audience);
            const { where, params } = audienceSql(filter, b.org_id);
            const ins = await db.query(
                `INSERT INTO broadcast_recipients (broadcast_id, contact_id)
                 SELECT ?, c.id FROM contacts c WHERE ${where}
                 ON CONFLICT (broadcast_id, contact_id) DO NOTHING`,
                [b.id, ...params]);

            const total = await db.one(
                'SELECT COUNT(*)::int AS n FROM broadcast_recipients WHERE broadcast_id = ?', [b.id]);
            if (!total.n) return res.status(400).json({ error: 'That audience is empty — nobody would be messaged' });

            await db.query(
                `UPDATE broadcasts SET status = 'scheduled', scheduled_at = ?, total_count = ?, updated_at = NOW()
                  WHERE id = ?`,
                [when ? when.toISOString() : new Date().toISOString(), total.n, b.id]);

            // Immediate sends do not wait for the next scheduler tick.
            if (!when || when.getTime() <= Date.now()) runBroadcast(b.id);

            res.json({ success: true, total: total.n, added: ins.rowCount, scheduled_at: when });
        } catch (e) {
            console.error('[broadcasts] send failed:', e.message);
            res.status(500).json({ error: 'Could not start that broadcast' });
        }
    });

    r.post('/:id/cancel', requireRole('manager'), async (req, res) => {
        try {
            const q = await db.query(
                `UPDATE broadcasts SET status = 'cancelled', finished_at = NOW(), updated_at = NOW()
                  WHERE id = ? AND org_id = ? AND status IN ('draft', 'scheduled', 'sending')`,
                [req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(409).json({ error: 'That broadcast cannot be cancelled now' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not cancel that broadcast' });
        }
    });

    r.delete('/:id', requireRole('manager'), async (req, res) => {
        try {
            const q = await db.query(
                "DELETE FROM broadcasts WHERE id = ? AND org_id = ? AND status IN ('draft', 'cancelled', 'failed')",
                [req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(409).json({ error: 'Only a draft or a stopped broadcast can be deleted' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not delete that broadcast' });
        }
    });

    /* ── segments ───────────────────────────────────────────────────────── */
    r.get('/segments/all', async (req, res) => {
        try {
            res.json(await db.many(
                'SELECT id, name, filter, created_at FROM segments WHERE org_id = ? ORDER BY lower(name)',
                [req.user.org_id]));
        } catch (e) { res.status(500).json({ error: 'Could not load segments' }); }
    });

    r.post('/segments', requireRole('manager'), async (req, res) => {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'A segment needs a name' });
        try {
            const row = await db.one(
                `INSERT INTO segments (org_id, name, filter, created_by) VALUES (?, ?, ?, ?)
                 ON CONFLICT (org_id, name) DO UPDATE SET filter = EXCLUDED.filter
                 RETURNING id, name, filter`,
                [req.user.org_id, name, JSON.stringify(req.body?.filter || {}), req.user.id]);
            res.json(row);
        } catch (e) { res.status(500).json({ error: 'Could not save that segment' }); }
    });

    r.delete('/segments/:id', requireRole('manager'), async (req, res) => {
        try {
            await db.query('DELETE FROM segments WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ error: 'Could not delete that segment' }); }
    });

    return r;
}

module.exports = { router, processDue, runBroadcast, audienceSql };
