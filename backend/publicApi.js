/**
 * The programmable API — WA Reach's second product.
 *
 * A user signs up, links their own WhatsApp, and gets an API key. Whoever holds
 * that key (one of our apps, or the user's own code) can send messages through
 * that user's number to that user's customers.
 *
 * Deliberately simple: one key per user, no app tenancy above it. The key IS
 * the account, so there is nothing to reconcile between an "app" and a "user".
 */

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const whatsappClient = require('./whatsapp');

const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

/** Prefixed so a leaked key is recognisable in logs and searchable in repos. */
function generateKey() {
    return 'wr_' + crypto.randomBytes(24).toString('hex');
}

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/**
 * Keys are stored hashed. Previously a single plaintext users.api_key meant a
 * database read handed over live send credentials for every tenant. The raw key
 * is returned once, here, and never recoverable afterwards.
 */
async function issueKey(orgId, { name = 'Default', createdBy = null } = {}) {
    const key = generateKey();
    await dbRun(
        `INSERT INTO api_keys (org_id, name, key_hash, key_prefix, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [orgId, name, sha256(key), key.slice(0, 11), createdBy]
    );
    return key;
}

/**
 * Accepts the key as `Authorization: Bearer <key>` or an `apikey` header —
 * both are common enough that rejecting one is just friction.
 */
function authenticateApiKey(req, res, next) {
    const header = req.get('authorization') || '';
    const key = header.toLowerCase().startsWith('bearer ')
        ? header.slice(7).trim()
        : (req.get('apikey') || '').trim();

    if (!key) {
        return res.status(401).json({ error: 'Missing API key', hint: 'Send it as: Authorization: Bearer <key>' });
    }
    db.get(
        `SELECT k.id AS key_id, k.org_id, o.name AS org_name
           FROM api_keys k JOIN organisations o ON o.id = k.org_id
          WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
        [sha256(key)],
        (err, row) => {
            if (err) return res.status(500).json({ error: 'Internal error' });
            if (!row) return res.status(401).json({ error: 'Invalid API key' });
            // Best-effort; a failed touch must never block a send.
            db.run('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.key_id], () => {});
            req.apiUser = { org_id: row.org_id, username: row.org_name, key_id: row.key_id };
            next();
        });
}

/**
 * Very small in-memory limiter. Not a billing system — it exists so a runaway
 * loop in someone's integration cannot burn a user's WhatsApp number, which is
 * the asset that actually gets banned.
 */
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60 * 1000;
const hits = new Map();
function rateLimit(req, res, next) {
    const id = req.apiUser.org_id;
    const now = Date.now();
    const rec = hits.get(id) || { count: 0, reset: now + RATE_WINDOW_MS };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + RATE_WINDOW_MS; }
    rec.count += 1;
    hits.set(id, rec);
    res.set('X-RateLimit-Limit', String(RATE_MAX));
    res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_MAX - rec.count)));
    if (rec.count > RATE_MAX) {
        return res.status(429).json({
            error: 'Rate limit exceeded',
            limit: RATE_MAX,
            retry_after_seconds: Math.ceil((rec.reset - now) / 1000),
        });
    }
    next();
}

function router() {
    const r = express.Router();
    r.use(express.json({ limit: '2mb' }));

    // Is this key valid, and can it send right now?
    r.get('/status', authenticateApiKey, (req, res) => {
        const s = whatsappClient.getStatus(req.apiUser.org_id);
        res.json({
            account: req.apiUser.username,
            whatsapp_connected: s.isConnected,
            phone_number: s.phone,
            ready_to_send: s.isConnected,
        });
    });

    // Send a message through this user's WhatsApp.
    r.post('/messages', authenticateApiKey, rateLimit, async (req, res) => {
        const { to, text, media_url, caption, filename, reference } = req.body || {};

        const number = String(to || '').replace(/\D/g, '');
        if (!number) {
            return res.status(400).json({ error: 'A "to" number is required, in international format e.g. 919876543210' });
        }
        if (!text && !media_url) {
            return res.status(400).json({ error: 'Provide "text", or "media_url" for an attachment' });
        }

        // Opt-out is a hard stop, and it applies to API traffic too — otherwise
        // an integration silently undoes a customer's STOP.
        const contact = await dbGet(
            'SELECT id, opted_out FROM contacts WHERE org_id = ? AND phone = ?',
            [req.apiUser.org_id, number]
        ).catch(() => null);
        if (contact && Number(contact.opted_out) === 1) {
            return res.status(403).json({ error: 'This contact has opted out of messages', to: number });
        }

        const status = whatsappClient.getStatus(req.apiUser.org_id);
        if (!status.isConnected) {
            return res.status(409).json({
                error: 'WhatsApp is not connected for this account',
                hint: 'The account owner needs to re-link their phone in WA Reach.',
            });
        }

        let result;
        if (media_url) {
            result = await whatsappClient.sendMediaByUrl(req.apiUser.org_id, number, {
                url: media_url, caption: caption || text || '', filename,
            });
        } else {
            result = await whatsappClient.sendMessage(req.apiUser.org_id, number, text);
        }

        const messageId = typeof result === 'string' ? result : null;
        const ok = !!result;

        dbRun(
            `INSERT INTO api_sends (org_id, api_key_id, to_number, body, has_media, wa_message_id, status, error_reason, reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.apiUser.org_id, req.apiUser.key_id, number, text || caption || '', !!media_url, messageId,
             ok ? 'sent' : 'failed', ok ? null : 'Send failed', reference || null]
        ).catch(() => {});

        if (!ok) return res.status(502).json({ error: 'WhatsApp rejected the message' });
        res.status(201).json({ success: true, message_id: messageId, to: number, reference: reference || null });
    });

    // What this key has sent, and what happened to it.
    r.get('/messages', authenticateApiKey, (req, res) => {
        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        db.all(
            `SELECT to_number, body, has_media, wa_message_id, status, reference, created_at
               FROM api_sends WHERE org_id = ? ORDER BY id DESC LIMIT ?`,
            [req.apiUser.org_id, limit],
            (err, rows) => {
                if (err) return res.status(500).json({ error: 'Internal error' });
                res.json({ messages: rows || [] });
            }
        );
    });

    return r;
}

module.exports = { router, issueKey, authenticateApiKey, generateKey };
