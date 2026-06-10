// MolarPlus integration: headless, API-driven WhatsApp sessions.
//
// Separate from the per-user UI sessions in whatsapp.js. Each session here is
// keyed by a UUID `session_id` (clientId for LocalAuth, so it survives restarts),
// owns its own opaque api_key, and reports status + delivery receipts back to
// MolarPlus via a signed webhook.

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const API_AUTH_DIR = path.join(__dirname, 'sessions', 'api');
fs.mkdirSync(API_AUTH_DIR, { recursive: true });

// In-memory runtime per session_id: { client, status, qr, phone, msgLog:Map, signal, resolveSignal }
const runtime = new Map();

// --- small promisified db helpers ---
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

// --- signed webhook back to MolarPlus ---
async function fireWebhook(payload) {
    const base = process.env.MOLARPLUS_URL;
    const secret = process.env.WAREACH_WEBHOOK_SECRET;
    if (!base) {
        console.warn('[API] MOLARPLUS_URL not set — skipping webhook:', payload.event || payload.message_status);
        return;
    }
    try {
        const res = await fetch(`${base.replace(/\/$/, '')}/api/v1/integrations/wareach/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-WAReach-Secret': secret || '' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) console.warn(`[API] Webhook ${payload.event || payload.message_status} -> HTTP ${res.status}`);
    } catch (e) {
        console.error('[API] Webhook failed:', e.message);
    }
}

function normalizePhone(to) {
    return String(to || '').replace(/\D/g, '');
}

async function setStatus(sessionId, status, phone) {
    const rt = runtime.get(sessionId);
    if (rt) { rt.status = status; if (phone !== undefined) rt.phone = phone; }
    await dbRun('UPDATE api_sessions SET status = ?, phone_number = COALESCE(?, phone_number) WHERE session_id = ?',
        [status, phone || null, sessionId]).catch(() => {});
}

// Map a whatsapp-web.js ack code to the webhook's message_status.
function ackToStatus(ack) {
    switch (ack) {
        case -1: return 'failed';
        case 1: return 'sent';
        case 2: return 'delivered';
        case 3:
        case 4: return 'read';
        default: return null;
    }
}

function buildClient(sessionId) {
    const isLinuxARM = process.platform === 'linux' && /arm/i.test(process.arch);
    const defaultChromePath = isLinuxARM ? '/usr/bin/chromium-browser' : undefined;
    const executablePath = process.env.CHROME_PATH || defaultChromePath; // else puppeteer uses PUPPETEER_EXECUTABLE_PATH

    return new Client({
        authStrategy: new LocalAuth({ clientId: sessionId, dataPath: API_AUTH_DIR }),
        puppeteer: {
            executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu'],
            protocolTimeout: 60000,
        },
    });
}

// Start (or restart) the whatsapp-web.js client for a session_id.
function startClient(sessionId) {
    const existing = runtime.get(sessionId);
    if (existing && existing.client) return existing; // already running

    const client = buildClient(sessionId);
    const rt = { client, status: 'connecting', qr: null, phone: null, msgLog: new Map(), resolveSignal: null };
    rt.signal = new Promise((resolve) => { rt.resolveSignal = resolve; });
    runtime.set(sessionId, rt);

    client.on('qr', async (qr) => {
        try { rt.qr = await qrcode.toDataURL(qr); } catch (e) { rt.qr = null; }
        rt.status = 'connecting';
        await setStatus(sessionId, 'connecting');
        if (rt.resolveSignal) { rt.resolveSignal(); rt.resolveSignal = null; }
    });

    client.on('ready', async () => {
        rt.qr = null;
        const phone = client.info && client.info.wid ? client.info.wid.user : null;
        rt.phone = phone;
        await setStatus(sessionId, 'connected', phone);
        console.log(`[API] Session ${sessionId} connected as ${phone}`);
        fireWebhook({ session_id: sessionId, event: 'connected', status: 'connected', phone_number: phone });
        if (rt.resolveSignal) { rt.resolveSignal(); rt.resolveSignal = null; }
    });

    client.on('auth_failure', async (msg) => {
        await setStatus(sessionId, 'failed');
        fireWebhook({ session_id: sessionId, event: 'failed', status: 'failed', error: String(msg || 'auth_failure') });
        if (rt.resolveSignal) { rt.resolveSignal(); rt.resolveSignal = null; }
    });

    client.on('disconnected', async (reason) => {
        rt.qr = null;
        await setStatus(sessionId, 'disconnected');
        fireWebhook({ session_id: sessionId, event: 'disconnected', status: 'disconnected', error: String(reason || '') });
    });

    // Delivery receipts: report message_status for sends that carried a log_id.
    client.on('message_ack', (msg, ack) => {
        const logId = rt.msgLog.get(msg.id && msg.id._serialized);
        if (logId === undefined) return;
        const message_status = ackToStatus(ack);
        if (!message_status) return;
        fireWebhook({ session_id: sessionId, log_id: logId, message_status });
    });

    client.initialize().catch(async (err) => {
        console.error(`[API] Session ${sessionId} init failed:`, err.message);
        await setStatus(sessionId, 'failed');
        if (rt.resolveSignal) { rt.resolveSignal(); rt.resolveSignal = null; }
    });

    return rt;
}

// Wait until the first QR or ready/failed signal, so POST /sessions can return a QR.
async function waitForSignal(sessionId, timeoutMs = 25000) {
    const rt = runtime.get(sessionId);
    if (!rt) return;
    if (rt.qr || rt.status === 'connected' || rt.status === 'failed') return;
    await Promise.race([rt.signal, new Promise((r) => setTimeout(r, timeoutMs))]);
}

// POST /api/sessions — create or restart a session for a clinic.
async function createOrRestartSession(clinicId) {
    let row = await dbGet('SELECT * FROM api_sessions WHERE clinic_id = ?', [clinicId]);
    let sessionId, apiKey;

    if (row) {
        sessionId = row.session_id;
        apiKey = row.api_key;
    } else {
        sessionId = crypto.randomUUID();
        apiKey = crypto.randomBytes(32).toString('hex');
        await dbRun('INSERT INTO api_sessions (session_id, clinic_id, api_key, status) VALUES (?, ?, ?, ?)',
            [sessionId, clinicId, apiKey, 'connecting']);
    }

    startClient(sessionId);
    await waitForSignal(sessionId);

    const rt = runtime.get(sessionId);
    return { session_id: sessionId, api_key: apiKey, qr: rt ? rt.qr : null, status: rt ? rt.status : 'connecting' };
}

async function getQr(sessionId) {
    const row = await dbGet('SELECT session_id, status FROM api_sessions WHERE session_id = ?', [sessionId]);
    if (!row) return null;
    const rt = runtime.get(sessionId);
    return { qr: rt ? rt.qr : null, status: rt ? rt.status : row.status };
}

async function getStatus(sessionId) {
    const row = await dbGet('SELECT * FROM api_sessions WHERE session_id = ?', [sessionId]);
    if (!row) return null;
    const rt = runtime.get(sessionId);
    return { status: rt ? rt.status : row.status, phone_number: (rt && rt.phone) || row.phone_number || null };
}

// Validate the Bearer api_key for a session.
async function authorize(sessionId, apiKey) {
    const row = await dbGet('SELECT api_key FROM api_sessions WHERE session_id = ?', [sessionId]);
    return !!(row && apiKey && row.api_key === apiKey);
}

// POST /api/sessions/:id/send
async function sendMessage(sessionId, { to, text, media_url, log_id }) {
    const rt = runtime.get(sessionId);
    if (!rt || rt.status !== 'connected' || !rt.client) {
        const err = new Error('Session not connected');
        err.code = 'NOT_CONNECTED';
        throw err;
    }
    const digits = normalizePhone(to);
    if (!digits) {
        const err = new Error('Invalid "to" number');
        err.code = 'BAD_REQUEST';
        throw err;
    }
    const chatId = `${digits}@c.us`;

    let result;
    if (media_url) {
        const media = await MessageMedia.fromUrl(media_url, { unsafeMime: true });
        const asDocument = !/^image\/|^video\//.test(media.mimetype || '');
        const opts = { sendMediaAsDocument: asDocument };
        if (text) opts.caption = text;
        result = await rt.client.sendMessage(chatId, media, opts);
    } else {
        result = await rt.client.sendMessage(chatId, text || '');
    }

    const messageId = result && result.id ? result.id._serialized : null;
    if (messageId && log_id !== undefined && log_id !== null) {
        rt.msgLog.set(messageId, log_id); // for delivery-receipt webhooks
    }
    return messageId;
}

// DELETE /api/sessions/:id — logout, destroy, remove auth + record.
async function removeSession(sessionId) {
    const rt = runtime.get(sessionId);
    if (rt && rt.client) {
        try { await rt.client.logout(); } catch (e) {}
        try { await rt.client.destroy(); } catch (e) {}
    }
    runtime.delete(sessionId);
    await setStatus(sessionId, 'disconnected').catch(() => {});
    fireWebhook({ session_id: sessionId, event: 'disconnected', status: 'disconnected' });
    await dbRun('DELETE FROM api_sessions WHERE session_id = ?', [sessionId]).catch(() => {});
    // best-effort auth folder cleanup
    const dir = path.join(API_AUTH_DIR, `session-${sessionId}`);
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    return true;
}

// On boot, restore all known sessions (LocalAuth re-authenticates without a re-scan).
async function bootAll() {
    const rows = await dbAll('SELECT session_id FROM api_sessions').catch(() => []);
    if (!rows.length) return;
    console.log(`[API] Restoring ${rows.length} MolarPlus session(s)...`);
    for (let i = 0; i < rows.length; i++) {
        startClient(rows[i].session_id);
        if (i < rows.length - 1) await new Promise((r) => setTimeout(r, 8000)); // stagger Chromium launches
    }
}

module.exports = {
    createOrRestartSession, getQr, getStatus, authorize, sendMessage, removeSession, bootAll,
};
