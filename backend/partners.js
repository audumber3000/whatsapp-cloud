/**
 * Partner workspaces: which organisations a partner product (MolarPlus) owns,
 * and the checks that decide whether a request really comes from that partner.
 *
 * The org cache is synchronous by design, like orgInstances: the WhatsApp layer
 * asks "is this a partner workspace?" on hot paths (every inbound message,
 * every boot), and those must never wait on the database.
 */

const crypto = require('crypto');
const config = require('./config');

const partnerByOrg = new Map();   // org_id -> partner id

async function load() {
    const db = require('./db');
    const rows = await db.many('SELECT org_id, partner FROM partner_links');
    partnerByOrg.clear();
    for (const r of rows) partnerByOrg.set(String(r.org_id), r.partner);
    console.log(`[partners] ${rows.length} partner workspace(s)`);
    return rows.length;
}

function remember(orgId, partner) {
    partnerByOrg.set(String(orgId), partner);
}

/** The partner that owns this org, or null for an ordinary WA Reach workspace. */
function partnerOf(orgId) {
    return partnerByOrg.get(String(orgId)) || null;
}

function isPartnerOrg(orgId) {
    return partnerByOrg.has(String(orgId));
}

/**
 * Which configured partner this bearer key belongs to, or null.
 * Compared as sha256 digests with timingSafeEqual, so neither the length nor
 * the content of a guess leaks through response timing.
 */
function partnerForKey(rawKey, partners = config.partners) {
    if (!rawKey) return null;
    const digest = crypto.createHash('sha256').update(String(rawKey)).digest();
    for (const p of Object.values(partners || {})) {
        if (p.keyHash && p.keyHash.length === digest.length && crypto.timingSafeEqual(p.keyHash, digest)) {
            return p;
        }
    }
    return null;
}

/** '::ffff:13.207.97.83' -> '13.207.97.83' */
function normalizeIp(ip) {
    const s = String(ip || '').trim();
    return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * The address the TCP connection actually came from.
 *
 * Deliberately not req.ip. server.js sets `trust proxy`, and with no proxy in
 * front of this box that makes X-Forwarded-For attacker-controlled: anyone
 * could claim to be the partner's server by sending the header.
 */
function sourceIp(req) {
    return normalizeIp(req.socket && req.socket.remoteAddress);
}

/** An empty allowlist allows everything (development only; config.js refuses it in production). */
function ipAllowed(partner, ip) {
    const list = (partner && partner.allowedIps) || [];
    if (!list.length) return true;
    const n = normalizeIp(ip);
    return list.some((allowed) => normalizeIp(allowed) === n);
}

module.exports = {
    load, remember, partnerOf, isPartnerOrg,
    partnerForKey, normalizeIp, sourceIp, ipAllowed,
};
