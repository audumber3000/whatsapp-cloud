/**
 * Templates — message wording, named once and rendered anywhere.
 *
 * Until now the only place a message could live was inline in
 * `automations.message_template`, so the same reminder text was retyped for
 * every automation and nothing else could reuse it. A template is that wording
 * lifted out: automations, broadcasts and the inbox all render through
 * `render()` below, which is the single place variable substitution happens.
 */

const express = require('express');
const db = require('./db');

/** `{{ name }}`, `{{clinic}}` — whitespace-tolerant, case-insensitive. */
const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Which placeholders a body actually uses, in first-appearance order. */
function variablesIn(body) {
    const seen = [];
    for (const m of String(body || '').matchAll(VAR_RE)) {
        const key = m[1].toLowerCase();
        if (!seen.includes(key)) seen.push(key);
    }
    return seen;
}

/**
 * Substitute placeholders for one contact.
 *
 * Precedence: an explicitly supplied value beats a contact field, which beats
 * a custom field. An unknown placeholder is left standing rather than replaced
 * with an empty string — a message that reads "Hi {{first_name}}" is a visible
 * mistake, while "Hi ," looks like a bug the clinic sent to a patient.
 */
function render(body, contact = {}, extra = {}) {
    const custom = contact.custom && typeof contact.custom === 'object' ? contact.custom : {};
    const supplied = {};
    for (const [k, v] of Object.entries(extra || {})) supplied[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(custom)) {
        if (supplied[k.toLowerCase()] === undefined) supplied[k.toLowerCase()] = v;
    }

    const builtin = {
        name: contact.name || '',
        first_name: String(contact.name || '').trim().split(/\s+/)[0] || '',
        phone: contact.phone ? `+${contact.phone}` : '',
        email: contact.email || '',
    };

    return String(body || '').replace(VAR_RE, (whole, rawKey) => {
        const key = rawKey.toLowerCase();
        const value = supplied[key] !== undefined && supplied[key] !== null && supplied[key] !== ''
            ? supplied[key]
            : builtin[key];
        // A blank built-in (an unnamed contact) still resolves — to nothing —
        // because that placeholder was understood. Only unknown keys survive.
        if (value !== undefined && value !== null) return String(value);
        return whole;
    });
}

/** Placeholders that will not resolve for this contact — shown before sending. */
function unresolved(body, contact = {}, extra = {}) {
    const out = render(body, contact, extra);
    return variablesIn(out);
}

