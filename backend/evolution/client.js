/**
 * Thin HTTP wrapper around Evolution API.
 *
 * This is the ONLY module that knows Evolution's URL shapes, request bodies and
 * auth header. Everything else in the app talks to it through these functions,
 * so a version bump that changes a payload is a one-file change.
 *
 * Pinned against Evolution v2 (evoapicloud/evolution-api:v2.1.1). v1 nested the
 * text body as { textMessage: { text } }; v2 flattens it to { text }. If the
 * image is ever rolled back to v1, sendText is the only thing to adjust.
 */

const BASE = (process.env.EVOLUTION_URL || 'http://evolution:8080').replace(/\/$/, '');
const API_KEY = process.env.EVOLUTION_API_KEY || '';
const WEBHOOK_URL = process.env.EVOLUTION_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.EVOLUTION_WEBHOOK_SECRET || '';

// Events we actually consume. Subscribing to less means less webhook noise and
// less work for Evolution — we never read inbound messages.
const WEBHOOK_EVENTS = [
    'QRCODE_UPDATED',      // pairing code for the connect screen
    'CONNECTION_UPDATE',   // open / close / connecting — drives self-healing
    'MESSAGES_UPDATE',     // delivery receipts (sent → delivered → read)
    'SEND_MESSAGE',        // confirms our own outbound sends
];

class EvolutionError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'EvolutionError';
        this.status = status;
        this.body = body;
    }
}

/**
 * Every Evolution call goes through here.
 * Throws EvolutionError on non-2xx so callers can distinguish transport
 * failures from a legitimate "not connected".
 */
async function request(method, path, body, { timeoutMs = 30000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
        res = await fetch(`${BASE}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                apikey: API_KEY,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            throw new EvolutionError(`Evolution request timed out after ${timeoutMs}ms: ${method} ${path}`, 0, null);
        }
        throw new EvolutionError(`Evolution unreachable: ${err.message}`, 0, null);
    }
    clearTimeout(timer);

    const text = await res.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }

    if (!res.ok) {
        const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
        throw new EvolutionError(`Evolution ${res.status} on ${method} ${path}: ${detail}`, res.status, payload);
    }
    return payload;
}

/**
 * Evolution wants a bare international number — no '+', no '@c.us'.
 * Contacts are already stored as bare digits with a country code, so this is
 * mostly a guard against hand-entered values (users.personal_whatsapp_number
 * is never normalised on the way in).
 */
function formatNumber(phone) {
    return String(phone || '').replace(/\D/g, '');
}

// ── Instances ───────────────────────────────────────────────────────────────

async function createInstance(instanceName) {
    return request('POST', '/instance/create', {
        instanceName,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        // Registered per instance rather than via the global webhook env vars,
        // which differ between Evolution versions.
        webhook: {
            url: WEBHOOK_URL,
            byEvents: false,
            base64: true,
            headers: { 'x-webhook-secret': WEBHOOK_SECRET },
            events: WEBHOOK_EVENTS,
        },
    });
}

/** Ask Evolution to (re)start pairing. Returns a payload containing the QR. */
async function connect(instanceName) {
    return request('GET', `/instance/connect/${encodeURIComponent(instanceName)}`);
}

async function connectionState(instanceName) {
    return request('GET', `/instance/connectionState/${encodeURIComponent(instanceName)}`);
}

async function fetchInstances() {
    return request('GET', '/instance/fetchInstances');
}

async function logout(instanceName) {
    return request('POST', `/instance/logout/${encodeURIComponent(instanceName)}`);
}

async function deleteInstance(instanceName) {
    return request('DELETE', `/instance/delete/${encodeURIComponent(instanceName)}`);
}

/**
 * Create the instance only if Evolution doesn't already have it.
 * Evolution persists instances itself, so this is idempotent across restarts.
 */
async function ensureInstance(instanceName) {
    try {
        await connectionState(instanceName);
        return { created: false };
    } catch (err) {
        if (err.status === 404) {
            await createInstance(instanceName);
            return { created: true };
        }
        throw err;
    }
}

// ── Messages ────────────────────────────────────────────────────────────────

async function sendText(instanceName, phone, text) {
    return request('POST', `/message/sendText/${encodeURIComponent(instanceName)}`, {
        number: formatNumber(phone),
        text,
    });
}

/**
 * `media` is either a base64 string (no data: prefix) or a public URL.
 * Images and video go inline; anything else (PDF, audio) is sent as a document,
 * matching the previous whatsapp-web.js behaviour.
 */
async function sendMedia(instanceName, phone, { media, mimetype, fileName, caption = '' }) {
    const isInline = /^image\/|^video\//.test(mimetype || '');
    const body = {
        number: formatNumber(phone),
        mediatype: isInline ? (mimetype.startsWith('image/') ? 'image' : 'video') : 'document',
        mimetype: mimetype || 'application/octet-stream',
        media,
        fileName: fileName || 'file',
    };
    if (caption && caption.trim()) body.caption = caption;
    return request('POST', `/message/sendMedia/${encodeURIComponent(instanceName)}`, body);
}

module.exports = {
    EvolutionError,
    WEBHOOK_EVENTS,
    formatNumber,
    createInstance,
    ensureInstance,
    connect,
    connectionState,
    fetchInstances,
    logout,
    deleteInstance,
    sendText,
    sendMedia,
};
