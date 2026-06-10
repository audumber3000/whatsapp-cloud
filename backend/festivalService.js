// Shared festival logic used by both the HTTP routes and the scheduler:
// fetch a clinic's brand kit, render the branded image, and publish it.

const db = require('./db');
const { generateFestivalImage } = require('./imageGenerator');
const { postImageStatus, sendImage } = require('./whatsapp');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getBrandKit(userId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM brand_kits WHERE user_id = ?', [userId], (err, row) => err ? reject(err) : resolve(row || null));
    });
}

function getFestival(festivalId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM festivals WHERE id = ?', [festivalId], (err, row) => err ? reject(err) : resolve(row || null));
    });
}

function getUserContacts(userId) {
    return new Promise((resolve, reject) => {
        db.all('SELECT phone FROM contacts WHERE user_id = ?', [userId], (err, rows) => err ? reject(err) : resolve((rows || []).map(r => r.phone)));
    });
}

// Render the branded festival PNG for a clinic. Throws if no brand kit yet.
async function renderForUser(userId, festival) {
    const brand = await getBrandKit(userId);
    if (!brand) {
        const e = new Error('NO_BRAND_KIT');
        e.code = 'NO_BRAND_KIT';
        throw e;
    }
    const buf = await generateFestivalImage(brand, festival);
    return { buf, brand };
}

function buildCaption(festival, brand) {
    const parts = [];
    if (festival.greeting) parts.push(festival.greeting);
    if (brand && brand.clinic_name) parts.push(`— ${brand.clinic_name}`);
    return parts.join('\n\n').trim();
}

/**
 * Render + publish a festival image for one clinic.
 * @param {number} userId
 * @param {object} festival  festivals row
 * @param {object} opts      { toStatus, toContacts }
 * @returns {Promise<{ok:boolean, channels:string[], error?:string}>}
 */
async function postFestivalForUser(userId, festival, opts = {}) {
    const { toStatus = true, toContacts = false } = opts;
    let brand, buf;
    try {
        ({ buf, brand } = await renderForUser(userId, festival));
    } catch (e) {
        return { ok: false, channels: [], error: e.code === 'NO_BRAND_KIT' ? 'No brand kit configured' : e.message };
    }

    const caption = buildCaption(festival, brand);
    const channels = [];
    let ok = false;

    if (toStatus) {
        const s = await postImageStatus(userId, buf, caption);
        if (s) { ok = true; channels.push('status'); }
    }

    if (toContacts) {
        const contacts = await getUserContacts(userId);
        let any = false;
        for (let i = 0; i < contacts.length; i++) {
            const sent = await sendImage(userId, contacts[i], buf, caption);
            if (sent) any = true;
            if (i < contacts.length - 1) await sleep(1500 + Math.floor(Math.random() * 2500)); // human-like spacing
        }
        if (any) { ok = true; channels.push('contacts'); }
    }

    return { ok, channels, error: ok ? undefined : 'WhatsApp not connected or send failed' };
}

module.exports = { getBrandKit, getFestival, getUserContacts, renderForUser, postFestivalForUser, buildCaption };
