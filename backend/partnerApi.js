/**
 * Partner API: another product connects its customers' own WhatsApp numbers.
 *
 * MolarPlus lets a clinic link its own number from inside MolarPlus. The clinic
 * never signs up here and never sees this dashboard: MolarPlus creates a
 * workspace for it, shows the pairing QR in its own UI, and sends through the
 * workspace's API key (publicApi.js). What happens next comes back to MolarPlus
 * as signed webhooks (webhooks.js): the number connecting or dropping, and
 * messages being delivered, read or failing.
 *
 * This replaces the /api/sessions stack removed in 5d2edda, which did the same
 * job with no authentication at all. Everything here requires the partner's
 * key AND a request from the partner's own server address (config.js), and a
 * partner can only ever see the workspaces it created.
 *
 *   POST /api/partner/v1/workspaces                  create or re-key   {external_id, name, timezone?}
 *   POST /api/partner/v1/workspaces/:id/connect      start pairing      -> {status, qr, phone_number}
 *   GET  /api/partner/v1/workspaces/:id/status       poll               -> {status, qr, phone_number}
 *   POST /api/partner/v1/workspaces/:id/disconnect   unpair and stop    -> {status}
 *   GET  /api/partner/v1/whoami                      which partner, from which address
 *
 * `status` is one of connected | connecting | disconnected. `qr` is a PNG data
 * URL while pairing, otherwise ''.
 */

const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const db = require('./db');
const partners = require('./partners');
const orgInstances = require('./orgInstances');
const state = require('./evolution/state');
const webhooks = require('./webhooks');
const hardening = require('./hardening');
const { generateKey } = require('./publicApi');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/** What a partner endpoint subscribes to. Replies are left out until a partner consumes them. */
const PARTNER_EVENTS = [
    'session.connected', 'session.disconnected',
    'message.delivered', 'message.read', 'message.failed',
    'contact.opted_out',
];

/* ── pairing lifetime ─────────────────────────────────────────────────────── */

/**
 * How long an unscanned QR is kept alive.
 *
 * WhatsApp rotates the code every ~20 seconds and Evolution keeps asking for
 * new ones, and the re-arm backoff reconnects a closed instance forever. For a
 * dashboard user that is right. For a partner workspace it means a clinic that
 * opened the connect screen and walked away leaves an instance cycling codes
 * indefinitely. So pairing gets a deadline, and an instance still showing a QR
 * after it is torn down. A QR only exists when there are no valid credentials,
 * so this can never unpair a working number.
 */
const PAIRING_TTL_MS = 10 * 60 * 1000;
const pairingSince = new Map();   // org_id -> ms since epoch

function startPairing(orgId, now = Date.now()) {
    pairingSince.set(String(orgId), now);
}

/**
 * The partner-facing status for a cached instance state. Pure, for tests.
 * "connecting" covers the gap between asking for a QR and Evolution sending one.
 */
function statusOf(s, since, now = Date.now()) {
    if (s && s.isConnected) return { status: 'connected', phone_number: s.phone || null, qrCode: '' };
    const qrCode = (s && s.currentQR) || '';
    const pairing = !!qrCode || (!!since && now - since < PAIRING_TTL_MS);
    return { status: pairing ? 'connecting' : 'disconnected', phone_number: null, qrCode };
}

function stateFor(orgId) {
    const name = orgInstances.nameFor(orgId);
    return name ? state.get(name) : null;
}

async function describe(orgId) {
    const s = statusOf(stateFor(orgId), pairingSince.get(String(orgId)));
    let qr = '';
    if (s.qrCode) {
        try {
            qr = await QRCode.toDataURL(s.qrCode, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
        } catch (e) {
            console.error(`[partner] could not render a QR for ${orgId}: ${e.message}`);
        }
    }
    return { status: s.status, qr, phone_number: s.phone_number };
}

/** Wait briefly for Evolution's first QR, so the connect response can carry it. */
async function waitForPairingCode(orgId, timeoutMs = 4000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const s = stateFor(orgId);
        if (s && (s.currentQR || s.isConnected)) return;
        await new Promise((r) => setTimeout(r, 250));
    }
}

