/**
 * Outbound webhooks — telling other products what happened.
 *
 * Until now nothing flowed back out of WA Reach. An integrator could send a
 * message and then had to poll GET /messages and diff it to learn anything,
 * which in practice means they learn nothing: a patient tapping "Cancel" never
 * reached the system that booked the appointment.
 *
 * Events carry enough context to act on without a follow-up lookup, are signed
 * so the receiver can trust them, and are retried with backoff because the
 * receiver being briefly down must not lose a cancellation.
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const db = require('./db');

const EVENTS = [
    'message.sent',       // handed to WhatsApp
    'message.delivered',  // two ticks
    'message.read',       // blue ticks
    'message.failed',     // never left
    'message.replied',    // the patient wrote back, with the parsed intent
    'contact.opted_out',  // stop honouring this number
];

/* ── SSRF ───────────────────────────────────────────────────────────────── */

/**
 * A webhook URL is attacker-controlled input that makes THIS server issue a
 * request. Without this check, an endpoint of http://169.254.169.254/ turns the
 * feature into a cloud-metadata credential reader, and http://localhost:5434
 * into a port scanner of our own network.
 *
 * Resolved at delivery time as well as on save, because DNS can be re-pointed
 * at a private address after the URL passes validation.
 */
const BLOCKED_V4 = [
    [10, 8], [127, 8], [169, 16], [172, 12], [192, 16], [0, 8], [100, 10],
];

function isPrivateAddress(ip) {
    if (net.isIPv6(ip)) {
        const low = ip.toLowerCase();
        // loopback, link-local, unique-local, and v4-mapped forms of the above
        if (low === '::1' || low === '::') return true;
        if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
        const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateAddress(mapped[1]);
        return false;
    }
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;               // cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;  // carrier NAT
    return false;
}

async function validateUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return { ok: false, error: 'That is not a valid URL' }; }
    if (!['http:', 'https:'].includes(u.protocol)) {
        return { ok: false, error: 'A webhook URL must be http or https' };
    }
    if (u.protocol === 'http:' && process.env.NODE_ENV === 'production') {
        return { ok: false, error: 'Use https — a webhook carries patient data' };
    }

    let addrs;
    try {
        addrs = await dns.lookup(u.hostname, { all: true });
    } catch {
        return { ok: false, error: 'That hostname does not resolve' };
    }

    /**
     * The development escape hatch permits LOOPBACK ONLY.
     *
     * It first waived the whole private-address check, which meant
     * http://169.254.169.254/ — the cloud metadata endpoint — was accepted, and
     * so was the entire RFC1918 range. A flag whose purpose is "let me point at
     * a receiver on this laptop" must not also unlock the internal network.
     */
    const allowLoopback = process.env.NODE_ENV !== 'production'
        && process.env.WEBHOOK_ALLOW_LOCAL === '1';

    const bad = addrs.filter((a) => isPrivateAddress(a.address));
    if (bad.length) {
        const loopbackOnly = bad.every((a) => a.address === '127.0.0.1' || a.address === '::1');
        if (!(allowLoopback && loopbackOnly)) {
            return { ok: false, error: 'That host resolves to a private address' };
        }
    }
    return { ok: true, url: u.toString() };
}

/* ── signing ────────────────────────────────────────────────────────────── */

/**
 * `sha256=HMAC(secret, timestamp + "." + body)`.
 *
 * The timestamp is inside the signed material, so a captured delivery cannot be
 * replayed later — the receiver rejects anything older than its tolerance and
 * the attacker cannot re-sign a fresh timestamp.
 */
function sign(secret, timestamp, body) {
    return 'sha256=' + crypto.createHmac('sha256', secret)
        .update(`${timestamp}.${body}`).digest('hex');
}

/* ── queueing ───────────────────────────────────────────────────────────── */

/**
 * Queue an event for every endpoint that wants it.
 *
 * Never throws: a webhook failing must not roll back the thing it is reporting.
 * A patient's reply is recorded whether or not anyone can be told about it.
 */
async function emit(orgId, event, payload) {
    try {
        if (!EVENTS.includes(event)) {
            console.error(`[webhooks] unknown event "${event}" — not queued`);
            return;
        }
        const endpoints = await db.many(
            `SELECT id, events FROM webhook_endpoints
              WHERE org_id = ? AND active = TRUE`, [orgId]);
        if (!endpoints.length) return;

        const body = {
            event,
            occurred_at: new Date().toISOString(),
            org_id: orgId,
            data: payload,
        };

        for (const ep of endpoints) {
            const wanted = Array.isArray(ep.events) ? ep.events : [];
            // An empty subscription list means "everything", so adding a new
            // event type does not silently skip existing endpoints.
            if (wanted.length && !wanted.includes(event)) continue;
            await db.query(
                `INSERT INTO webhook_deliveries (endpoint_id, org_id, event, payload)
                 VALUES (?, ?, ?, ?)`,
                [ep.id, orgId, event, JSON.stringify(body)]);
        }
    } catch (e) {
        console.error(`[webhooks] could not queue ${event}:`, e.message);
    }
}

