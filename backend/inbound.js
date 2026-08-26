/**
 * Inbound message handling.
 *
 * Before Evolution nothing in this app read a reply — there was no `message`
 * listener anywhere, so a patient answering a reminder was talking into a void.
 * This is where replies become state: opt-outs, appointment confirmations and
 * media the clinic actually wants.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const client = require('./evolution/client');

const MEDIA_DIR = path.join(__dirname, 'uploads', 'media');

const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

/* ── intent ───────────────────────────────────────────────────────────────── */

// Opt-out words in the languages these clinics actually serve. Matched on the
// whole message so "stop by tomorrow" doesn't unsubscribe anyone.
const OPT_OUT = [
    'stop', 'unsubscribe', 'opt out', 'optout', 'remove me',
    'band karo', 'बंद', 'बंद करा', 'मत भेजो', 'नको',
];

const CONFIRM = ['1', 'yes', 'y', 'confirm', 'confirmed', 'ok', 'okay', 'haan', 'हो', 'हाँ', 'ठीक'];
const RESCHEDULE = ['2', 'reschedule', 'change', 'postpone', 'later'];
const CANCEL = ['3', 'cancel', 'no', 'not coming'];

function detectIntent({ text, buttonId }) {
    // A button reply carries the id we set when sending — no guessing.
    if (buttonId) {
        const id = String(buttonId).toLowerCase();
        if (id.includes('confirm')) return 'confirm';
        if (id.includes('reschedule')) return 'reschedule';
        if (id.includes('cancel')) return 'cancel';
        if (id.includes('stop') || id.includes('optout')) return 'opt_out';
        return id;
    }

    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (OPT_OUT.some((w) => t === w || t.startsWith(w + ' ') || t === w + '.')) return 'opt_out';
    if (CONFIRM.includes(t)) return 'confirm';
    if (RESCHEDULE.includes(t)) return 'reschedule';
    if (CANCEL.includes(t)) return 'cancel';
    return 'message';
}

/* ── media ────────────────────────────────────────────────────────────────── */

const EXT = { image: '.jpg', video: '.mp4', audio: '.ogg', document: '.pdf' };

/**
 * Patients send photos of teeth, X-rays and old prescriptions. Pull the bytes
 * down and file them so the clinic can actually see them.
 */
async function saveInboundMedia(instance, msg) {
    try {
        const res = await client.downloadMedia(instance, msg.key);
        const b64 = res?.base64 || res?.media || null;
        if (!b64) return null;

        fs.mkdirSync(MEDIA_DIR, { recursive: true });
        const name = `in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${EXT[msg.mediaType] || ''}`;
        fs.writeFileSync(path.join(MEDIA_DIR, name), Buffer.from(b64, 'base64'));
        return name;
    } catch (e) {
        console.error(`[inbound] media download failed: ${e.message}`);
        return null;
    }
}


/* ── away message ─────────────────────────────────────────────────────────── */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Is the clinic open right now, in its own timezone?
 *
 * Read in the org's zone rather than the server's: a box in UTC would put a
 * Mumbai clinic's 9:30am opening at 4am and auto-reply to every morning
 * message as though nobody were there.
 */
function isOpenNow(hours, timezone) {
    if (!hours || typeof hours !== 'object') return true;   // unset means always open
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: timezone || 'Asia/Kolkata',
            weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(new Date());
        const get = (t) => parts.find((p) => p.type === t)?.value || '';
        const day = DAY_KEYS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))];
        const win = hours[day];
        if (!win || !win.open || !win.close) return false;   // closed today
        const now = `${get('hour').padStart(2, '0')}:${get('minute')}`;
        return now >= win.open && now < win.close;
    } catch (e) {
        // A bad timezone must not silently turn the clinic "closed" and start
        // auto-replying to everyone.
        console.error('[away] could not read business hours:', e.message);
        return true;
    }
}

/**
 * Reply once per conversation per day, not once per message — a patient
 * sending three lines should not get three identical auto-replies.
 */
async function maybeSendAway(orgId, conversation, phone) {
    if (!conversation) return;
    try {
        const org = await dbGet(
            'SELECT away_enabled, away_message, business_hours, timezone FROM organisations WHERE id = ?',
            [orgId]);
        if (!org?.away_enabled || !org.away_message) return;
        if (isOpenNow(org.business_hours, org.timezone)) return;

        const fresh = await dbGet(
            `SELECT away_sent_at FROM conversations WHERE id = ?`, [conversation.id]);
        if (fresh?.away_sent_at && (Date.now() - new Date(fresh.away_sent_at).getTime()) < 24 * 60 * 60 * 1000) return;

        const sent = await hooks.sendAway(orgId, phone, org.away_message);
        if (sent) {
            await dbRun('UPDATE conversations SET away_sent_at = NOW() WHERE id = ?', [conversation.id]);
        }
    } catch (e) {
        console.error('[away] failed:', e.message);
    }
}

/* ── main handler ─────────────────────────────────────────────────────────── */

let notify = () => {};
let emitInbound = () => {};
// whatsapp.js requires this module, so the sender is injected rather than
// required back — otherwise the two would form a cycle.
const hooks = { sendAway: async () => false };
function wire({ notifyUser, emit, sendAway }) {
    if (notifyUser) notify = notifyUser;
    if (emit) emitInbound = emit;
    if (sendAway) hooks.sendAway = sendAway;
}

