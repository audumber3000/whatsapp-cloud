/**
 * Inbound webhook receiver for Evolution API.
 *
 * Evolution pushes pairing codes, connection transitions and delivery receipts
 * here. This router authenticates the call, normalises the payload (Evolution
 * has shifted these shapes between releases), updates the state cache, and
 * hands message-status events to whichever stack owns the instance.
 *
 * Instance naming keeps the two stacks apart and cannot collide:
 *   wareach_user_<userId>     — clinic UI sessions   (whatsapp.js)
 *   wareach_api_<sessionUuid> — MolarPlus B2B        (apiSessions.js)
 */

const express = require('express');
const state = require('./state');
const client = require('./client');

const USER_PREFIX = 'wareach_user_';
const API_PREFIX = 'wareach_api_';

const WEBHOOK_SECRET = require('../config').evolution.webhookSecret;

/** Handlers registered by the two stacks for message-status events. */
const messageStatusHandlers = { user: null, api: null };
/** Handler for inbound messages (clinic stack only — the B2B path is outbound). */
let inboundHandler = null;

function onMessageStatus(kind, fn) {
    messageStatusHandlers[kind] = fn;
}

function onInbound(fn) {
    inboundHandler = fn;
}

/**
 * Re-arm scheduling with exponential backoff.
 *
 * A disconnected instance must always keep trying — a permanent guard is what
 * left an account dead for hours under the old whatsapp-web.js code. But
 * calling connect() straight from the close handler creates a tight loop:
 * connect -> pairing fails -> 'close' -> connect. Measured at ~1400 calls in
 * 10s locally. So retry indefinitely, just never faster than the backoff.
 */
const reArm = new Map(); // instance -> { attempts, timer }
const REARM_BASE_MS = 5000;
const REARM_MAX_MS = 5 * 60 * 1000;

function scheduleReArm(instance) {
    const entry = reArm.get(instance) || { attempts: 0, timer: null };
    if (entry.timer) return; // one pending re-arm per instance

    const delay = Math.min(REARM_BASE_MS * Math.pow(2, entry.attempts), REARM_MAX_MS);
    entry.attempts += 1;
    entry.timer = setTimeout(() => {
        entry.timer = null;
        client.connect(instance).catch((err) => {
            console.error(`[evolution] re-arm failed for ${instance}: ${err.message}`);
        });
    }, delay);
    if (entry.timer.unref) entry.timer.unref();
    reArm.set(instance, entry);
    console.log(`[evolution] ${instance} offline — re-arm in ${delay / 1000}s (attempt ${entry.attempts})`);
}

/** Called once an instance reaches 'open' — clears the backoff. */
function clearReArm(instance) {
    const entry = reArm.get(instance);
    if (entry && entry.timer) clearTimeout(entry.timer);
    reArm.delete(instance);
}

const orgInstances = require('../orgInstances');

// Names are looked up, not computed: existing Evolution instances are still
// named after the pre-migration integer ids, so deriving a name from a UUID
// would point every org at an instance that does not exist.
function instanceNameForUser(orgId) { return orgInstances.nameFor(orgId); }
function instanceNameForSession(sessionId) { return `${API_PREFIX}${sessionId}`; }
function userIdFromInstance(name) {
    return orgInstances.orgFor(name);
}
function sessionIdFromInstance(name) {
    return name.startsWith(API_PREFIX) ? name.slice(API_PREFIX.length) : null;
}

/**
 * Evolution's ack numbers, mapped to the vocabulary already stored in
 * api_messages.status and sent to MolarPlus. Preserved exactly from the old
 * whatsapp-web.js mapping so the integration contract doesn't shift.
 */
function ackToStatus(ack) {
    switch (Number(ack)) {
        case -1: return 'failed';
        case 0:
        case 1: return 'sent';
        case 2: return 'delivered';
        case 3:
        case 4: return 'read';
        default: return null;
    }
}

/** Evolution sends either a numeric ack or a string status depending on event. */
function normalizeStatus(data) {
    if (data == null) return null;
    if (data.status != null && typeof data.status === 'string') {
        const s = data.status.toUpperCase();
        if (s === 'PENDING' || s === 'SERVER_ACK') return 'sent';
        if (s === 'DELIVERY_ACK') return 'delivered';
        if (s === 'READ' || s === 'PLAYED') return 'read';
        if (s === 'ERROR') return 'failed';
    }
    return ackToStatus(data.status ?? data.ack);
}

function extractMessageId(data) {
    return data?.keyId || data?.key?.id || data?.id || null;
}