function router({ authenticateToken, requireRole }) {
    const r = express.Router();
    r.use(express.json({ limit: '512kb' }));
    r.use(authenticateToken);

    const clean = (req) => {
        const name = String(req.body?.name || '').trim();
        const body = String(req.body?.body || '').trim();
        const category = ['utility', 'marketing', 'service'].includes(req.body?.category)
            ? req.body.category : 'utility';
        const footer = String(req.body?.footer || '').trim() || null;
        const buttons = Array.isArray(req.body?.buttons)
            // WhatsApp caps interactive replies at three.
            ? req.body.buttons.slice(0, 3)
                .map((b, i) => ({
                    id: String(b?.id || `btn_${i + 1}`).slice(0, 32),
                    text: String(b?.text || '').trim().slice(0, 20),
                }))
                .filter((b) => b.text)
            : [];
        return { name, body, category, footer, buttons, media_id: req.body?.media_id || null };
    };

    /** A template's media must belong to the same org as the template. */
    const ownsMedia = async (mediaId, orgId) => {
        if (!mediaId) return true;
        const m = await db.one('SELECT id FROM media_attachments WHERE id = ? AND org_id = ?', [mediaId, orgId]);
        return !!m;
    };

    r.get('/', async (req, res) => {
        try {
            const rows = await db.many(
                `SELECT t.id, t.name, t.category, t.body, t.footer, t.buttons, t.media_id,
                        t.use_count, t.created_at, t.updated_at,
                        m.original_name AS media_name, m.mimetype AS media_type
                   FROM templates t
                   LEFT JOIN media_attachments m ON m.id = t.media_id
                  WHERE t.org_id = ? AND t.deleted_at IS NULL
                  ORDER BY lower(t.name)`,
                [req.user.org_id]);
            res.json(rows.map((t) => ({ ...t, variables: variablesIn(t.body) })));
        } catch (e) {
            console.error('[templates] list failed:', e.message);
            res.status(500).json({ error: 'Could not load templates' });
        }
    });

    r.post('/', requireRole('manager'), async (req, res) => {
        const t = clean(req);
        if (!t.name) return res.status(400).json({ error: 'A template needs a name' });
        if (!t.body) return res.status(400).json({ error: 'A template needs a message' });
        if (t.body.length > 4096) return res.status(400).json({ error: 'Message is too long (max 4096 characters)' });
        if (!await ownsMedia(t.media_id, req.user.org_id)) {
            return res.status(400).json({ error: 'That attachment does not belong to this workspace' });
        }
        try {
            const row = await db.one(
                `INSERT INTO templates (org_id, name, category, body, footer, media_id, buttons, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 RETURNING id, name, category, body, footer, media_id, buttons, use_count`,
                [req.user.org_id, t.name, t.category, t.body, t.footer, t.media_id,
                 JSON.stringify(t.buttons), req.user.id]);
            res.json({ ...row, variables: variablesIn(row.body) });
        } catch (e) {
            if (/templates_org_name_key/.test(e.message)) {
                return res.status(409).json({ error: 'A template with that name already exists' });
            }
            console.error('[templates] create failed:', e.message);
            res.status(500).json({ error: 'Could not save that template' });
        }
    });

    r.put('/:id', requireRole('manager'), async (req, res) => {
        const t = clean(req);
        if (!t.name || !t.body) return res.status(400).json({ error: 'A name and a message are both required' });
        if (!await ownsMedia(t.media_id, req.user.org_id)) {
            return res.status(400).json({ error: 'That attachment does not belong to this workspace' });
        }
        try {
            const row = await db.one(
                `UPDATE templates
                    SET name = ?, category = ?, body = ?, footer = ?, media_id = ?, buttons = ?, updated_at = NOW()
                  WHERE id = ? AND org_id = ? AND deleted_at IS NULL
                  RETURNING id, name, category, body, footer, media_id, buttons, use_count`,
                [t.name, t.category, t.body, t.footer, t.media_id, JSON.stringify(t.buttons),
                 req.params.id, req.user.org_id]);
            if (!row) return res.status(404).json({ error: 'Template not found' });
            res.json({ ...row, variables: variablesIn(row.body) });
        } catch (e) {
            if (/templates_org_name_key/.test(e.message)) {
                return res.status(409).json({ error: 'A template with that name already exists' });
            }
            res.status(500).json({ error: 'Could not update that template' });
        }
    });

    r.delete('/:id', requireRole('manager'), async (req, res) => {
        try {
            // Soft delete: a broadcast that already used this template still
            // needs to be able to name it in its report.
            const q = await db.query(
                'UPDATE templates SET deleted_at = NOW() WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
                [req.params.id, req.user.org_id]);
            if (!q.rowCount) return res.status(404).json({ error: 'Template not found' });
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: 'Could not delete that template' });
        }
    });

    /**
     * Preview against a real contact, so what the clinic reads is what the
     * patient will receive — including any placeholder that will not resolve.
     */
    r.post('/preview', async (req, res) => {
        const body = String(req.body?.body || '');
        try {
            let contact = null;
            if (req.body?.contact_id) {
                contact = await db.one(
                    'SELECT name, phone, email, custom FROM contacts WHERE id = ? AND org_id = ?',
                    [req.body.contact_id, req.user.org_id]);
            }
            if (!contact) {
                contact = await db.one(
                    `SELECT name, phone, email, custom FROM contacts
                      WHERE org_id = ? AND deleted_at IS NULL AND name IS NOT NULL
                      ORDER BY created_at LIMIT 1`, [req.user.org_id]);
            }
            const sample = contact || { name: 'Priya Sharma', phone: '919876543210', email: '', custom: {} };
            res.json({
                rendered: render(body, sample, req.body?.variables || {}),
                variables: variablesIn(body),
                unresolved: unresolved(body, sample, req.body?.variables || {}),
                sample: { name: sample.name, phone: sample.phone },
            });
        } catch (e) {
            res.status(500).json({ error: 'Could not render that preview' });
        }
    });

    return r;
}

module.exports = { router, render, variablesIn, unresolved };