let sweepStarted = false;
function startPairingSweep() {
    if (sweepStarted) return;
    sweepStarted = true;

    // A QR appearing on a partner workspace starts the clock even when no
    // connect call did: at boot, or when the clinic logged the device out
    // from their phone and Evolution began asking to pair again.
    state.onChange((instanceName, next) => {
        const orgId = orgInstances.orgFor(instanceName);
        if (!orgId || !partners.isPartnerOrg(orgId)) return;
        if (next.isConnected) pairingSince.delete(String(orgId));
        else if (next.currentQR && !pairingSince.has(String(orgId))) startPairing(orgId);
    });

    const timer = setInterval(async () => {
        const now = Date.now();
        for (const [orgId, since] of pairingSince) {
            const s = stateFor(orgId);
            if (s && s.isConnected) { pairingSince.delete(orgId); continue; }
            if (now - since < PAIRING_TTL_MS) continue;
            pairingSince.delete(orgId);
            console.log(`[partner] pairing for ${orgId} expired unscanned — unlinking`);
            await require('./whatsapp').unlinkClient(orgId).catch((e) =>
                console.error(`[partner] could not unlink expired pairing ${orgId}: ${e.message}`));
        }
    }, 30 * 1000);
    if (timer.unref) timer.unref();
}

/* ── auth ─────────────────────────────────────────────────────────────────── */

function authenticatePartner(req, res, next) {
    const header = req.get('authorization') || '';
    const key = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const partner = partners.partnerForKey(key);
    if (!partner) return res.status(401).json({ error: 'Invalid partner key' });

    const ip = partners.sourceIp(req);
    if (!partners.ipAllowed(partner, ip)) {
        console.warn(`[partner] ${partner.id} key used from a disallowed address ${ip}`);
        return res.status(403).json({ error: 'This partner key cannot be used from this address', ip });
    }
    req.partner = partner;
    next();
}

/** 404 for anything that is not one of the calling partner's own workspaces. */
async function loadWorkspace(req, res, next) {
    const id = String(req.params.id || '');
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Workspace not found' });
    const link = await db.one(
        'SELECT org_id, external_id FROM partner_links WHERE org_id = ? AND partner = ?',
        [id, req.partner.id]);
    if (!link) return res.status(404).json({ error: 'Workspace not found' });
    await orgInstances.ensureFor(link.org_id);
    partners.remember(link.org_id, req.partner.id);
    req.workspace = { orgId: String(link.org_id), externalId: link.external_id };
    next();
}

/* ── provisioning ─────────────────────────────────────────────────────────── */

