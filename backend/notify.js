/**
 * Notifications — one place that decides whether an alert is sent.
 *
 * The Settings page has offered five events with an Email and a WhatsApp
 * toggle each. Nothing read those toggles: `notify_events` was written by the
 * settings route and consulted by nobody, so every switch on that page was
 * decorative. Two of the five events — send failures and new replies — had no
 * sender anywhere in the codebase at all, and a third (disconnected) had one
 * filed under a different name, so its toggle could never have matched.
 *
 * Everything that alerts a human now goes through dispatch() below.
 */

const db = require('./db');
const { sendEmail } = require('./email');

/**
 * What a workspace gets when it has never touched the settings page.
 *
 * `notify_events` defaults to '{}' in the schema, and treating "unset" as
 * "everything off" would silently stop the daily summaries and start alerts
 * that existing clinics already rely on. Unset means these defaults; only an
 * explicit save turns something off.
 */
const DEFAULTS = {
    daily_summary: { email: true, whatsapp: true },
    start_alert: { email: true, whatsapp: true },
    send_failure: { email: true, whatsapp: false },
    disconnected: { email: true, whatsapp: true },
    // Off by default: a busy clinic gets dozens a day, and they are already
    // visible in the Inbox.
    new_reply: { email: false, whatsapp: false },
};

/** Some events would otherwise fire per message. One per org per window. */
const THROTTLE_MS = { send_failure: 60 * 60 * 1000, disconnected: 30 * 60 * 1000 };
const lastSent = new Map();

function throttled(orgId, event) {
    const window = THROTTLE_MS[event];
    if (!window) return false;
    const key = `${orgId}:${event}`;
    const prev = lastSent.get(key) || 0;
    if (Date.now() - prev < window) return true;
    lastSent.set(key, Date.now());
    return false;
}

const dbGet = (sql, p = []) => new Promise((res) => db.get(sql, p, (e, r) => res(e ? null : r)));
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function logNotification(orgId, type, category, recipient, content, status) {
    db.run(
        `INSERT INTO notification_logs (org_id, type, category, recipient, content, status, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [orgId, type, category, recipient, String(content || '').slice(0, 2000), status],
        (e) => { if (e) console.error('[notify] could not log:', e.message); });
}

/**
 * Send one alert, honouring the workspace's preferences.
 *
 * `sendWhatsApp` is injected rather than required, because whatsapp.js requires
 * the modules that call this — requiring it back would close a cycle.
 */
async function dispatch(orgId, event, { subject, body, sendWhatsApp }) {
    try {
        if (!DEFAULTS[event]) {
            console.error(`[notify] unknown event "${event}" — nothing sent`);
            return;
        }
        if (throttled(orgId, event)) return;

        const org = await dbGet(
            'SELECT notify_emails, notify_whatsapp, notify_events FROM organisations WHERE id = ?', [orgId]);
        if (!org) return;

        const saved = org.notify_events && typeof org.notify_events === 'object' ? org.notify_events : {};
        // An explicit save wins; anything never saved falls back to the default.
        const pref = saved[event] || DEFAULTS[event];

        if (pref.whatsapp && typeof sendWhatsApp === 'function') {
            for (const num of split(org.notify_whatsapp)) {
                const ok = await sendWhatsApp(orgId, num, body).catch(() => false);
                logNotification(orgId, 'whatsapp', event, num, body, ok ? 'sent' : 'failed');
            }
        }
        if (pref.email) {
            for (const addr of split(org.notify_emails)) {
                const ok = await sendEmail(addr, subject, body).catch(() => false);
                logNotification(orgId, 'email', event, addr, body, ok ? 'sent' : 'failed');
            }
        }
    } catch (e) {
        // An alert failing must never take down whatever was being reported.
        console.error(`[notify] ${event} failed:`, e.message);
    }
}

module.exports = { dispatch, DEFAULTS, logNotification };
