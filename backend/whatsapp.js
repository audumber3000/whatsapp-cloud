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

let io = null;

const setIo = (socketIo) => {
    io = socketIo;

    // Push status to the browser whenever the cached state actually changes.
    // Previously each whatsapp-web.js event handler called emitStatus itself;
    // now the cache is the single source of truth and this is the only emitter.
    state.onChange((instanceName, next) => {
        const userId = hooks.userIdFromInstance(instanceName);
        if (userId == null || Number.isNaN(userId)) return;
        emitStatus(userId);
    });
};

const emitStatus = (userId) => {
    const status = getStatus(userId);
    if (!io) {
        console.log(`[WA] io not ready, skipping emit for user ${userId}`);
        return;
    }
    io.to(`user_${userId}`).emit('wa_status', status);
};

/**
 * Synchronous by contract — server.js reads this inside a plain object literal
 * in the dashboard handler and on socket connect. Backed by the local cache,
 * so it never blocks on Evolution.
 */
const getStatus = (userId) => {
    const s = state.get(hooks.instanceNameForUser(userId));
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
        await client.sendText(instance, phone, message);
        console.log(`Message sent to ${phone} by user ${userId}`);
        return true;
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
        await client.sendMedia(instance, phone, { media, mimetype, fileName: filename, caption });
        console.log(`Media sent to ${phone} by user ${userId}`);
        return true;
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

const notifyUser = (userId, type, message) => {
    if (!io) return;
    io.to(`user_${userId}`).emit('notification', {
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
const bootAll = async (userIds = []) => {
    await state.seed();
    for (const id of userIds) initializeUserClient(id);
    state.startReconciler();
};

module.exports = {
    sendMessage,
    sendMedia,
    disconnectClient,
    setIo,
    getStatus,
    initializeUserClient,
    notifyUser,
    bootAll,
};
