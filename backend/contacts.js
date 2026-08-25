/**
 * Contacts — the CRM record.
 *
 * A contact used to be a name and a phone number, with an inert table row and
 * no detail view anywhere. The list also fetched EVERY row: the endpoint was
 * called with no page parameter at all, so a clinic with 5,000 patients would
 * have rendered 5,000 rows.
 *
 * This adds pagination, sorting and filtering server-side, plus the things that
 * make a contact a record rather than a phone number: tags, notes, custom
 * fields, and a unified activity timeline.
 */

const express = require('express');
const db = require('./db');

const clean = (p) => String(p || '').replace(/\D/g, '');

const SORTABLE = {
    name: 'lower(c.name)',
    phone: 'c.phone',
    created: 'c.created_at',
    last_contacted: 'c.last_contacted_at',
};

function router({ authenticateToken, requireRole }) {
    const r = express.Router();
    r.use(express.json({ limit: '4mb' }));
    r.use(authenticateToken);

    /* ── list ───────────────────────────────────────────────────────────── */
    r.get('/', async (req, res) => {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
        const offset = (page - 1) * limit;
        const search = (req.query.search || '').trim();
        const sortKey = SORTABLE[req.query.sort] || SORTABLE.name;
        const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

        const where = ['c.org_id = ?', 'c.deleted_at IS NULL'];
        const params = [req.user.org_id];

        if (search) {
            where.push('(c.name ILIKE ? OR c.phone LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }
        if (req.query.opted_out === 'true') where.push('c.opted_out = TRUE');
        if (req.query.opted_out === 'false') where.push('c.opted_out = FALSE');
        if (req.query.invalid === 'true') where.push('c.wa_valid = FALSE');
        if (req.query.tag) {
            where.push('EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.name = ?)');
            params.push(req.query.tag);
        }
        const whereSql = where.join(' AND ');

        try {
            const total = await db.one(`SELECT COUNT(*)::int AS n FROM contacts c WHERE ${whereSql}`, params);
            const rows = await db.many(
                `SELECT c.id, c.name, c.phone, c.email, c.opted_out, c.wa_valid,
                        c.last_contacted_at, c.created_at, c.custom,
                        COALESCE(
                          (SELECT json_agg(json_build_object('id', t.id, 'name', t.name, 'colour', t.colour))
                             FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
                            WHERE ct.contact_id = c.id), '[]'::json) AS tags
                   FROM contacts c
                  WHERE ${whereSql}
                  ORDER BY ${sortKey} ${dir} NULLS LAST
                  LIMIT ? OFFSET ?`,
                [...params, limit, offset]);

            res.json({
                data: rows,
                pagination: { page, limit, total: total.n, totalPages: Math.max(Math.ceil(total.n / limit), 1) },
            });
        } catch (e) {
            console.error('[contacts] list failed:', e.message);
            res.status(500).json({ error: 'Could not load contacts' });
        }
    });

    /* ── export ─────────────────────────────────────────────────────────── */
    r.get('/export', async (req, res) => {
        try {
            const rows = await db.many(
                `SELECT c.name, c.phone, c.email, c.opted_out, c.wa_valid, c.created_at,
                        COALESCE((SELECT string_agg(t.name, '|') FROM contact_tags ct
                                    JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id), '') AS tags
                   FROM contacts c WHERE c.org_id = ? AND c.deleted_at IS NULL
                  ORDER BY lower(c.name)`, [req.user.org_id]);

            // Prefix formula characters — a cell starting = + - @ is executed by
            // Excel and Sheets on open, which is a real vector when the data is
            // a name someone else supplied.
            const esc = (v) => {
                const s = v === null || v === undefined ? '' : String(v);
                const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
                return `"${safe.replace(/"/g, '""')}"`;
            };
            const header = ['Name', 'Phone', 'Email', 'Opted out', 'On WhatsApp', 'Tags', 'Added'];
            const csv = [header.join(',')]
                .concat(rows.map((c) => [c.name, c.phone, c.email,
                    c.opted_out ? 'yes' : 'no',
                    c.wa_valid === null ? 'unknown' : (c.wa_valid ? 'yes' : 'no'),
                    c.tags, c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '',
                ].map(esc).join(',')))
                .join('\r\n');

            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
            res.send('﻿' + csv);   // BOM so Excel reads UTF-8 names correctly
        } catch (e) {
            res.status(500).json({ error: 'Could not export contacts' });
        }
    });

    /* ── one contact, with everything attached ──────────────────────────── */
    r.get('/:id', async (req, res) => {
        try {
            const c = await db.one(
                `SELECT * FROM contacts WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
                [req.params.id, req.user.org_id]);
            if (!c) return res.status(404).json({ error: 'Contact not found' });

            const [tags, notes] = await Promise.all([
                db.many(`SELECT t.id, t.name, t.colour FROM contact_tags ct
                           JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ?`, [c.id]),
                db.many(`SELECT n.id, n.body, n.created_at, u.username AS author
                           FROM contact_notes n LEFT JOIN users u ON u.id = n.author_user_id
                          WHERE n.contact_id = ? ORDER BY n.created_at DESC`, [c.id]),
            ]);
            res.json({ ...c, tags, notes });
        } catch (e) {
            res.status(500).json({ error: 'Could not load that contact' });
        }
    });

    /**
     * Everything that ever happened with this person, in one stream.
     * Previously reconstructable only by reading two tables and joining them
     * mentally.
     */
    r.get('/:id/timeline', async (req, res) => {
        try {
            const c = await db.one('SELECT id, phone FROM contacts WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id]);
            if (!c) return res.status(404).json({ error: 'Contact not found' });

            const rows = await db.many(
                `SELECT 'outbound' AS kind, al.sent_time AS at, al.content AS body,
                        al.status, al.delivery_status, al.response, a.name AS source
                   FROM automation_logs al
                   LEFT JOIN automations a ON a.id = al.automation_id
                  WHERE al.contact_id = ? AND al.status <> 'pending'
                 UNION ALL
                 SELECT 'inbound', im.received_at, im.body, NULL, NULL, im.intent, NULL
                   FROM inbound_messages im WHERE im.contact_id = ?
                 UNION ALL
                 SELECT 'note', n.created_at, n.body, NULL, NULL, NULL, u.username
                   FROM contact_notes n LEFT JOIN users u ON u.id = n.author_user_id
                  WHERE n.contact_id = ?
                 ORDER BY at DESC LIMIT 100`,
                [c.id, c.id, c.id]);
            res.json(rows);
        } catch (e) {
            res.status(500).json({ error: 'Could not load the timeline' });
        }
    });

    /* ── create / update / delete ───────────────────────────────────────── */
    r.post('/', async (req, res) => {
        const { name, phone, email, custom } = req.body || {};
        const digits = clean(phone);
        if (!digits) return res.status(400).json({ error: 'A phone number is required' });
        try {
            const row = await db.one(
                `INSERT INTO contacts (org_id, name, phone, email, custom)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (org_id, phone) DO NOTHING
                 RETURNING id`,
                [req.user.org_id, name || null, digits, email || null, JSON.stringify(custom || {})]);
            if (!row) return res.status(409).json({ error: 'That number is already in your contacts' });
            res.status(201).json({ id: row.id });
        } catch (e) {
            res.status(500).json({ error: 'Could not save the contact' });
        }
    });

    r.put('/:id', async (req, res) => {
        const { name, phone, email, custom } = req.body || {};
        try {
            const result = await db.query(
                `UPDATE contacts SET name = ?, phone = COALESCE(?, phone), email = ?,
                        custom = COALESCE(?, custom)
                  WHERE id = ? AND org_id = ?`,
                [name || null, phone ? clean(phone) : null, email || null,
                 custom ? JSON.stringify(custom) : null, req.params.id, req.user.org_id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Contact not found' });
            res.json({ success: true });
        } catch (e) {
            if (String(e.message).includes('contacts_org_id_phone_key')) {
                return res.status(409).json({ error: 'Another contact already has that number' });
            }
            res.status(500).json({ error: 'Could not update the contact' });
        }
    });

    // Soft delete: hard deletes used to orphan the person's message history,
    // because SQLite never enforced the foreign keys that would have stopped it.
    r.delete('/:id', async (req, res) => {
        try {
            const result = await db.query(
                'UPDATE contacts SET deleted_at = NOW() WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
                [req.params.id, req.user.org_id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Contact not found' });
            await db.query(`UPDATE automation_logs SET status = 'cancelled', error_reason = 'Contact removed'
                             WHERE contact_id = ? AND status = 'pending'`, [req.params.id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not delete the contact' });
        }
    });

    /* ── notes ──────────────────────────────────────────────────────────── */
    r.post('/:id/notes', async (req, res) => {
        const body = String(req.body?.body || '').trim();
        if (!body) return res.status(400).json({ error: 'A note cannot be empty' });
        try {
            const owned = await db.one('SELECT id FROM contacts WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id]);
            if (!owned) return res.status(404).json({ error: 'Contact not found' });
            const row = await db.one(
                `INSERT INTO contact_notes (org_id, contact_id, author_user_id, body)
                 VALUES (?, ?, ?, ?) RETURNING id, created_at`,
                [req.user.org_id, req.params.id, req.user.id, body]);
            res.status(201).json(row);
        } catch (e) {
            res.status(500).json({ error: 'Could not save the note' });
        }
    });

    r.delete('/:id/notes/:noteId', async (req, res) => {
        try {
            const result = await db.query('DELETE FROM contact_notes WHERE id = ? AND contact_id = ? AND org_id = ?',
                [req.params.noteId, req.params.id, req.user.org_id]);
            if (!result.rowCount) return res.status(404).json({ error: 'Note not found' });
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Could not delete the note' }); }
    });

    /* ── tags on a contact ──────────────────────────────────────────────── */
    r.put('/:id/tags', async (req, res) => {
        const tagIds = Array.isArray(req.body?.tag_ids) ? req.body.tag_ids : [];
        try {
            await db.tx(async (t) => {
                const owned = await t.one('SELECT id FROM contacts WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id]);
                if (!owned) throw new Error('not-found');
                await t.query('DELETE FROM contact_tags WHERE contact_id = ?', [req.params.id]);
                for (const tid of tagIds) {
                    // Scoped insert: a tag id from another org simply matches nothing.
                    await t.query(
                        `INSERT INTO contact_tags (contact_id, tag_id)
                         SELECT ?, id FROM tags WHERE id = ? AND org_id = ?
                         ON CONFLICT DO NOTHING`,
                        [req.params.id, tid, req.user.org_id]);
                }
            });
            res.json({ success: true });
        } catch (e) {
            if (e.message === 'not-found') return res.status(404).json({ error: 'Contact not found' });
            res.status(500).json({ error: 'Could not update tags' });
        }
    });

    /* ── bulk ───────────────────────────────────────────────────────────── */
    r.post('/bulk-action', async (req, res) => {
        const { ids, action, tag_id } = req.body || {};
        if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No contacts selected' });
        if (ids.length > 1000) return res.status(400).json({ error: 'Too many contacts in one action (max 1000)' });

        try {
            let affected = 0;
            if (action === 'opt_out' || action === 'opt_in') {
                const out = action === 'opt_out';
                const q = await db.query(
                    `UPDATE contacts SET opted_out = ?, opted_out_at = CASE WHEN ? THEN NOW() ELSE NULL END
                      WHERE id = ANY(?::uuid[]) AND org_id = ?`, [out, out, ids, req.user.org_id]);
                affected = q.rowCount;
                if (out) {
                    await db.query(`UPDATE automation_logs SET status = 'cancelled', error_reason = 'Contact opted out'
                                     WHERE contact_id = ANY(?::uuid[]) AND status = 'pending'`, [ids]);
                }
            } else if (action === 'delete') {
                const q = await db.query('UPDATE contacts SET deleted_at = NOW() WHERE id = ANY(?::uuid[]) AND org_id = ? AND deleted_at IS NULL',
                    [ids, req.user.org_id]);
                affected = q.rowCount;
            } else if (action === 'tag' && tag_id) {
                const q = await db.query(
                    `INSERT INTO contact_tags (contact_id, tag_id)
                     SELECT c.id, t.id FROM contacts c, tags t
                      WHERE c.id = ANY(?::uuid[]) AND c.org_id = ? AND t.id = ? AND t.org_id = ?
                     ON CONFLICT DO NOTHING`, [ids, req.user.org_id, tag_id, req.user.org_id]);
                affected = q.rowCount;
            } else if (action === 'untag' && tag_id) {
                const q = await db.query('DELETE FROM contact_tags WHERE contact_id = ANY(?::uuid[]) AND tag_id = ?', [ids, tag_id]);
                affected = q.rowCount;
            } else {
                return res.status(400).json({ error: 'Unknown action' });
            }
            res.json({ success: true, affected });
        } catch (e) {
            console.error('[contacts] bulk failed:', e.message);
            res.status(500).json({ error: 'Bulk action failed' });
        }
    });

    /** Import with a real per-row report, rather than just {added, skipped}. */
    r.post('/import', async (req, res) => {
        const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
        if (!rows.length) return res.status(400).json({ error: 'Nothing to import' });
        if (rows.length > 5000) return res.status(400).json({ error: 'Too many rows in one import (max 5000)' });

        const report = { added: 0, updated: 0, skipped: 0, invalid: [] };
        try {
            for (const [i, row] of rows.entries()) {
                const digits = clean(row.phone);
                if (!digits || digits.length < 8) {
                    report.invalid.push({ line: i + 1, phone: row.phone || '', reason: 'Not a usable number' });
                    report.skipped++;
                    continue;
                }
                const out = await db.one(
                    `INSERT INTO contacts (org_id, name, phone, email)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT (org_id, phone) DO UPDATE
                       SET name = COALESCE(EXCLUDED.name, contacts.name)
                     RETURNING (xmax = 0) AS inserted`,
                    [req.user.org_id, row.name || null, digits, row.email || null]);
                if (out?.inserted) report.added++; else report.updated++;
            }
            res.json(report);
        } catch (e) {
            console.error('[contacts] import failed:', e.message);
            res.status(500).json({ error: 'Import failed', report });
        }
    });

    return r;
}

module.exports = { router };