async function provision(partner, { externalId, name, timezone }) {
    // Checked outside the transaction: it resolves DNS, and a partner whose
    // webhook URL is wrong must still be able to connect and poll.
    let webhookUrl = null;
    if (partner.webhookUrl && partner.webhookSecret) {
        const check = await webhooks.validateUrl(partner.webhookUrl);
        if (check.ok) webhookUrl = check.url;
        else console.error(`[partner] ${partner.id} webhook URL refused (${check.error}) — status will not be pushed`);
    }

    return db.tx(async (t) => {
        // Two connect clicks racing must not create two workspaces for one clinic.
        await t.query('SELECT pg_advisory_xact_lock(hashtext(?))', [`partner:${partner.id}:${externalId}`]);

        let link = await t.one(
            'SELECT org_id FROM partner_links WHERE partner = ? AND external_id = ?',
            [partner.id, externalId]);
        let created = false;

        if (!link) {
            const slugBase = `${partner.id}-${externalId}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
            const org = await t.one(
                `INSERT INTO organisations (name, slug, timezone) VALUES (?, ?, ?) RETURNING id`,
                [name, `${slugBase}-${Date.now().toString(36)}`, timezone || 'Asia/Kolkata']);
            await t.query(
                'INSERT INTO wa_instances (org_id, instance_name) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING',
                [org.id, `wareach_org_${org.id}`]);
            link = await t.one(
                'INSERT INTO partner_links (partner, external_id, org_id) VALUES (?, ?, ?) RETURNING org_id',
                [partner.id, externalId, org.id]);
            created = true;
        } else {
            await t.query('UPDATE organisations SET name = ?, updated_at = NOW() WHERE id = ?', [name, link.org_id]);
        }

        // A fresh key every time. The raw key is only ever returned here, so a
        // partner that lost it has no other way back in, and at most one key
        // for a workspace is ever live.
        await t.query('UPDATE api_keys SET revoked_at = NOW() WHERE org_id = ? AND revoked_at IS NULL', [link.org_id]);
        const apiKey = generateKey();
        const keyRow = await t.one(
            `INSERT INTO api_keys (org_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?) RETURNING id`,
            [link.org_id, `${partner.name} (partner)`, sha256(apiKey), apiKey.slice(0, 11)]);
        await t.query('UPDATE partner_links SET api_key_id = ?, updated_at = NOW() WHERE org_id = ?',
            [keyRow.id, link.org_id]);

        // Upserted rather than inserted once: this is also how a partner
        // endpoint that was switched off after repeated failures comes back.
        if (webhookUrl) {
            const endpointName = `partner:${partner.id}`;
            const existing = await t.one(
                'SELECT id FROM webhook_endpoints WHERE org_id = ? AND name = ?', [link.org_id, endpointName]);
            if (existing) {
                await t.query(
                    `UPDATE webhook_endpoints
                        SET url = ?, secret = ?, events = ?::jsonb, active = TRUE,
                            consecutive_fails = 0, updated_at = NOW()
                      WHERE id = ?`,
                    [webhookUrl, partner.webhookSecret, JSON.stringify(PARTNER_EVENTS), existing.id]);
            } else {
                await t.query(
                    `INSERT INTO webhook_endpoints (org_id, name, url, secret, events)
                     VALUES (?, ?, ?, ?, ?::jsonb)`,
                    [link.org_id, endpointName, webhookUrl, partner.webhookSecret, JSON.stringify(PARTNER_EVENTS)]);
            }
        }

        return { orgId: String(link.org_id), apiKey, created };
    });
}

/* ── routes ───────────────────────────────────────────────────────────────── */

function router() {
    const r = express.Router();
    r.use(express.json({ limit: '100kb' }));
    // Its own bucket, keyed on the real source address: the dashboard limiter
    // keys on a JWT this traffic never carries.
    r.use(hardening.rateLimit({
        max: 600, windowMs: 60_000, name: 'partner',
        keyOf: (req) => `partner-ip:${partners.sourceIp(req)}`,
    }));
    r.use(authenticatePartner);
    startPairingSweep();

    r.get('/whoami', (req, res) => {
        res.json({ partner: req.partner.id, ip: partners.sourceIp(req) });
    });

    r.post('/workspaces', async (req, res) => {
        const externalId = String(req.body?.external_id ?? '').trim();
        if (!externalId || externalId.length > 128) {
            return res.status(400).json({ error: '"external_id" is required (your id for this customer, max 128 chars)' });
        }
        const name = String(req.body?.name || '').trim().slice(0, 200) || `${req.partner.name} ${externalId}`;
        const tz = typeof req.body?.timezone === 'string' && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(req.body.timezone)
            ? req.body.timezone.slice(0, 64) : null;

        const out = await provision(req.partner, { externalId, name, timezone: tz });
        partners.remember(out.orgId, req.partner.id);
        await orgInstances.ensureFor(out.orgId);

        console.log(`[partner] ${req.partner.id} ${out.created ? 'created' : 're-keyed'} workspace ${out.orgId} for ${externalId}`);
        res.status(out.created ? 201 : 200).json({
            workspace_id: out.orgId,
            api_key: out.apiKey,
            ...(await describe(out.orgId)),
        });
    });

    r.post('/workspaces/:id/connect', loadWorkspace, async (req, res) => {
        const { orgId } = req.workspace;
        const s = stateFor(orgId);
        if (!(s && s.isConnected)) {
            startPairing(orgId);
            require('./whatsapp').initializeUserClient(orgId);
            await waitForPairingCode(orgId);
        }
        res.json(await describe(orgId));
    });

    r.get('/workspaces/:id/status', loadWorkspace, async (req, res) => {
        res.json(await describe(req.workspace.orgId));
    });

    r.post('/workspaces/:id/disconnect', loadWorkspace, async (req, res) => {
        const { orgId } = req.workspace;
        pairingSince.delete(orgId);
        const ok = await require('./whatsapp').unlinkClient(orgId);
        if (!ok) return res.status(502).json({ error: 'Could not unlink the number. Try again in a minute.' });
        console.log(`[partner] ${req.partner.id} unlinked workspace ${orgId}`);
        res.json({ status: 'disconnected', qr: '', phone_number: null });
    });

    return r;
}

module.exports = { router, statusOf, PAIRING_TTL_MS, PARTNER_EVENTS };
