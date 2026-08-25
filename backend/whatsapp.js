/**
 * Per-user WhatsApp sessions, backed by Evolution API.
 *
 * Replaces the whatsapp-web.js implementation. The export surface is unchanged
 * so every call site in server.js and scheduler.js keeps working as-is; only
 * the transport underneath is different. There is no Chromium here.
 *
 * Instance naming: wareach_user_<userId>
 */

const fs = require('fs');
const client = require('./evolution/client');
const state = require('./evolution/state');
const hooks = require('./evolution/webhook');
const inbound = require('./inbound');
const db = require('./db');

let io = null;

const setIo = (socketIo) => {
    io = socketIo;

    // Push status to the browser whenever the cached state actually changes.
    // Previously each whatsapp-web.js event handler called emitStatus itself;
    // now the cache is the single source of truth and this is the only emitter.
    state.onChange((instanceName, next) => {
        const userId = hooks.userIdFromInstance(instanceName);
        if (!userId) return;
        emitStatus(userId);
    });
};

const emitStatus = (userId) => {
    const status = getStatus(userId);
    if (!io) {
        console.log(`[WA] io not ready, skipping emit for user ${userId}`);
        return;
    }
    io.to(`org_${userId}`).emit('wa_status', status);
};

/**
 * Synchronous by contract — server.js reads this inside a plain object literal
 * in the dashboard handler and on socket connect. Backed by the local cache,
 * so it never blocks on Evolution.
 */
const getStatus = (userId) => {
    const name = hooks.instanceNameForUser(userId);
    if (!name) return { isConnected: false, currentQR: '', phone: null };
    const s = state.get(name);
    return {
        isConnected: s.isConnected,
        currentQR: s.currentQR || '',
        phone: s.phone || null,
    };
};

/**
 * Fire-and-forget, as before. Evolution persists instances, so this is
 * idempotent: it creates the instance only if Evolution doesn't have it, then
 * asks it to pair if it isn't already connected.
 */
const initializeUserClient = (userId) => {
    const instance = hooks.instanceNameForUser(userId);
    (async () => {
        try {
            const { created } = await client.ensureInstance(instance);
            if (created) console.log(`[WA User ${userId}] instance created`);

            const res = await client.connectionState(instance).catch(() => null);
            const connected = (res?.instance?.state || res?.state) === 'open';
            state.update(instance, { isConnected: connected, lastEvent: 'init' });

            if (!connected) {
                // Triggers a qrcode.updated webhook, which populates the QR.
                await client.connect(instance);
            }
        } catch (err) {
            console.error(`[WA User ${userId}] initialize failed:`, err.message);
            state.update(instance, { isConnected: false, lastEvent: 'init-failed' });
        }
    })();
};

const sendMessage = async (userId, phone, message) => {
    const instance = hooks.instanceNameForUser(userId);
    if (!state.get(instance).isConnected) {
        console.error(`[WA] User ${userId} is not connected to WhatsApp`);
        return false;
    }
    try {
        const res = await client.sendText(instance, phone, message);
        console.log(`Message sent to ${phone} by user ${userId}`);
        return res?.key?.id || true;
    } catch (error) {
        console.error(`Error sending message for user ${userId}:`, error.message);
        return false;
    }
};

const sendMedia = async (userId, phone, { filePath, mimetype, filename, caption = '' }) => {
    const instance = hooks.instanceNameForUser(userId);
    if (!state.get(instance).isConnected) {
        console.error(`[WA] User ${userId} is not connected to WhatsApp`);
        return false;
    }
    if (!filePath || !fs.existsSync(filePath)) {
        console.error(`[WA] Media file missing for user ${userId}: ${filePath}`);
        return false;
    }
    try {
        const media = fs.readFileSync(filePath).toString('base64');
        const res = await client.sendMedia(instance, phone, { media, mimetype, fileName: filename, caption });
        console.log(`Media sent to ${phone} by user ${userId}`);
        return res?.key?.id || true;
    } catch (error) {
        console.error(`Error sending media for user ${userId}:`, error.message);
        return false;
    }
};

/**
 * "Disconnect" has always meant "unpair and show me a fresh QR", so it still
 * tears the instance down and immediately rebuilds it.
 */
const disconnectClient = async (userId) => {
    const instance = hooks.instanceNameForUser(userId);
    try {
        state.update(instance, { isConnected: false, currentQR: '', phone: null, lastEvent: 'manual-disconnect' });

        try { await client.logout(instance); } catch (e) { console.log('logout skipped:', e.message); }
        try { await client.deleteInstance(instance); } catch (e) { console.log('delete skipped:', e.message); }

        state.remove(instance);

        await client.createInstance(instance);
        await client.connect(instance);
        return true;
    } catch (error) {
        console.error(`[WA User ${userId}] disconnect failed:`, error.message);
        return false;
    }
};

/**
 * A reminder with tappable Confirm / Reschedule / Cancel.
 * The button id comes back on the reply, so the response is structured
 * instead of free text we have to interpret.
 */