/* ── delivery ───────────────────────────────────────────────────────────── */

// Backoff: a receiver that is down for an hour still gets the cancellation.
const BACKOFF_MIN = [1, 5, 30, 120, 360];
const MAX_ATTEMPTS = BACKOFF_MIN.length;
// A permanently dead endpoint should stop consuming the queue and say so.
const DISABLE_AFTER = 20;

async function deliverOne(row) {
    const ep = await db.one('SELECT * FROM webhook_endpoints WHERE id = ?', [row.endpoint_id]);
    if (!ep || !ep.active) {
        await db.query(
            `UPDATE webhook_deliveries SET status = 'failed', error = 'endpoint is inactive' WHERE id = ?`,
            [row.id]);
        return;
    }

    // Re-validated per delivery: DNS can be re-pointed at a private address
    // after the URL was accepted.
    const check = await validateUrl(ep.url);
    if (!check.ok) {
        await db.query(
            `UPDATE webhook_deliveries SET status = 'failed', error = ? WHERE id = ?`,
            [`refused: ${check.error}`, row.id]);
        return;
    }

    const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const attempts = row.attempts + 1;

    let status = null;
    let error = null;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(check.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'WAReach-Webhook/1',
                'X-WAReach-Event': row.event,
                'X-WAReach-Delivery': String(row.id),
                'X-WAReach-Timestamp': timestamp,
                'X-WAReach-Signature': sign(ep.secret, timestamp, body),
            },
            body,
            signal: controller.signal,
            redirect: 'error',   // a redirect could land on a private address
        });
        clearTimeout(timer);
        status = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) {
        error = e.name === 'AbortError' ? 'timed out after 10s' : e.message;
    }

    if (!error) {
        await db.query(
            `UPDATE webhook_deliveries
                SET status = 'delivered', attempts = ?, response_status = ?, delivered_at = NOW(), error = NULL
              WHERE id = ?`, [attempts, status, row.id]);
        await db.query(
            `UPDATE webhook_endpoints
                SET last_success_at = NOW(), consecutive_fails = 0, last_error = NULL, updated_at = NOW()
              WHERE id = ?`, [ep.id]);
        return;
    }

    const exhausted = attempts >= MAX_ATTEMPTS;
    const nextIn = BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length - 1)];
    await db.query(
        `UPDATE webhook_deliveries
            SET status = ?, attempts = ?, response_status = ?, error = ?,
                next_attempt_at = NOW() + (? || ' minutes')::interval
          WHERE id = ?`,
        [exhausted ? 'failed' : 'pending', attempts, status, String(error).slice(0, 300), nextIn, row.id]);

    const fails = await db.one(
        `UPDATE webhook_endpoints
            SET last_failure_at = NOW(), last_error = ?, consecutive_fails = consecutive_fails + 1,
                updated_at = NOW()
          WHERE id = ? RETURNING consecutive_fails`,
        [String(error).slice(0, 300), ep.id]);

    if (fails && fails.consecutive_fails >= DISABLE_AFTER) {
        await db.query('UPDATE webhook_endpoints SET active = FALSE WHERE id = ?', [ep.id]);
        console.error(`[webhooks] disabled ${ep.name} after ${DISABLE_AFTER} consecutive failures`);
        require('./notify').dispatch(ep.org_id, 'disconnected', {
            subject: 'WA Reach: a webhook endpoint was disabled',
            body: `"${ep.name}" failed ${DISABLE_AFTER} times in a row and has been switched off.\n\n`
                + `Last error: ${error}\n\nRe-enable it in Settings once the receiver is healthy.`,
            sendWhatsApp: null,
        }).catch(() => {});
    }
}

/** Called from the scheduler tick. Bounded per pass so one org cannot hog it. */
async function processDue() {
    try {
        const due = await db.many(
            `SELECT id, endpoint_id, event, payload, attempts
               FROM webhook_deliveries
              WHERE status = 'pending' AND next_attempt_at <= NOW()
              ORDER BY next_attempt_at LIMIT 50`);
        // Sequential on purpose: fifty simultaneous outbound requests from the
        // same box is itself a way to look like an attacker.
        for (const row of due) await deliverOne(row).catch((e) =>
            console.error('[webhooks] delivery failed:', e.message));
    } catch (e) {
        console.error('[webhooks] sweep failed:', e.message);
    }
}

module.exports = { emit, processDue, validateUrl, sign, EVENTS, isPrivateAddress };
