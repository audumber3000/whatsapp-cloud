/**
 * Account routes: password change, reset, sessions, logout, profile.
 *
 * None of this existed. There was no way to change a password, recover one, see
 * where you were signed in, or sign out for real — logout was the browser
 * deleting a token that stayed valid forever.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('./db');
const auth = require('./auth');
const { sendEmail } = require('./email');

function router({ authenticateToken, throttleAuth }) {
    const r = express.Router();
    r.use(express.json({ limit: '256kb' }));

    // ── profile ─────────────────────────────────────────────────────────────
    r.get('/me', authenticateToken, async (req, res) => {
        try {
            const me = await db.one(
                `SELECT u.id, u.username, u.email, u.full_name, u.avatar_url, u.timezone, u.locale,
                        u.email_verified_at, u.last_login_at, u.created_at
                   FROM users u WHERE u.id = ?`, [req.user.id]);
            if (!me) return res.status(404).json({ error: 'Account not found' });

            const org = await db.one(
                `SELECT o.id, o.name, o.slug, o.timezone, o.locale, m.role
                   FROM memberships m JOIN organisations o ON o.id = m.org_id
                  WHERE m.user_id = ? AND m.org_id = ?`, [req.user.id, req.user.org_id]);

            const wa = await db.one('SELECT phone_number, status FROM wa_instances WHERE org_id = ?', [req.user.org_id]);
            res.json({ user: me, org, whatsapp: wa || null });
        } catch (e) {
            res.status(500).json({ error: 'Could not load your account' });
        }
    });

    r.patch('/me', authenticateToken, async (req, res) => {
        const { full_name, timezone, locale, email } = req.body || {};
        try {
            // Changing email un-verifies it; otherwise verification means nothing.
            const current = await db.one('SELECT email FROM users WHERE id = ?', [req.user.id]);
            const emailChanged = email !== undefined && email !== current.email;

            await db.query(
                `UPDATE users SET full_name = COALESCE(?, full_name),
                                  timezone  = COALESCE(?, timezone),
                                  locale    = COALESCE(?, locale),
                                  email     = COALESCE(?, email),
                                  email_verified_at = CASE WHEN ? THEN NULL ELSE email_verified_at END
                  WHERE id = ?`,
                [full_name ?? null, timezone ?? null, locale ?? null, email ?? null, emailChanged, req.user.id]);
            res.json({ success: true, email_verification_required: emailChanged });
        } catch (e) {
            if (String(e.message).includes('users_email_key')) {
                return res.status(400).json({ error: 'That email is already in use' });
            }
            res.status(500).json({ error: 'Could not save your profile' });
        }
    });

    // ── password ────────────────────────────────────────────────────────────
    r.post('/password', authenticateToken, async (req, res) => {
        const { current_password, new_password } = req.body || {};
        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }
        try {
            const u = await db.one('SELECT id, username, password_hash FROM users WHERE id = ?', [req.user.id]);
            if (!u || !(await bcrypt.compare(current_password, u.password_hash))) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }
            const bad = auth.validatePassword(new_password, { username: u.username });
            if (bad) return res.status(400).json({ error: bad });

            await db.query('UPDATE users SET password_hash = ?, password_changed_at = NOW() WHERE id = ?',
                [await auth.hashPassword(new_password), u.id]);

            // Anyone else holding a session for this account loses it — the
            // whole point of changing a password under suspicion.
            await auth.revokeAllSessions(u.id);
            res.json({ success: true, message: 'Password updated. Other devices have been signed out.' });
        } catch (e) {
            res.status(500).json({ error: 'Could not change your password' });
        }
    });

    // ── forgotten password ──────────────────────────────────────────────────
    r.post('/forgot', throttleAuth, async (req, res) => {
        const { email } = req.body || {};
        // Always the same answer: anything else tells an attacker which
        // addresses have accounts.
        const generic = { success: true, message: 'If that address has an account, a reset link is on its way.' };
        if (!email) return res.json(generic);

        try {
            const u = await db.one('SELECT id, username, email FROM users WHERE lower(email) = lower(?) AND deleted_at IS NULL', [email]);
            if (!u) return res.json(generic);

            const token = await auth.issueAuthToken(u.id, 'password_reset', { ip: req.ip });
            const link = `${process.env.WAREACH_PUBLIC_URL || ''}/reset?token=${token}`;
            await sendEmail(u.email, 'Reset your WA Reach password',
                `Someone asked to reset the password for "${u.username}".\n\n` +
                `${link}\n\nThis link works once and expires in an hour. ` +
                `If it wasn't you, ignore this — nothing has changed.`);
            res.json(generic);
        } catch {
            res.json(generic);
        }
    });

    r.post('/reset', throttleAuth, async (req, res) => {
        const { token, new_password } = req.body || {};
        if (!token || !new_password) return res.status(400).json({ error: 'Token and new password are required' });
        try {
            const userId = await auth.consumeAuthToken(token, 'password_reset');
            if (!userId) return res.status(400).json({ error: 'That reset link is invalid or has expired' });

            const u = await db.one('SELECT username FROM users WHERE id = ?', [userId]);
            const bad = auth.validatePassword(new_password, { username: u?.username });
            if (bad) return res.status(400).json({ error: bad });

            await db.query('UPDATE users SET password_hash = ?, password_changed_at = NOW(), failed_attempts = 0, locked_until = NULL WHERE id = ?',
                [await auth.hashPassword(new_password), userId]);
            await auth.revokeAllSessions(userId);
            res.json({ success: true, message: 'Password reset. Please sign in.' });
        } catch {
            res.status(500).json({ error: 'Could not reset your password' });
        }
    });

    // ── sessions ────────────────────────────────────────────────────────────
    r.get('/sessions', authenticateToken, async (req, res) => {
        try { res.json(await auth.listSessions(req.user.id)); }
        catch { res.status(500).json({ error: 'Could not load your sessions' }); }
    });

    r.delete('/sessions/:id', authenticateToken, async (req, res) => {
        try {
            const r2 = await auth.revokeSession(req.params.id, req.user.id);
            if (!r2.rowCount) return res.status(404).json({ error: 'Session not found' });
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Could not revoke that session' }); }
    });

    r.post('/logout', authenticateToken, async (req, res) => {
        try {
            const { refresh_token, all } = req.body || {};
            if (all) await auth.revokeAllSessions(req.user.id);
            else if (refresh_token) {
                await db.query('UPDATE sessions SET revoked_at = NOW() WHERE refresh_token_hash = ? AND user_id = ?',
                    [auth.sha256(refresh_token), req.user.id]);
            }
            res.json({ success: true });
        } catch { res.status(500).json({ error: 'Could not sign out' }); }
    });

    r.post('/refresh', async (req, res) => {
        const { refresh_token } = req.body || {};
        if (!refresh_token) return res.status(400).json({ error: 'refresh_token is required' });
        try {
            const out = await auth.rotateRefresh(refresh_token, { ip: req.ip, userAgent: req.get('user-agent') });
            if (out.error) {
                const msg = out.error === 'replayed'
                    ? 'This session was reused and has been closed for safety. Please sign in again.'
                    : 'Session expired. Please sign in again.';
                return res.status(401).json({ error: msg });
            }
            const user = await db.one('SELECT id, username FROM users WHERE id = ? AND deleted_at IS NULL', [out.userId]);
            if (!user) return res.status(401).json({ error: 'Account unavailable' });

            const org = await db.one(
                `SELECT m.org_id, m.role FROM memberships m
                  WHERE m.user_id = ? AND m.status = 'active'
                  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END LIMIT 1`, [user.id]);
            if (!org) return res.status(403).json({ error: 'No workspace membership' });

            res.json({ accessToken: auth.signAccessToken({ user, org }), refresh_token: out.refresh });
        } catch {
            res.status(500).json({ error: 'Could not refresh your session' });
        }
    });

    return r;
}

module.exports = { router };
