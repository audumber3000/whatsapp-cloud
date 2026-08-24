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

/* ── main handler ─────────────────────────────────────────────────────────── */

let notify = () => {};
let emitInbound = () => {};
function wire({ notifyUser, emit }) {
    if (notifyUser) notify = notifyUser;
    if (emit) emitInbound = emit;
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

    emitInbound(userId, {
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

module.exports = { handle, wire, detectIntent };
