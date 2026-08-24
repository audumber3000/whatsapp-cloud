// MolarPlus integration: headless, API-driven WhatsApp sessions.
//
// Separate from the per-user UI sessions in whatsapp.js. Each session here is
// keyed by a UUID `session_id`, owns its own opaque api_key, and reports status
// + delivery receipts back to MolarPlus via a signed webhook.
//
// Backed by Evolution API (instance name: wareach_api_<session_id>). The export
// surface and every response shape are unchanged from the whatsapp-web.js
// version, so the MolarPlus contract is untouched.

const qrcode = require('qrcode');
const crypto = require('crypto');
const db = require('./db');
const client = require('./evolution/client');
const state = require('./evolution/state');
const hooks = require('./evolution/webhook');

// --- small promisified db helpers ---
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

// --- signed webhook back to MolarPlus (unchanged) ---
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

/** Evolution's cache state -> the vocabulary stored in api_sessions.status. */
function statusFor(sessionId) {
    const s = state.get(hooks.instanceNameForSession(sessionId));
    if (s.isConnected) return 'connected';
    if (s.currentQR) return 'connecting';
    return 'disconnected';
}

async function persistStatus(sessionId, status, phone) {
    await dbRun(
        'UPDATE api_sessions SET status = ?, phone_number = COALESCE(?, phone_number) WHERE session_id = ?',
        [status, phone || null, sessionId]
    ).catch(() => {});
}

// ── React to Evolution state changes ────────────────────────────────────────
// Mirrors what the old whatsapp-web.js 'ready' / 'disconnected' handlers did:
// persist the new status and tell MolarPlus.
state.onChange(async (instanceName, next, prev) => {
    const sessionId = hooks.sessionIdFromInstance(instanceName);
    if (!sessionId) return;

    if (next.isConnected && !prev.isConnected) {
        await persistStatus(sessionId, 'connected', next.phone);
        fireWebhook({ session_id: sessionId, event: 'connected', status: 'connected', phone_number: next.phone });
    } else if (!next.isConnected && prev.isConnected) {
        await persistStatus(sessionId, 'disconnected');
        fireWebhook({ session_id: sessionId, event: 'disconnected', status: 'disconnected' });
    }
});

// ── Delivery receipts ───────────────────────────────────────────────────────
// The old code held a messageId -> log_id map in memory, which was lost on every
// restart. api_messages.log_id already exists, so correlate through the DB
// instead and receipts survive restarts.
hooks.onMessageStatus('api', async (sessionId, messageId, status) => {
    try {
        const row = await dbGet(
            'SELECT log_id FROM api_messages WHERE wa_message_id = ? AND session_id = ?',
            [messageId, sessionId]
        );
        await dbRun(
            'UPDATE api_messages SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE wa_message_id = ? AND session_id = ?',
            [status, messageId, sessionId]
        );
        if (row && row.log_id !== null && row.log_id !== undefined) {
            fireWebhook({ session_id: sessionId, log_id: row.log_id, message_status: status });
        }
    } catch (e) {
        console.error('[API] receipt handling failed:', e.message);
    }
});

/**
 * Ensure the Evolution instance exists and is pairing.
 * Replaces startClient(); Evolution persists instances, so this is idempotent.
 */
async function startInstance(sessionId) {
    const instance = hooks.instanceNameForSession(sessionId);
    try {
        await client.ensureInstance(instance);
        const res = await client.connectionState(instance).catch(() => null);
        const connected = (res?.instance?.state || res?.state) === 'open';
        state.update(instance, { isConnected: connected, lastEvent: 'api-init' });
        if (!connected) await client.connect(instance);
        return true;
    } catch (e) {
        console.error(`[API] start failed for ${sessionId}:`, e.message);
        await persistStatus(sessionId, 'failed');
        fireWebhook({ session_id: sessionId, event: 'failed', status: 'failed', error: e.message });
        return false;
    }
}

/**
 * Block until the session has a QR or is connected, so POST /api/sessions can
 * still answer with a QR in one round trip. Previously raced whatsapp-web.js
 * client events; now races the state cache, which webhooks feed.
 */
