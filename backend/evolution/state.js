/**
 * Cached connection state, keyed by Evolution instance name.
 *
 * Why this exists: getStatus() is called synchronously from non-async contexts
 * (server.js — inside an object literal in the dashboard handler, and on socket
 * connect). Evolution's status is an HTTP call, so we keep a local mirror that
 * webhooks push into and reads never block on.
 *
 * Note what is NOT stored here: a client object. The old whatsapp-web.js code
 * kept live Client instances in a Map, and because the 'disconnected' handler
 * never removed the entry, initializeUserClient's `if (!clients.has(userId))`
 * guard could never rebuild it — one logout left an account dead until a human
 * re-scanned a QR. This module holds plain data only, so there is nothing that
 * can get wedged; reconnection is Evolution's job and re-arming is idempotent.
 */

const client = require('./client');

/** instanceName -> { isConnected, currentQR, phone, lastSeen, lastEvent } */
const cache = new Map();

const listeners = new Set();

const EMPTY = Object.freeze({ isConnected: false, currentQR: '', phone: null, lastSeen: null, lastEvent: null });

/** Synchronous read. Never touches the network. */
function get(instanceName) {
    return cache.get(instanceName) || EMPTY;
}

function has(instanceName) {
    return cache.has(instanceName);
}

function instances() {
    return Array.from(cache.keys());
}

/** Merge a partial update and notify listeners if anything actually changed. */
function update(instanceName, patch) {
    const prev = cache.get(instanceName) || { ...EMPTY };
    const next = { ...prev, ...patch, lastSeen: new Date().toISOString() };

    const changed =
        prev.isConnected !== next.isConnected ||
        prev.currentQR !== next.currentQR ||
        prev.phone !== next.phone;

    cache.set(instanceName, next);
    if (changed) {
        for (const fn of listeners) {
            try { fn(instanceName, next, prev); } catch (e) {
                console.error('[evolution/state] listener threw:', e.message);
            }
        }
    }
    return next;
}

function remove(instanceName) {
    cache.delete(instanceName);
}

/** Subscribe to state transitions. Returns an unsubscribe function. */
function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Seed the cache at boot from Evolution's own record of its instances.
 * Evolution persists sessions, so after a restart most instances come back
 * already connected and we simply learn about them here.
 */
async function seed() {
    let list;
    try {
        list = await client.fetchInstances();
    } catch (err) {
        console.error('[evolution/state] seed failed, starting cold:', err.message);
        return 0;
    }

    const rows = Array.isArray(list) ? list : (list?.instances || []);
    let n = 0;
    for (const row of rows) {
        // Evolution has moved this shape around between releases, so read defensively.
        const inst = row.instance || row;
        const name = inst.instanceName || inst.name;
        if (!name) continue;
        const state = inst.connectionStatus || inst.state || inst.status;
        update(name, {
            isConnected: state === 'open',
            currentQR: '',
            phone: normalizeOwner(inst.owner || inst.ownerJid || inst.number),
            lastEvent: 'seed',
        });
        n++;
    }
    console.log(`[evolution/state] seeded ${n} instance(s)`);
    return n;
}

/** '919876543210@s.whatsapp.net' -> '919876543210' */
function normalizeOwner(owner) {
    if (!owner) return null;
    return String(owner).split('@')[0].replace(/\D/g, '') || null;
}

/**
 * Safety net for missed webhooks. Webhooks are the primary signal; this just
 * corrects drift, so it runs infrequently.
 */
let reconcileTimer = null;
function startReconciler(intervalMs = 60000) {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(async () => {
        for (const name of instances()) {
            try {
                const res = await client.connectionState(name);
                const state = res?.instance?.state || res?.state;
                if (!state) continue;
                const isConnected = state === 'open';
                if (get(name).isConnected !== isConnected) {
                    console.log(`[evolution/state] reconciler corrected ${name}: -> ${state}`);
                    update(name, { isConnected, lastEvent: 'reconcile' });
                }
            } catch (err) {
                if (err.status === 404) remove(name);
            }
        }
    }, intervalMs);
    if (reconcileTimer.unref) reconcileTimer.unref();
}

function stopReconciler() {
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
}

module.exports = {
    get, has, instances, update, remove, onChange,
    seed, startReconciler, stopReconciler, normalizeOwner,
};
