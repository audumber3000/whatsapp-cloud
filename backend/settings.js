/**
 * Workspace settings.
 *
 * Everything a clinic can configure, in one place. Before this, the only
 * settings that existed were a notification email and a WhatsApp number on a
 * single inline tab — there was no way to name your own workspace, set your
 * hours, invite a colleague, see who changed what, or hold more than one API
 * key even though the schema always allowed several.
 *
 * Every mutation writes an audit row. That is the point of the audit log: it
 * is only useful if nothing can change without it.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const publicApi = require('./publicApi');
const whatsapp = require('./whatsapp');
const email = require('./email');
const notify = require('./notify');

/* ── audit ──────────────────────────────────────────────────────────────── */

/**
 * Never throws and never blocks the response: a settings change that succeeded
 * must not report failure because the audit insert did. Failures are logged
 * loudly instead, because a silent gap in an audit trail is worse than noise.
 */
function audit(req, action, entityType, entityId, before, after) {
    db.run(
        `INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id, before, after, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.org_id, req.user.id, action, entityType, entityId || null,
         before ? JSON.stringify(before) : null,
         after ? JSON.stringify(after) : null,
         req.ip || req.headers['x-forwarded-for'] || null,
         String(req.headers['user-agent'] || '').slice(0, 300)],
        (e) => { if (e) console.error('[audit] write failed:', action, e.message); });
}

/** Redact anything that must not be readable from the audit log later. */
const SECRET_KEYS = /password|secret|token|key_hash|api_key/i;
const scrub = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
    return out;
};

/* ── business hours ─────────────────────────────────────────────────────── */

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** { mon: { open: '09:30', close: '19:00' } | null, … } — null means closed. */
function cleanHours(input) {
    const out = {};
    for (const d of DAYS) {
        const v = input?.[d];
        if (!v || !v.open || !v.close) { out[d] = null; continue; }
        if (!TIME_RE.test(v.open) || !TIME_RE.test(v.close)) { out[d] = null; continue; }
        // A close before an open is a typo, not an overnight shift — clinics
        // do not run past midnight, and silently accepting it would make the
        // away-message window inside-out.
        if (v.close <= v.open) { out[d] = null; continue; }
        out[d] = { open: v.open, close: v.close };
    }
    return out;
}

// The list and the defaults both live in notify.js, which is what actually
// decides whether an alert goes out. Duplicating them here is how the page
// ends up showing a state the sender does not agree with.
const NOTIFY_EVENTS = Object.keys(notify.DEFAULTS);

/**
 * Reading and writing are deliberately different.
 *
 * On READ, an event the workspace has never saved falls back to its default —
 * otherwise the page shows every switch off while the system is still sending,
 * which is worse than no page at all. On WRITE every event is stored
 * explicitly, so a deliberate "off" is never re-defaulted back on.
 */
function cleanEvents(input, { applyDefaults = false } = {}) {
    const out = {};
    for (const e of NOTIFY_EVENTS) {
        const saved = input?.[e];
        const base = applyDefaults && !saved ? notify.DEFAULTS[e] : saved;
        out[e] = { email: !!base?.email, whatsapp: !!base?.whatsapp };
    }
    return out;
}

/* ── router ─────────────────────────────────────────────────────────────── */

function router({ authenticateToken, requireRole }) {
    const r = express.Router();
    r.use(express.json({ limit: '2mb' }));   // logo data-URIs
    r.use(authenticateToken);

    /* ---- workspace ---- */
    r.get('/workspace', async (req, res) => {
        try {
            const o = await db.one(
                `SELECT id, name, slug, timezone, locale, business_hours, plan, logo_url,
                        away_message, away_enabled, created_at
                   FROM organisations WHERE id = ?`, [req.user.org_id]);
            if (!o) return res.status(404).json({ error: 'Workspace not found' });
            res.json({ ...o, business_hours: o.business_hours || {} });
        } catch (e) {
            res.status(500).json({ error: 'Could not load the workspace' });
        }
    });

    r.put('/workspace', requireRole('manager'), async (req, res) => {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'A workspace needs a name' });
        if (name.length > 80) return res.status(400).json({ error: 'That name is too long (max 80 characters)' });

        const logo = req.body?.logo_url || null;
        // A logo arrives as a data-URI and is stored inline. Anything else would
        // be a URL we fetch, and an SVG would be script we serve from our own
        // origin — both are how a settings field becomes stored XSS.
        if (logo && !/^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
            return res.status(400).json({ error: 'A logo must be a PNG, JPEG or WebP image' });
        }
        if (logo && logo.length > 400_000) {
            return res.status(400).json({ error: 'That logo is too large (max ~300KB)' });
        }

        try {
            const before = await db.one(
                'SELECT name, timezone, locale, business_hours, away_message, away_enabled FROM organisations WHERE id = ?',
                [req.user.org_id]);

            const after = await db.one(
                `UPDATE organisations
                    SET name = ?, timezone = ?, locale = ?, business_hours = ?,
                        logo_url = COALESCE(?, logo_url),
                        away_message = ?, away_enabled = ?, updated_at = NOW()
                  WHERE id = ?
                  RETURNING id, name, slug, timezone, locale, business_hours, plan, logo_url,
                            away_message, away_enabled`,
                [name,
                 String(req.body?.timezone || 'Asia/Kolkata').slice(0, 64),
                 String(req.body?.locale || 'en-IN').slice(0, 16),
                 JSON.stringify(cleanHours(req.body?.business_hours)),
                 logo,
                 String(req.body?.away_message || '').trim().slice(0, 1000) || null,
                 !!req.body?.away_enabled,
                 req.user.org_id]);

            audit(req, 'workspace.update', 'organisation', req.user.org_id, before, {
                ...after, logo_url: after.logo_url ? '[image]' : null,
            });
            res.json(after);
        } catch (e) {
            console.error('[settings] workspace update failed:', e.message);
            res.status(500).json({ error: 'Could not save the workspace' });
        }
    });

    /* ---- members ---- */
    r.get('/members', async (req, res) => {
        try {
            const [members, invitations] = await Promise.all([
                db.many(
                    `SELECT u.id, u.username, u.full_name, u.email, u.avatar_url, u.last_login_at,
                            m.role, m.status, m.created_at AS joined_at
                       FROM memberships m JOIN users u ON u.id = m.user_id
                      WHERE m.org_id = ? AND u.deleted_at IS NULL
                      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
                               lower(COALESCE(u.full_name, u.username))`,
                    [req.user.org_id]),
                db.many(
                    `SELECT i.id, i.email, i.role, i.expires_at, i.created_at,
                            COALESCE(u.full_name, u.username) AS invited_by_name
                       FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
                      WHERE i.org_id = ? AND i.accepted_at IS NULL AND i.expires_at > NOW()
                      ORDER BY i.created_at DESC`,
                    [req.user.org_id]),
            ]);
            res.json({ members, invitations, me: req.user.id });
        } catch (e) {
            console.error('[settings] members failed:', e.message);
            res.status(500).json({ error: 'Could not load the team' });
        }
    });

    r.post('/invitations', requireRole('manager'), async (req, res) => {
        const addr = String(req.body?.email || '').trim().toLowerCase();
        const role = ['manager', 'agent'].includes(req.body?.role) ? req.body.role : 'agent';
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
            return res.status(400).json({ error: 'That does not look like an email address' });
        }
        // Only an owner can hand out ownership, and only by transfer — so the
        // invite form cannot mint a second owner.
        try {
            const existing = await db.one(
                `SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.org_id = ? AND lower(u.email) = ?`, [req.user.org_id, addr]);
            if (existing) return res.status(409).json({ error: 'They are already in this workspace' });

            // The raw token is emailed and never stored; only its hash is kept,
            // so a database read cannot be turned into an account.
            const token = crypto.randomBytes(32).toString('base64url');
            const hash = crypto.createHash('sha256').update(token).digest('hex');

            const inv = await db.one(
                `INSERT INTO invitations (org_id, email, role, token_hash, invited_by, expires_at)
                 VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL '7 days')
                 RETURNING id, email, role, expires_at, created_at`,
                [req.user.org_id, addr, role, hash, req.user.id]);

            const org = await db.one('SELECT name FROM organisations WHERE id = ?', [req.user.org_id]);
            const base = (process.env.WAREACH_PUBLIC_URL || '').replace(/\/$/, '');
            const link = `${base}/invite/${token}`;

            let delivered = true;
            try {
                await email.sendEmail(
                    addr,
                    `You have been invited to ${org?.name || 'WA Reach'}`,
                    `You have been invited to join ${org?.name || 'a workspace'} on WA Reach as a ${role}.\n\n`
                    + `Accept here (the link expires in 7 days):\n${link}\n`);
            } catch (e) {
                // The invitation still exists and the link still works, so say
                // so rather than pretending the whole thing failed.
                delivered = false;
                console.error('[settings] invite email failed:', e.message);
            }

            audit(req, 'member.invite', 'invitation', inv.id, null, { email: addr, role });
            res.json({ ...inv, delivered, link: delivered ? undefined : link });
        } catch (e) {
            console.error('[settings] invite failed:', e.message);
            res.status(500).json({ error: 'Could not send that invitation' });
        }
    });

    r.delete('/invitations/:id', requireRole('manager'), async (req, res) => {
        try {
            const q = await db.query('DELETE FROM invitations WHERE id = ? AND org_id = ? AND accepted_at IS NULL',
                [req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(404).json({ error: 'Invitation not found' });
            audit(req, 'member.invite_revoked', 'invitation', req.params.id, null, null);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not revoke that invitation' });
        }
    });

    r.patch('/members/:userId', requireRole('manager'), async (req, res) => {
        const role = req.body?.role;
        if (!['owner', 'manager', 'agent'].includes(role)) {
            return res.status(400).json({ error: 'Unknown role' });
        }
        if (role === 'owner' && req.user.role !== 'owner') {
            return res.status(403).json({ error: 'Only the owner can hand over ownership' });
        }
        try {
            const target = await db.one(
                'SELECT role FROM memberships WHERE org_id = ? AND user_id = ?',
                [req.user.org_id, req.params.userId]);
            if (!target) return res.status(404).json({ error: 'They are not in this workspace' });

            // A workspace with no owner cannot be administered by anyone, so the
            // last one cannot demote themselves out of the role.
            if (target.role === 'owner' && role !== 'owner') {
                const owners = await db.one(
                    "SELECT COUNT(*)::int AS n FROM memberships WHERE org_id = ? AND role = 'owner'",
                    [req.user.org_id]);
                if (owners.n <= 1) {
                    return res.status(409).json({ error: 'Make someone else an owner first — a workspace needs one' });
                }
            }

            await db.query('UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?',
                [role, req.user.org_id, req.params.userId]);
            // Handing over ownership steps the previous owner down, rather than
            // leaving two owners by accident.
            if (role === 'owner' && req.params.userId !== req.user.id) {
                await db.query("UPDATE memberships SET role = 'manager' WHERE org_id = ? AND user_id = ?",
                    [req.user.org_id, req.user.id]);
            }
            // The role lives in the access token, so without this a demotion
            // leaves the old privileges live until that token expires — hours,
            // in practice. Revoking their sessions forces the new role to be
            // picked up on the next request.
            await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
                [req.params.userId]).catch(() => {});

            audit(req, 'member.role_change', 'user', req.params.userId, { role: target.role }, { role });
            res.json({ success: true, signedOut: true });
        } catch (e) {
            console.error('[settings] role change failed:', e.message);
            res.status(500).json({ error: 'Could not change that role' });
        }
    });

    r.delete('/members/:userId', requireRole('manager'), async (req, res) => {
        if (req.params.userId === req.user.id) {
            return res.status(400).json({ error: 'You cannot remove yourself' });
        }
        try {
            const target = await db.one('SELECT role FROM memberships WHERE org_id = ? AND user_id = ?',
                [req.user.org_id, req.params.userId]);
            if (!target) return res.status(404).json({ error: 'They are not in this workspace' });
            if (target.role === 'owner') return res.status(403).json({ error: 'The owner cannot be removed' });

            await db.query('DELETE FROM memberships WHERE org_id = ? AND user_id = ?',
                [req.user.org_id, req.params.userId]);
            // Their sessions die with their access, not at the next expiry.
            await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL',
                [req.params.userId]).catch(() => {});
            // Work they owned goes back to the queue rather than disappearing.
            await db.query('UPDATE conversations SET assignee_id = NULL WHERE org_id = ? AND assignee_id = ?',
                [req.user.org_id, req.params.userId]).catch(() => {});

            audit(req, 'member.remove', 'user', req.params.userId, { role: target.role }, null);
            res.json({ success: true });
        } catch (e) {
            console.error('[settings] member removal failed:', e.message);
            res.status(500).json({ error: 'Could not remove them' });
        }
    });

    /* ---- notifications ---- */
    r.get('/notifications', async (req, res) => {
        try {
            const o = await db.one(
                'SELECT notify_emails, notify_whatsapp, notify_events FROM organisations WHERE id = ?',
                [req.user.org_id]);
            res.json({
                emails: o?.notify_emails || '',
                whatsapp: o?.notify_whatsapp || '',
                events: cleanEvents(o?.notify_events, { applyDefaults: true }),
                available: NOTIFY_EVENTS,
            });
        } catch (e) {
            res.status(500).json({ error: 'Could not load notification settings' });
        }
    });

    r.put('/notifications', requireRole('manager'), async (req, res) => {
        try {
            const before = await db.one(
                'SELECT notify_emails, notify_whatsapp, notify_events FROM organisations WHERE id = ?',
                [req.user.org_id]);
            const events = cleanEvents(req.body?.events);
            await db.query(
                `UPDATE organisations SET notify_emails = ?, notify_whatsapp = ?, notify_events = ?, updated_at = NOW()
                  WHERE id = ?`,
                [String(req.body?.emails || '').trim().slice(0, 500),
                 String(req.body?.whatsapp || '').replace(/[^\d,]/g, '').slice(0, 200),
                 JSON.stringify(events), req.user.org_id]);
            audit(req, 'notifications.update', 'organisation', req.user.org_id, before, { events });
            res.json({ success: true, events });
        } catch (e) {
            res.status(500).json({ error: 'Could not save notification settings' });
        }
    });

    /* ---- API keys ---- */
    r.get('/api-keys', async (req, res) => {
        try {
            res.json(await db.many(
                `SELECT k.id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at,
                        COALESCE(u.full_name, u.username) AS created_by_name,
                        (SELECT COUNT(*)::int FROM automation_logs al
                          WHERE al.org_id = k.org_id AND al.automation_id IS NULL AND al.sent_by IS NULL
                            AND al.created_at >= NOW() - INTERVAL '30 days') AS sends_30d
                   FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
                  WHERE k.org_id = ?
                  ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`,
                [req.user.org_id]));
        } catch (e) {
            res.status(500).json({ error: 'Could not load API keys' });
        }
    });

    r.post('/api-keys', requireRole('manager'), async (req, res) => {
        const name = String(req.body?.name || '').trim().slice(0, 60) || 'Untitled key';
        try {
            const live = await db.one(
                'SELECT COUNT(*)::int AS n FROM api_keys WHERE org_id = ? AND revoked_at IS NULL',
                [req.user.org_id]);
            if (live.n >= 10) return res.status(409).json({ error: 'You already have 10 active keys' });

            const key = await publicApi.issueKey(req.user.org_id, { name, createdBy: req.user.id });
            audit(req, 'apikey.create', 'api_key', null, null, { name });
            // The raw key is returned exactly once. After this only its hash
            // exists, so it genuinely cannot be recovered.
            res.json({ api_key: key, name });
        } catch (e) {
            console.error('[settings] key issue failed:', e.message);
            res.status(500).json({ error: 'Could not create that key' });
        }
    });

    r.delete('/api-keys/:id', requireRole('manager'), async (req, res) => {
        try {
            const q = await db.query(
                'UPDATE api_keys SET revoked_at = NOW() WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
                [req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(404).json({ error: 'Key not found, or already revoked' });
            audit(req, 'apikey.revoke', 'api_key', req.params.id, null, null);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not revoke that key' });
        }
    });

    /* ---- WhatsApp connection ---- */
    r.get('/whatsapp', async (req, res) => {
        try {
            const status = whatsapp.getStatus(req.user.org_id);
            const [alerts, lastSend] = await Promise.all([
                db.many(
                    `SELECT kind, detail, created_at FROM health_alerts
                      WHERE org_id = ? ORDER BY created_at DESC LIMIT 20`, [req.user.org_id]),
                db.one(
                    `SELECT MAX(sent_time) AS at FROM automation_logs
                      WHERE org_id = ? AND status IN ('sent','delivered','read')`, [req.user.org_id]),
            ]);
            res.json({
                connected: status.isConnected,
                phone: status.phone,
                lastSendAt: lastSend?.at || null,
                alerts,
            });
        } catch (e) {
            res.status(500).json({ error: 'Could not load the connection status' });
        }
    });

    /* ---- audit log ---- */
    r.get('/audit', requireRole('manager'), async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        try {
            const [total, rows] = await Promise.all([
                db.one('SELECT COUNT(*)::int AS n FROM audit_log WHERE org_id = ?', [req.user.org_id]),
                db.many(
                    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.before, a.after,
                            a.ip, a.created_at,
                            COALESCE(u.full_name, u.username, 'System') AS actor
                       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
                      WHERE a.org_id = ?
                      ORDER BY a.created_at DESC
                      LIMIT ? OFFSET ?`,
                    [req.user.org_id, limit, (page - 1) * limit]),
            ]);
            res.json({
                data: rows.map((x) => ({ ...x, before: scrub(x.before), after: scrub(x.after) })),
                pagination: { page, limit, total: total.n, totalPages: Math.max(Math.ceil(total.n / limit), 1) },
            });
        } catch (e) {
            console.error('[settings] audit failed:', e.message);
            res.status(500).json({ error: 'Could not load the audit log' });
        }
    });

    /* ---- billing ---- */
    r.get('/billing', async (req, res) => {
        try {
            const [org, usage] = await Promise.all([
                db.one('SELECT plan, created_at FROM organisations WHERE id = ?', [req.user.org_id]),
                db.one(
                    `SELECT (SELECT COUNT(*)::int FROM contacts WHERE org_id = ? AND deleted_at IS NULL) AS contacts,
                            (SELECT COUNT(*)::int FROM automation_logs
                              WHERE org_id = ? AND created_at >= date_trunc('month', NOW())
                                AND status IN ('sent','delivered','read')) AS sends_this_month,
                            (SELECT COUNT(*)::int FROM memberships WHERE org_id = ?) AS members,
                            (SELECT COUNT(*)::int FROM automations
                              WHERE org_id = ? AND deleted_at IS NULL) AS automations`,
                    [req.user.org_id, req.user.org_id, req.user.org_id, req.user.org_id]),
            ]);
            // Limits are described, not enforced: billing is not wired, and a
            // number the product silently ignores is worse than none.
            res.json({ plan: org?.plan || 'free', since: org?.created_at, usage, enforced: false });
        } catch (e) {
            res.status(500).json({ error: 'Could not load billing' });
        }
    });

    return r;
}

/* ── invitation acceptance (unauthenticated) ────────────────────────────── */

/**
 * Mounted outside the authenticated router: the whole point is that the person
 * accepting does not have an account in this workspace yet.
 */
function acceptRouter({ throttleAuth, issueSession }) {
    const r = express.Router();
    r.use(express.json({ limit: '64kb' }));

    /** What the invite is for, so the accept screen can name the workspace. */
    r.get('/:token', throttleAuth, async (req, res) => {
        try {
            const hash = crypto.createHash('sha256').update(String(req.params.token)).digest('hex');
            const inv = await db.one(
                `SELECT i.email, i.role, i.expires_at, o.name AS org_name
                   FROM invitations i JOIN organisations o ON o.id = i.org_id
                  WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > NOW()`,
                [hash]);
            if (!inv) return res.status(404).json({ error: 'That invitation has expired or already been used' });
            res.json(inv);
        } catch (e) {
            res.status(500).json({ error: 'Could not read that invitation' });
        }
    });

    return r;
}

module.exports = { router, acceptRouter, audit, cleanHours, NOTIFY_EVENTS };