function waitForSignal(sessionId, timeoutMs = 25000) {
    const instance = hooks.instanceNameForSession(sessionId);
    const s = state.get(instance);
    if (s.currentQR || s.isConnected) return Promise.resolve();

    return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; unsub(); clearTimeout(timer); resolve(); } };
        const unsub = state.onChange((name, next) => {
            if (name === instance && (next.currentQR || next.isConnected)) finish();
        });
        const timer = setTimeout(finish, timeoutMs);
    });
}

/** MolarPlus expects a PNG data-URL; Evolution gives us the raw pairing string. */
async function qrDataUrl(sessionId) {
    const code = state.get(hooks.instanceNameForSession(sessionId)).currentQR;
    if (!code) return null;
    try {
        return await qrcode.toDataURL(code);
    } catch {
        return null;
    }
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

    await startInstance(sessionId);
    await waitForSignal(sessionId);

    return {
        session_id: sessionId,
        api_key: apiKey,
        qr: await qrDataUrl(sessionId),
        status: statusFor(sessionId),
    };
}

async function getQr(sessionId) {
    const row = await dbGet('SELECT session_id, status FROM api_sessions WHERE session_id = ?', [sessionId]);
    if (!row) return null;
    return { qr: await qrDataUrl(sessionId), status: statusFor(sessionId) };
}

async function getStatus(sessionId) {
    const row = await dbGet('SELECT * FROM api_sessions WHERE session_id = ?', [sessionId]);
    if (!row) return null;
    const s = state.get(hooks.instanceNameForSession(sessionId));
    return { status: statusFor(sessionId), phone_number: s.phone || row.phone_number || null };
}

// Validate the Bearer api_key for a session.
async function authorize(sessionId, apiKey) {
    const row = await dbGet('SELECT api_key FROM api_sessions WHERE session_id = ?', [sessionId]);
    return !!(row && apiKey && row.api_key === apiKey);
}

async function getClinicId(sessionId) {
    const row = await dbGet('SELECT clinic_id FROM api_sessions WHERE session_id = ?', [sessionId]);
    return row ? row.clinic_id : null;
}

// POST /api/sessions/:id/send
async function sendMessage(sessionId, { to, text, media_url, log_id }) {
    if (statusFor(sessionId) !== 'connected') {
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

    const instance = hooks.instanceNameForSession(sessionId);
    let result;
    if (media_url) {
        // Evolution fetches the URL itself, so the remote content never enters
        // this process — which also removes the old SSRF surface from
        // MessageMedia.fromUrl().
        result = await client.sendMedia(instance, digits, {
            media: media_url,
            mimetype: '',            // let Evolution sniff it from the response
            fileName: 'attachment',
            caption: text || '',
        });
    } else {
        result = await client.sendText(instance, digits, text || '');
    }

    const messageId = result?.key?.id || result?.messageId || null;
    const clinicId = await getClinicId(sessionId);

    // log_id is persisted here rather than kept in memory — that is what makes
    // delivery receipts survive a restart.
    dbRun(
        `INSERT INTO api_messages (session_id, clinic_id, to_number, body, has_media, wa_message_id, log_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sent')`,
        [sessionId, clinicId, digits, text || '', media_url ? 1 : 0, messageId, (log_id ?? null)]
    ).catch(() => {});

    return messageId;
}

// DELETE /api/sessions/:id — logout, destroy, remove record.
async function removeSession(sessionId) {
    const instance = hooks.instanceNameForSession(sessionId);
    try { await client.logout(instance); } catch (e) {}
    try { await client.deleteInstance(instance); } catch (e) {}
    state.remove(instance);

    await persistStatus(sessionId, 'disconnected').catch(() => {});
    fireWebhook({ session_id: sessionId, event: 'disconnected', status: 'disconnected' });
    await dbRun('DELETE FROM api_sessions WHERE session_id = ?', [sessionId]).catch(() => {});
    return true;
}

// On boot, restore all known sessions. Evolution keeps them authenticated, so
// there is no re-scan and no staggering — that only existed to avoid launching
// several Chromium processes at once.
async function bootAll() {
    const rows = await dbAll('SELECT session_id FROM api_sessions').catch(() => []);
    if (!rows.length) return;
    console.log(`[API] Restoring ${rows.length} MolarPlus session(s)...`);
    for (const row of rows) await startInstance(row.session_id);
}

module.exports = {
    createOrRestartSession, getQr, getStatus, authorize, getClinicId, sendMessage, removeSession, bootAll,
};