async function handle(userId, instance, msg) {
    // Group traffic isn't part of the product yet and would pollute the inbox.
    if (msg.isGroup || !msg.from) return;

    const intent = detectIntent(msg);

    let contact = await dbGet(
        'SELECT id, name, opted_out FROM contacts WHERE org_id = ? AND phone = ?',
        [userId, msg.from]
    );
    // Someone messaging in who isn't on the list is still worth capturing.
    if (!contact) {
        const r = await dbRun(
            'INSERT INTO contacts (org_id, name, phone) VALUES (?, ?, ?) ON CONFLICT (org_id, phone) DO NOTHING',
            [userId, 'Unknown', msg.from]
        ).catch(() => null);
        if (r && r.lastID) contact = { id: r.lastID, name: 'Unknown', opted_out: 0 };
    }

    let mediaPath = null;
    if (msg.mediaType) mediaPath = await saveInboundMedia(instance, msg);

    await dbRun(
        `INSERT INTO inbound_messages
         (org_id, contact_id, from_number, wa_message_id, body, media_type, media_path, intent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (wa_message_id) DO NOTHING`,
        [userId, contact?.id || null, msg.from, msg.messageId, msg.text || '',
         msg.mediaType || null, mediaPath, intent]
    ).catch((e) => console.error('[inbound] insert failed:', e.message));

    // Opt-out is a hard stop — honour it immediately and permanently.
    if (intent === 'opt_out' && contact) {
        await dbRun(
            'UPDATE contacts SET opted_out = TRUE, opted_out_at = NOW() WHERE id = ?',
            [contact.id]
        ).catch(() => {});
        // Cancel anything already queued for them.
        await dbRun(
            `UPDATE automation_logs SET status = 'cancelled', error_reason = 'Contact opted out'
             WHERE contact_id = ? AND status = 'pending'`,
            [contact.id]
        ).catch(() => {});
        notify(userId, 'warning', `${contact.name || msg.from} opted out of messages`);
        console.log(`[inbound] user ${userId}: ${msg.from} opted out`);
    }

    // Tie a confirmation back to the reminder it answers — the most recent
    // message actually delivered to this contact.
    if (['confirm', 'reschedule', 'cancel'].includes(intent) && contact) {
        await dbRun(
            `UPDATE automation_logs SET response = ?, responded_at = NOW()
             WHERE id = (
                SELECT id FROM automation_logs
                WHERE contact_id = ? AND status IN ('delivered','sent','read')
                ORDER BY sent_time DESC LIMIT 1
             )`,
            [intent, contact.id]
        ).catch(() => {});
        notify(userId, intent === 'confirm' ? 'success' : 'info',
            `${contact.name || msg.from} replied: ${intent}`);
    }

    // The conversation is the unit the team works on: it is what gets assigned,
    // labelled and resolved. A reply re-opens it and resets the SLA clock, so
    // "first response" measures this exchange rather than the whole history.
    let conversation = null;
    if (contact) {
        conversation = await dbGet(
            `INSERT INTO conversations
               (org_id, contact_id, last_inbound_at, last_message_at, unread_count, status)
             VALUES (?, ?, NOW(), NOW(), 1, 'open')
             ON CONFLICT (org_id, contact_id) DO UPDATE
               SET last_inbound_at   = NOW(),
                   last_message_at   = NOW(),
                   unread_count      = conversations.unread_count + 1,
                   status            = CASE WHEN conversations.status = 'resolved'
                                            THEN 'open' ELSE conversations.status END,
                   resolved_at       = NULL,
                   resolved_by       = NULL,
                   first_response_at = NULL,
                   updated_at        = NOW()
             RETURNING id, status, assignee_id, unread_count`,
            [userId, contact.id]
        ).catch((e) => { console.error('[inbound] conversation upsert failed:', e.message); return null; });
    }

    // Outside business hours, say so rather than leaving them wondering.
    await maybeSendAway(userId, conversation, msg.from);

    // "New reply" is offered on the Settings page and had no sender anywhere —
    // the toggle could never have done anything. Off by default, because a busy
    // clinic would get dozens a day and they are already visible in the Inbox.
    if (intent !== 'opt_out') {
        const who = contact?.name && contact.name !== 'Unknown' ? contact.name : `+${msg.from}`;
        const preview = (msg.text || `[${msg.mediaType || 'message'}]`).slice(0, 300);
        await require('./notify').dispatch(userId, 'new_reply', {
            subject: `New WhatsApp reply from ${who}`,
            body: `${who} replied:\n\n"${preview}"\n\nOpen the Inbox to answer.`,
            sendWhatsApp: hooks.sendAway,
        }).catch(() => {});
    }

    emitInbound(userId, {
        conversation_id: conversation?.id || null,
        contact_id: contact?.id || null,
        name: contact?.name || null,
        from: msg.from,
        body: msg.text || '',
        intent,
        media_type: msg.mediaType || null,
        received_at: new Date().toISOString(),
    });

    // Blue ticks: the patient can see the clinic read it.
    client.markAsRead(instance, [{ remoteJid: msg.key.remoteJid, fromMe: false, id: msg.messageId }])
        .catch(() => {});
}

module.exports = { handle, wire, detectIntent, isOpenNow };