function router() {
    const r = express.Router();

    r.post('/', express.json({ limit: '8mb' }), (req, res) => {
        // Evolution is on the internal network, but the shared secret means a
        // stray request from anywhere else is still rejected. The old code
        // verified no inbound webhooks at all.
        // Unconditional. This used to be `if (WEBHOOK_SECRET) {...}`, so an unset
        // or empty secret skipped the check entirely and left the webhook open.
        // config.js now refuses to boot in production without one.
        const provided = req.get('x-webhook-secret') || '';
        if (!WEBHOOK_SECRET || provided !== WEBHOOK_SECRET) return res.sendStatus(401);

        // Always 200 quickly — Evolution retries on failure and we don't want
        // a slow handler to stall its queue.
        res.sendStatus(200);

        try {
            handleEvent(req.body);
        } catch (err) {
            console.error('[evolution/webhook] handler error:', err.message);
        }
    });

    return r;
}

function handleEvent(body) {
    if (!body) return;
    const event = String(body.event || '').toLowerCase().replace(/_/g, '.');
    const instance = body.instance || body.instanceName;
    const data = body.data || {};
    if (!instance) return;

    switch (event) {
        case 'qrcode.updated': {
            // The raw `code` is what the frontend's <QRCodeSVG value={...}>
            // expects, so the existing UI contract survives untouched.
            const qr = data.qrcode || data;
            const code = qr.code || qr.pairingCode || '';
            state.update(instance, { isConnected: false, currentQR: code, lastEvent: 'qrcode.updated' });
            break;
        }

        case 'connection.update': {
            const conn = String(data.state || data.connection || '').toLowerCase();
            if (conn === 'open') {
                state.update(instance, {
                    isConnected: true,
                    currentQR: '',
                    phone: state.normalizeOwner(data.wuid || data.owner || data.number),
                    lastEvent: 'connection.open',
                });
                clearReArm(instance);
                console.log(`[evolution] ${instance} connected`);
            } else if (conn === 'close' || conn === 'closed') {
                state.update(instance, { isConnected: false, phone: null, lastEvent: 'connection.close' });
                scheduleReArm(instance);
            } else {
                // 'connecting' etc. — a pairing attempt is already in flight,
                // so update state but don't stack another re-arm on top.
                state.update(instance, { isConnected: false, lastEvent: `connection.${conn}` });
            }
            break;
        }

        case 'messages.upsert': {
            // Inbound only. Evolution echoes our own sends here too, and
            // processing those would create a feedback loop.
            const msgs = Array.isArray(data) ? data : (data.messages || [data]);
            for (const msg of msgs) {
                if (!msg || msg.key?.fromMe) continue;
                const userId = userIdFromInstance(instance);
                if (!userId) continue;
                try {
                    inboundHandler?.(userId, instance, normalizeInbound(msg));
                } catch (e) {
                    console.error('[evolution] inbound handler failed:', e.message);
                }
            }
            break;
        }

        case 'messages.update':
        case 'send.message': {
            const messageId = extractMessageId(data);
            const status = normalizeStatus(data);
            if (!messageId || !status) break;

            if (instance.startsWith(API_PREFIX)) {
                const sessionId = sessionIdFromInstance(instance);
                messageStatusHandlers.api?.(sessionId, messageId, status);
            } else if (instance.startsWith(USER_PREFIX)) {
                messageStatusHandlers.user?.(userIdFromInstance(instance), messageId, status);
            }
            break;
        }

        default:
            break;
    }
}

/**
 * Flatten Evolution's message envelope into the few fields we care about.
 * WhatsApp nests text in several places depending on message type, and button
 * replies carry the id we set when sending — which is what makes a reply
 * structured instead of guesswork.
 */
function normalizeInbound(msg) {
    const m = msg.message || {};
    const text =
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        '';

    const buttonId =
        m.buttonsResponseMessage?.selectedButtonId ||
        m.templateButtonReplyMessage?.selectedId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        null;

    const buttonText =
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.listResponseMessage?.title ||
        null;

    let mediaType = null;
    if (m.imageMessage) mediaType = 'image';
    else if (m.videoMessage) mediaType = 'video';
    else if (m.audioMessage) mediaType = 'audio';
    else if (m.documentMessage) mediaType = 'document';

    const pollVote = m.pollUpdateMessage ? (m.pollUpdateMessage.vote || null) : null;

    return {
        key: msg.key,
        messageId: msg.key?.id || null,
        from: String(msg.key?.remoteJid || '').split('@')[0].replace(/\D/g, ''),
        isGroup: String(msg.key?.remoteJid || '').endsWith('@g.us'),
        text: buttonText || text,
        buttonId,
        mediaType,
        pollVote,
        timestamp: msg.messageTimestamp || null,
    };
}

module.exports = {
    router,
    onMessageStatus,
    onInbound,
    normalizeInbound,
    instanceNameForUser,
    instanceNameForSession,
    userIdFromInstance,
    sessionIdFromInstance,
    ackToStatus,
    USER_PREFIX,
    API_PREFIX,
};
