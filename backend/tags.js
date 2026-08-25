/**
 * Tags and custom fields — the org-level configuration a contact record needs.
 *
 * Audience selection was previously a comma-separated list of phone numbers
 * pasted into a textarea, which meant every automation carried its own private
 * copy of "who". Tags make that a property of the contact instead.
 */

const express = require('express');
const db = require('./db');

function router({ authenticateToken, requireRole }) {
    const r = express.Router();
    r.use(express.json({ limit: '256kb' }));
    // Deliberately NOT r.use(authenticateToken): this router is mounted at
    // /api, so a blanket guard here would also gate /api/login and /api/signup.

    // ── tags ────────────────────────────────────────────────────────────────
    r.get('/tags', authenticateToken, async (req, res) => {
        try {
            res.json(await db.many(
                `SELECT t.id, t.name, t.colour,
                        (SELECT COUNT(*)::int FROM contact_tags ct
                          JOIN contacts c ON c.id = ct.contact_id
                         WHERE ct.tag_id = t.id AND c.deleted_at IS NULL) AS contact_count
                   FROM tags t WHERE t.org_id = ? ORDER BY lower(t.name)`, [req.user.org_id]));
        } catch { res.status(500).json({ error: 'Could not load tags' }); }
    });

    r.post('/tags', authenticateToken, requireRole('manager'), async (req, res) => {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'A tag needs a name' });
        try {
            const row = await db.one(
                `INSERT INTO tags (org_id, name, colour) VALUES (?, ?, ?)
                 ON CONFLICT (org_id, name) DO NOTHING RETURNING id, name, colour`,
                [req.user.org_id, name, req.body?.colour || '#00A884']);
            if (!row) return res.status(409).json({ error: 'That tag already exists' });
            res.status(201).json(row);
        } catch { res.status(500).json({ error: 'Could not create the tag' }); }
    });

    r.put('/tags/:id', authenticateToken, requireRole('manager'), async (req, res) => {
        try {
            const q = await db.query('UPDATE tags SET name = COALESCE(?, name), colour = COALESCE(?, colour) WHERE id = ? AND org_id = ?',
                [req.body?.name || null, req.body?.colour || null, req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(404).json({ error: 'Tag not found' });
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Could not update the tag' }); }
    });

    // contact_tags cascades, so the tag simply detaches from everyone.
    r.delete('/tags/:id', authenticateToken, requireRole('manager'), async (req, res) => {
        try {
            const q = await db.query('DELETE FROM tags WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(404).json({ error: 'Tag not found' });
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Could not delete the tag' }); }
    });

    // ── custom fields ───────────────────────────────────────────────────────
    r.get('/custom-fields', authenticateToken, async (req, res) => {
        try {
            res.json(await db.many(
                'SELECT id, key, label, type, options, position FROM custom_fields WHERE org_id = ? ORDER BY position, label',
                [req.user.org_id]));
        } catch { res.status(500).json({ error: 'Could not load fields' }); }
    });

    r.post('/custom-fields', authenticateToken, requireRole('manager'), async (req, res) => {
        const label = String(req.body?.label || '').trim();
        // The key is what lives in contacts.custom, so it must be stable and
        // safe to use as a JSON property name.
        const key = String(req.body?.key || label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!label || !key) return res.status(400).json({ error: 'A field needs a label' });
        const type = ['text', 'number', 'date', 'select'].includes(req.body?.type) ? req.body.type : 'text';
        try {
            const row = await db.one(
                `INSERT INTO custom_fields (org_id, key, label, type, options, position)
                 VALUES (?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM custom_fields WHERE org_id = ?), 0))
                 ON CONFLICT (org_id, key) DO NOTHING
                 RETURNING id, key, label, type, options, position`,
                [req.user.org_id, key, label, type,
                 req.body?.options ? JSON.stringify(req.body.options) : null, req.user.org_id]);
            if (!row) return res.status(409).json({ error: 'A field with that key already exists' });
            res.status(201).json(row);
        } catch { res.status(500).json({ error: 'Could not create the field' }); }
    });

    r.delete('/custom-fields/:id', authenticateToken, requireRole('manager'), async (req, res) => {
        try {
            const q = await db.query('DELETE FROM custom_fields WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(404).json({ error: 'Field not found' });
            // The definition is gone; values already stored on contacts.custom
            // are left alone rather than silently rewriting every row.
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Could not delete the field' }); }
    });

    return r;
}

module.exports = { router };
