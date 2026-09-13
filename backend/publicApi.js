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
const config = require('./config');
const partners = require('./partners');

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
        `SELECT k.id AS key_id, k.org_id, o.name AS org_name, pl.partner
           FROM api_keys k
           JOIN organisations o ON o.id = k.org_id
           LEFT JOIN partner_links pl ON pl.org_id = k.org_id
          WHERE k.key_hash = ? AND k.revoked_at IS NULL`,
        [sha256(key)],
        (err, row) => {
            if (err) return res.status(500).json({ error: 'Internal error' });
            if (!row) return res.status(401).json({ error: 'Invalid API key' });
            // A partner workspace's key only works from the partner's servers.
            // This box speaks plain HTTP, so a key is readable by anyone on the
            // path between the partner and here; pinning it to the partner's
            // source address is what keeps a copied key useless.
            if (row.partner) {
                const partner = config.partners[row.partner];
                if (!partner) {
                    return res.status(403).json({ error: 'This workspace belongs to a partner that is not enabled on this server' });
                }
                const ip = partners.sourceIp(req);
                if (!partners.ipAllowed(partner, ip)) {
                    return res.status(403).json({ error: 'This key cannot be used from this address', ip });
                }
            }
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

/**
 * One send at a time per workspace, with a gap between them.
 *
 * API traffic went out as fast as callers could post it. A partner product
 * booking a morning's worth of appointments, or a reminder job firing on the
 * quarter hour, can put a burst of identical-looking messages on one personal
 * number in a second, and a burst is exactly what gets a number restricted.
 * Automations and broadcasts already pace themselves; this brings API sends in
 * line. A backlog past `maxQueued` is refused rather than held, so a runaway
 * caller gets a 429 instead of a queue that outlives its own timeouts.
 */
function createPacer({ gapMs, maxQueued, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const lanes = new Map();   // key -> { tail, queued, lastAt }

    const sweep = setInterval(() => {
        const t = now();
        for (const [k, lane] of lanes) if (!lane.queued && t - lane.lastAt > 10 * 60 * 1000) lanes.delete(k);
    }, 60 * 1000);
    if (sweep.unref) sweep.unref();

    return {
        /** Resolves with fn's result, or returns null at once if the lane is full. */
        run(key, fn) {
            let lane = lanes.get(key);
            if (!lane) { lane = { tail: Promise.resolve(), queued: 0, lastAt: -Infinity }; lanes.set(key, lane); }
            if (lane.queued >= maxQueued) return null;
            lane.queued += 1;
            const job = lane.tail.then(async () => {
                const wait = lane.lastAt + gapMs - now();
                if (wait > 0) await sleep(wait);
                try { return await fn(); } finally { lane.lastAt = now(); }
            });
            lane.tail = job.catch(() => {}).finally(() => { lane.queued -= 1; });
            return job;
        },
        depth(key) { return lanes.get(key)?.queued || 0; },
    };
}

const pacer = createPacer({
    gapMs: parseInt(process.env.API_SEND_GAP_MS, 10) || 1200,
    maxQueued: parseInt(process.env.API_SEND_MAX_QUEUED, 10) || 40,
});

/** Evolution picks image vs document vs audio from this, so a PDF must say it is one. */
const MIME_BY_EXT = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg',
};
function resolveMimetype(mimetype, filename) {
    const given = String(mimetype || '').trim().toLowerCase();
    if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(given) && !given.startsWith('image/svg')) return given;
    const ext = String(filename || '').toLowerCase().split('.').pop();
    return MIME_BY_EXT[ext] || '';
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
        const { to, text, media_url, caption, filename, mimetype } = req.body || {};
        const reference = req.body?.reference == null ? null : String(req.body.reference).slice(0, 128);

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

        const orgId = req.apiUser.org_id;
        const job = pacer.run(orgId, async () => {
            // Re-checked inside the lane: the number can drop while a send waits
            // its turn, and a message sent to a closed instance is simply lost.
            if (!whatsappClient.getStatus(orgId).isConnected) return { offline: true };
            if (media_url) {
                return {
                    result: await whatsappClient.sendMediaByUrl(orgId, number, {
                        url: media_url,
                        caption: caption || text || '',
                        filename,
                        mimetype: resolveMimetype(mimetype, filename),
                    }),
                };
            }
            return { result: await whatsappClient.sendMessage(orgId, number, text) };
        });
        if (!job) {
            return res.status(429).json({
                error: 'Too many messages waiting to send from this number',
                retry_after_seconds: 30,
            });
        }
        const outcome = await job;
        if (outcome.offline) {
            return res.status(409).json({
                error: 'WhatsApp is not connected for this account',
                hint: 'The account owner needs to re-link their phone in WA Reach.',
            });
        }

        const messageId = typeof outcome.result === 'string' ? outcome.result : null;
        const ok = !!outcome.result;

        // Awaited, unlike before: WhatsApp's first receipt for this message can
        // arrive within a second, and it has nothing to update until this row exists.
        await dbRun(
            `INSERT INTO api_sends (org_id, api_key_id, to_number, body, has_media, wa_message_id, status, error_reason, reference)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [orgId, req.apiUser.key_id, number, text || caption || '', !!media_url, messageId,
             ok ? 'sent' : 'failed', ok ? null : 'Send failed', reference]
        ).catch((e) => console.error('[api] could not record a send:', e.message));

        if (!ok) return res.status(502).json({ error: 'WhatsApp rejected the message' });
        res.status(201).json({ success: true, message_id: messageId, to: number, reference });
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

module.exports = { router, issueKey, authenticateApiKey, generateKey, createPacer, resolveMimetype };