const sendConfirmation = async (userId, phone, { title, body, footer = '' }) => {
    const instance = hooks.instanceNameForUser(userId);
    if (!state.get(instance).isConnected) {
        console.error(`[WA] User ${userId} is not connected to WhatsApp`);
        return false;
    }
    try {
        const res = await client.sendButtons(instance, phone, {
            title, description: body, footer,
            buttons: [
                { id: 'confirm',    text: 'Confirm' },
                { id: 'reschedule', text: 'Reschedule' },
                { id: 'cancel',     text: 'Cancel' },
            ],
        });
        return res?.key?.id || true;
    } catch (error) {
        console.error(`Error sending confirmation for user ${userId}:`, error.message);
        return false;
    }
};

/** Post-visit feedback as a native poll rather than a link nobody opens. */
const sendFeedbackPoll = async (userId, phone, question, options) => {
    const instance = hooks.instanceNameForUser(userId);
    if (!state.get(instance).isConnected) return false;
    try {
        const res = await client.sendPoll(instance, phone, { name: question, values: options });
        return res?.key?.id || true;
    } catch (error) {
        console.error(`Error sending poll for user ${userId}:`, error.message);
        return false;
    }
};

/**
 * Which of these numbers are on WhatsApp. Results are cached on the contact so
 * we don't re-probe, and bad rows get flagged instead of silently burning sends.
 */
const validateNumbers = async (userId, numbers) => {
    const instance = hooks.instanceNameForUser(userId);
    if (!state.get(instance).isConnected) return null;
    try {
        const res = await client.checkNumbers(instance, numbers);
        const rows = Array.isArray(res) ? res : (res?.numbers || []);
        for (const r of rows) {
            const num = String(r.number || r.jid || '').split('@')[0].replace(/\D/g, '');
            const ok = r.exists === true || r.exists === 'true';
            if (!num) continue;
            db.run(
                'UPDATE contacts SET wa_valid = ?, wa_checked_at = NOW() WHERE org_id = ? AND phone = ?',
                [!!ok, userId, num]
            );
        }
        return rows;
    } catch (error) {
        console.error(`Number validation failed for user ${userId}:`, error.message);
        return null;
    }
};

/** Show "typing…" before a send, so automation reads as a person. */
const showTyping = async (userId, phone, ms = 1500) => {
    const instance = hooks.instanceNameForUser(userId);
    if (!state.get(instance).isConnected) return false;
    return client.sendPresence(instance, phone, { presence: 'composing', delay: ms })
        .then(() => true).catch(() => false);
};

/**
 * Send media straight from a URL. Evolution fetches it itself, so the bytes
 * never pass through this process — which also keeps the old SSRF surface from
 * MessageMedia.fromUrl() out of the API path.
 */
const sendMediaByUrl = async (userId, phone, { url, caption = '', filename, mimetype = '' }) => {
    const instance = hooks.instanceNameForUser(userId);
    if (!state.get(instance).isConnected) {
        console.error(`[WA] User ${userId} is not connected to WhatsApp`);
        return false;
    }
    try {
        const res = await client.sendMedia(instance, phone, {
            media: url, mimetype, fileName: filename || 'attachment', caption,
        });
        return res?.key?.id || true;
    } catch (error) {
        console.error(`Error sending media URL for user ${userId}:`, error.message);
        return false;
    }
};

const notifyUser = (userId, type, message) => {
    if (!io) return;
    io.to(`org_${userId}`).emit('notification', {
        type,
        message,
        timestamp: new Date().toISOString(),
    });
};

/**
 * Boot: learn what Evolution already has, then make sure every user has an
 * instance. No staggering — that only existed to stop simultaneous Chromium
 * launches from exhausting the box.
 */
// Inbound replies land here. Wired once, at module load.
inbound.wire({
    notifyUser: (uid, type, message) => notifyUser(uid, type, message),
    emit: (uid, payload) => {
        if (!io) return;
        // Everyone sharing the number sees the reply land, not just whoever
        // happened to open it first.
        io.to(`org_${uid}`).emit('inbound_message', payload);
    },
});
hooks.onInbound((userId, instance, msg) => inbound.handle(userId, instance, msg));

// Real delivery receipts. Until now the UI showed "delivered" for anything we
// had merely handed to WhatsApp; this records what actually happened.
hooks.onMessageStatus('user', (userId, messageId, status) => {
    db.run(
        `UPDATE automation_logs
         SET delivery_status = ?,
             delivered_at = CASE WHEN ? IN ('delivered','read') THEN NOW() ELSE delivered_at END
         WHERE wa_message_id = ?`,
        [status, status, messageId]
    );
});

const bootAll = async (userIds = []) => {
    await state.seed();
    for (const id of userIds) initializeUserClient(id);
    state.startReconciler();
};

/** Fan an event out to everyone sharing this org's number. */
const emitToOrg = (orgId, event, payload) => {
    if (!io) return;
    io.to(`org_${orgId}`).emit(event, payload);
};

module.exports = {
    emitToOrg,
    sendMessage,
    sendMedia,
    disconnectClient,
    setIo,
    getStatus,
    initializeUserClient,
    notifyUser,
    bootAll,
    sendConfirmation,
    sendFeedbackPoll,
    validateNumbers,
    showTyping,
    sendMediaByUrl,
};
