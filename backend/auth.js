/**
 * Identity and access.
 *
 * What existed before: a JWT with no expiry, no refresh, no logout, no
 * revocation, no password change, no reset, and a role that came from a string
 * literal rather than a database row. A leaked token was valid forever and the
 * only way to kill it was rotating the shared secret and logging everyone out.
 *
 * The model here:
 *   access token   short-lived, stateless, carries user + org + role
 *   refresh token  long-lived, stored HASHED in sessions, rotated on every use
 *                  so a stolen one is single-use and detectable
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
const config = require('./config');

const BCRYPT_COST = 12;                       // was 10; cheap to raise, hard to undo later
const REFRESH_TTL_DAYS = 30;
const RESET_TTL_MINUTES = 60;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

/* ── password rules ─────────────────────────────────────────────────────────
 * There were none: a one-character password was accepted. Deliberately length-
 * first rather than a character-class maze, which pushes people toward
 * "Passw0rd!" and is measurably worse.
 */
function validatePassword(password, { username = '' } = {}) {
    if (typeof password !== 'string' || password.length < 10) {
        return 'Password must be at least 10 characters.';
    }
    if (password.length > 200) return 'Password is too long.';
    const lower = password.toLowerCase();
    if (username && lower.includes(String(username).toLowerCase())) {
        return 'Password must not contain your username.';
    }
    // Match on the password's core, not a substring: plain `includes` would
    // reject "first-password-here" and "MyStrongPassword2024!", which are fine.
    // "password123" reduces to "password" and is correctly rejected.
    const COMMON = new Set(['password', 'passw0rd', '12345678', '123456789', 'qwerty', 'qwertyuiop',
                            'letmein', 'welcome', 'admin', 'iloveyou', 'monkey', 'dragon', 'football']);
    const core = lower.replace(/[^a-z]/g, '');
    if (COMMON.has(core) || COMMON.has(lower.replace(/[0-9!@#$%^&*._-]+$/, ''))) {
        return 'That password is too easy to guess.';
    }
    return null;
}

const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_COST);

/* ── sessions ───────────────────────────────────────────────────────────────*/

async function createSession(userId, { ip, userAgent } = {}) {
    const refresh = randomToken();
    const expires = new Date(Date.now() + REFRESH_TTL_DAYS * 864e5);
    await db.query(
        `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, sha256(refresh), (userAgent || '').slice(0, 400), ip || null, expires]
    );
    return { refresh, expires };
}

function signAccessToken({ user, org }) {
    return jwt.sign(
        { id: user.id, username: user.username, org_id: org.org_id, role: org.role },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn }
    );
}

/**
 * Refresh rotation: the presented token is revoked and a new one issued. If a
 * token that was already used shows up again, that is a replay — every session
 * for the user is killed rather than quietly issuing another.
 */
async function rotateRefresh(refreshToken, { ip, userAgent } = {}) {
    const hash = sha256(refreshToken);
    const row = await db.one(
        `SELECT s.id, s.user_id, s.revoked_at, s.expires_at
           FROM sessions s WHERE s.refresh_token_hash = ?`, [hash]);

    if (!row) return { error: 'invalid' };

    if (row.revoked_at) {
        await db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [row.user_id]);
        console.warn(`[auth] refresh token replay for user ${row.user_id} — all sessions revoked`);
        return { error: 'replayed' };
    }
    if (new Date(row.expires_at) < new Date()) return { error: 'expired' };

    await db.query('UPDATE sessions SET revoked_at = NOW() WHERE id = ?', [row.id]);
    const next = await createSession(row.user_id, { ip, userAgent });
    return { userId: row.user_id, refresh: next.refresh };
}

const revokeSession = (sessionId, userId) =>
    db.query('UPDATE sessions SET revoked_at = NOW() WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [sessionId, userId]);

const revokeAllSessions = (userId) =>
    db.query('UPDATE sessions SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL', [userId]);

const listSessions = (userId) =>
    db.many(
        `SELECT id, user_agent, ip, last_seen_at, created_at, expires_at
           FROM sessions
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
          ORDER BY last_seen_at DESC`, [userId]);

/* ── reset / verification tokens ────────────────────────────────────────────*/

async function issueAuthToken(userId, purpose, { ip, ttlMinutes = RESET_TTL_MINUTES } = {}) {
    // Only one live token per purpose, so requesting a new link kills the old.
    await db.query('UPDATE auth_tokens SET used_at = NOW() WHERE user_id = ? AND purpose = ? AND used_at IS NULL', [userId, purpose]);
    const token = randomToken();
    await db.query(
        `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at, created_ip)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, purpose, sha256(token), new Date(Date.now() + ttlMinutes * 60000), ip || null]
    );
    return token;
}

/** Single-use: consuming marks it used, so a replay finds nothing. */
async function consumeAuthToken(token, purpose) {
    const row = await db.one(
        `SELECT id, user_id, expires_at, used_at FROM auth_tokens
          WHERE token_hash = ? AND purpose = ?`, [sha256(token), purpose]);
    if (!row || row.used_at) return null;
    if (new Date(row.expires_at) < new Date()) return null;
    await db.query('UPDATE auth_tokens SET used_at = NOW() WHERE id = ?', [row.id]);
    return row.user_id;
}

/* ── roles ──────────────────────────────────────────────────────────────────*/

const ROLE_RANK = { agent: 0, manager: 1, owner: 2 };

/**
 * requireRole('manager') admits managers and owners. Read off the token, which
 * is signed, so it cannot be escalated client-side.
 */
function requireRole(minimum) {
    return (req, res, next) => {
        const have = ROLE_RANK[req.user?.role];
        const need = ROLE_RANK[minimum];
        if (have === undefined || need === undefined || have < need) {
            return res.status(403).json({ error: `Requires ${minimum} access` });
        }
        next();
    };
}

module.exports = {
    BCRYPT_COST, REFRESH_TTL_DAYS,
    validatePassword, hashPassword, sha256, randomToken,
    createSession, signAccessToken, rotateRefresh,
    revokeSession, revokeAllSessions, listSessions,
    issueAuthToken, consumeAuthToken,
    requireRole, ROLE_RANK,
};
