require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
// We will import whatsapp and scheduler later
const whatsappClient = require('./whatsapp');
require('./scheduler');

const config = require('./config');
const JWT_SECRET = config.jwtSecret;

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' })); // larger limit so logo data-URIs fit

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Evolution API pushes pairing codes, connection changes and delivery
// receipts here. Authenticated by a shared secret inside the router.
app.use('/api/evolution/webhook', require('./evolution/webhook').router());

// The programmable API — WA Reach's second product. Authenticated by a
// per-user API key, entirely separate from the dashboard's JWT session.
const publicApi = require('./publicApi');
app.use('/api/v1', publicApi.router());

// --- Media upload storage (images / PDFs / video for scheduled sends) ---
const MEDIA_DIR = path.join(__dirname, 'uploads', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
// SVG is excluded deliberately: it satisfies ^image/ but is an executable
// document, and serving one inline from our own origin is stored XSS.
const BLOCKED_MEDIA = /^image\/svg/i;
const ALLOWED_MEDIA = /^(image\/|video\/|audio\/|application\/pdf$)/;
const mediaUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, MEDIA_DIR),
        filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname || '')),
    }),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (req, file, cb) => cb(null, ALLOWED_MEDIA.test(file.mimetype) && !BLOCKED_MEDIA.test(file.mimetype)),
});

// --- Auth Middleware ---
/**
 * Login throttling.
 *
 * /api/login, /api/signup and /api/admin/login previously had no rate limit,
 * no lockout and no captcha — an admin password could be brute-forced at
 * whatever rate the network allowed.
 *
 * Keyed on IP + submitted username so one attacker cannot lock out a real user
 * by hammering their account from elsewhere. In-memory, which is fine for a
 * single instance (PM2 is pinned to one) and resets on restart.
 */
const AUTH_MAX_ATTEMPTS = 8;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const authAttempts = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of authAttempts) if (now > v.reset) authAttempts.delete(k);
}, 5 * 60 * 1000).unref();

const throttleAuth = (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const who = String((req.body && req.body.username) || '').toLowerCase().slice(0, 64);
    const key = `${ip}|${who}`;
    const now = Date.now();

    const rec = authAttempts.get(key) || { count: 0, reset: now + AUTH_WINDOW_MS };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + AUTH_WINDOW_MS; }

    if (rec.count >= AUTH_MAX_ATTEMPTS) {
        const retry = Math.ceil((rec.reset - now) / 1000);
        res.set('Retry-After', String(retry));
        return res.status(429).json({ error: 'Too many attempts. Try again later.', retry_after_seconds: retry });
    }

    // Counted on the way in and cleared by clearAuthAttempts() on success, so
    // successful logins never accumulate toward a lockout.
    rec.count += 1;
    authAttempts.set(key, rec);
    req._authThrottleKey = key;
    next();
};

const clearAuthAttempts = (req) => { if (req._authThrottleKey) authAttempts.delete(req._authThrottleKey); };

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        // Clinic SSO tokens are read-only and must not access user routes.
        if (!user || user.scope === 'clinic' || !user.id) return res.sendStatus(403);
        // Tokens issued before the org migration have no org_id. Rejecting them
        // is deliberate: a query that falls through unscoped would read across
        // tenants, so a stale token must re-authenticate rather than degrade.
        if (!user.org_id) return res.status(401).json({ error: 'Session out of date — please sign in again' });
        req.user = user;
        // A password change must invalidate tokens issued before it, or
        // "sign out everywhere" would only apply to refresh tokens.
        db.get('SELECT password_changed_at FROM users WHERE id = ?', [user.id], (e, row) => {
            const changedAtSec = row ? Math.floor(new Date(row.password_changed_at).getTime() / 1000) : 0;
            if (!e && row && user.iat && changedAtSec > user.iat) {
                return res.status(401).json({ error: 'Password changed — please sign in again' });
            }
            next();
        });
        return;
    });
};

const auth = require('./auth');
// Account management: profile, password change, reset, sessions, refresh.
app.use('/api/account', require('./authRoutes').router({ authenticateToken, throttleAuth }));

// Contacts CRM: list with pagination/sort/filter, detail, timeline, notes,
// tags, bulk actions, import and export.
app.use('/api/contacts', require('./contacts').router({ authenticateToken, requireRole: auth.requireRole }));
// Org-level configuration the contact record depends on.
app.use('/api', require('./tags').router({ authenticateToken, requireRole: auth.requireRole }));

// The team inbox. Its three routes were referenced by the UI for months and
// never existed — see the header comment in inbox.js.
app.use('/api/inbox', require('./inbox').router({ authenticateToken, requireRole: auth.requireRole }));
app.use('/api', require('./inbox').configRouter({ authenticateToken, requireRole: auth.requireRole }));

// Templates and broadcasts. Message wording used to exist only inline in an
// automation, and bulk sends only as a pasted list of numbers.
app.use('/api/templates', require('./templates').router({ authenticateToken, requireRole: auth.requireRole }));
app.use('/api/broadcasts', require('./broadcasts').router({ authenticateToken, requireRole: auth.requireRole }));
app.use('/api/analytics', require('./analytics').router({ authenticateToken }));

// --- Auth Endpoints ---
app.post('/api/signup', throttleAuth, async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);

        // Signing up creates a workspace and makes you its owner — everything
        // owned (contacts, automations, keys) belongs to the org, not to you.
        try {
            const weak = auth.validatePassword(password, { username });
        if (weak) return res.status(400).json({ error: weak });

        const slugBase = String(username).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
            const created = await db.tx(async (t) => {
                const existing = await t.one('SELECT id FROM users WHERE username = ?', [username]);
                if (existing) return null;
                const u = await t.one('INSERT INTO users (username, password_hash) VALUES (?, ?) RETURNING id', [username, hashedPassword]);
                const o = await t.one('INSERT INTO organisations (name, slug) VALUES (?, ?) RETURNING id',
                    [username, `${slugBase}-${Date.now().toString(36)}`]);
                await t.query('INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, \'owner\')', [o.id, u.id]);
                await t.query('INSERT INTO wa_instances (org_id, instance_name) VALUES (?, ?)', [o.id, `wareach_org_${o.id}`]);
                return { userId: u.id, orgId: o.id };
            });
            if (!created) return res.status(400).json({ error: 'Username already exists' });
            // Register the new instance in the resolver cache, or the first send
            // would look up a name that is not there yet.
            await require('./orgInstances').ensureFor(created.orgId).catch(() => {});
            return res.status(201).json({ message: 'User created successfully' });
        } catch (e) {
            return res.status(500).json({ error: 'Could not create account' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/login', throttleAuth, (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        // Same response as a wrong password: different status/body here
        // let anyone test whether a username exists.
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        try {
            if (await bcrypt.compare(password, user.password_hash)) {
                // Everything owned now belongs to an organisation, so the token
                // carries which org this session is acting in, plus the role.
                const m = await db.one(
                    `SELECT m.org_id, m.role, o.name AS org_name, o.slug AS org_slug
                       FROM memberships m JOIN organisations o ON o.id = m.org_id
                      WHERE m.user_id = $1 AND m.status = 'active'
                      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END
                      LIMIT 1`, [user.id]);
                if (!m) return res.status(403).json({ error: 'This account is not a member of any workspace' });

                db.run('UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?',
                    [req.ip || null, user.id], () => {});

                whatsappClient.initializeUserClient(m.org_id);
                clearAuthAttempts(req);
                const accessToken = jwt.sign(
                    { username: user.username, id: user.id, org_id: m.org_id, role: m.role },
                    JWT_SECRET, { expiresIn: config.jwtExpiresIn });

                // A refresh token makes logout and "sign out other devices"
                // possible at all — the access token alone was unrevocable.
                const session = await auth.createSession(user.id, {
                    ip: req.ip, userAgent: req.get('user-agent'),
                });

                res.json({
                    accessToken,
                    refresh_token: session.refresh,
                    user: { id: user.id, username: user.username, full_name: user.full_name, email: user.email },
                    org: { id: m.org_id, name: m.org_name, slug: m.org_slug, role: m.role },
                });
            } else {
                res.status(401).json({ error: 'Invalid credentials' });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
});

// --- Master Admin Endpoints ---
app.post('/api/admin/login', throttleAuth, async (req, res) => {
    const { username, password } = req.body || {};
    const A = config.admin;

    // Previously this compared against the literals 'Audumber'/'Audumber' in
    // source. Credentials now come from the environment, and the password is
    // compared against a bcrypt hash so no plaintext exists anywhere.
    if (!A.username || (!A.passwordHash && !A.devPassword)) {
        return res.status(503).json({ error: 'Admin access is not configured' });
    }
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    const userOk = username === A.username;
    const passOk = A.passwordHash
        ? await bcrypt.compare(password, A.passwordHash).catch(() => false)
        : password === A.devPassword;

    if (!userOk || !passOk) {
        // Deliberately identical to any other failure — no enumeration.
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    clearAuthAttempts(req);
    const adminToken = jwt.sign({ username: A.username, role: 'admin' }, JWT_SECRET, { expiresIn: '4h' });
    res.json({ accessToken: adminToken });
});

const authenticateMasterAdmin = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err || user.role !== 'admin') return res.sendStatus(403);
        req.user = user;
        next();
    });
};

app.get('/api/admin/dashboard', authenticateMasterAdmin, (req, res) => {
    db.all(`
        SELECT u.id, u.username, u.email,
               COUNT(DISTINCT a.id) as total_automations,
               COUNT(DISTINCT al.id) as total_messages
        FROM users u
        LEFT JOIN memberships mem ON mem.user_id = u.id
        LEFT JOIN automations a ON a.org_id = mem.org_id AND a.status != 'Deleted'
        LEFT JOIN automation_logs al ON a.id = al.automation_id AND al.status IN ('delivered', 'read', 'sent')
        GROUP BY u.id
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        let globalStats = { totalUsers: 0, totalAutomations: 0, totalMessagesSent: 0 };
        rows.forEach(r => {
            globalStats.totalUsers++;
            globalStats.totalAutomations += r.total_automations;
            globalStats.totalMessagesSent += r.total_messages;
        });

        res.json({ users: rows, globalStats });
    });
});


// Settings Endpoints
app.get('/api/settings', authenticateToken, (req, res) => {
    db.get('SELECT notify_emails AS email, notify_whatsapp AS personal_whatsapp_number FROM organisations WHERE id = ?', [req.user.org_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { email: '', personal_whatsapp_number: '' });
    });
});

app.put('/api/settings', authenticateToken, (req, res) => {
    const { email, personal_whatsapp_number } = req.body;
    
    // Clean and validate recipients
    const cleanEmail = email ? email.split(',').map(e => e.trim()).filter(Boolean).join(',') : '';
    const cleanPhone = personal_whatsapp_number ? personal_whatsapp_number.split(',').map(p => p.trim()).filter(Boolean).join(',') : '';

    db.run(`UPDATE organisations SET notify_emails = ?, notify_whatsapp = ? WHERE id = ?`, [cleanEmail, cleanPhone, req.user.org_id], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update settings' });
        res.json({ message: 'Settings updated successfully' });
    });
});

app.get('/api/notifications/logs', authenticateToken, (req, res) => {
    db.all('SELECT * FROM notification_logs WHERE org_id = ? ORDER BY sent_at DESC LIMIT 50', [req.user.org_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- Media attachments ---
app.post('/api/media', authenticateToken, (req, res) => {
    mediaUpload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 20MB)' : err.message });
        if (!req.file) return res.status(400).json({ error: 'No file, or unsupported type (allowed: image, video, audio, PDF)' });
        db.run(
            `INSERT INTO media_attachments (org_id, uploaded_by, original_name, stored_name, mimetype, size) VALUES (?, ?, ?, ?, ?, ?)`,
            [req.user.org_id, req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size],
            function (dbErr) {
                if (dbErr) {
                    fs.unlink(path.join(MEDIA_DIR, req.file.filename), () => {});
                    return res.status(500).json({ error: dbErr.message });
                }
                res.json({ id: this.lastID, original_name: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size });
            }
        );
    });
});

// Stream a media file back (owner only) — used for thumbnails/preview in the UI.
app.get('/api/media/:id', authenticateToken, (req, res) => {
    db.get('SELECT * FROM media_attachments WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        const filePath = path.join(MEDIA_DIR, row.stored_name);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });
        res.set('Content-Type', row.mimetype || 'application/octet-stream');
        // Never let a browser second-guess the type we stored, and never render
        // an upload as a document in our own origin.
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
        res.sendFile(filePath);
    });
});

app.delete('/api/media/:id', authenticateToken, (req, res) => {
    db.get('SELECT * FROM media_attachments WHERE id = ? AND org_id = ?', [req.params.id, req.user.org_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        fs.unlink(path.join(MEDIA_DIR, row.stored_name), () => {});
        db.run('DELETE FROM media_attachments WHERE id = ?', [req.params.id], () => res.json({ message: 'Deleted' }));
    });
});

// --- API Endpoints ---
app.get('/api/wa/status', authenticateToken, (req, res) => {
    const status = whatsappClient.getStatus(req.user.org_id);
    console.log(`WA Status requested for user ${req.user.org_id}. isConnected:`, status.isConnected, 'QR length:', status.currentQR ? status.currentQR.length : 0);
    res.json(status);
});

app.post('/api/wa/disconnect', authenticateToken, async (req, res) => {
    try {
        const success = await whatsappClient.disconnectClient(req.user.org_id);
        if (success) {
            res.json({ message: 'WhatsApp disconnected successfully. A new QR code will be generated.' });
        } else {
            res.status(500).json({ error: 'Failed to disconnect WhatsApp client.' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all contacts (optional ?search= over name/phone)
// ── Contacts ────────────────────────────────────────────────────────────────
// The CRUD, list, import, notes, tags and timeline routes moved to
// contacts.js. What stays here are the two that reach into the WhatsApp layer:
// /validate (asks Evolution which numbers exist) and /:id/optout.

app.post('/api/contacts/validate', authenticateToken, async (req, res) => {
    db.all('SELECT phone FROM contacts WHERE org_id = ?', [req.user.org_id], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const numbers = (rows || []).map(r => r.phone).filter(Boolean);
        if (!numbers.length) return res.json({ checked: 0, invalid: 0 });

        const result = await whatsappClient.validateNumbers(req.user.org_id, numbers);
        if (!result) return res.status(409).json({ error: 'WhatsApp is not connected' });

        db.get('SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND wa_valid = FALSE',
            [req.user.org_id], (e2, row) => {
                res.json({ checked: numbers.length, invalid: row ? row.n : 0 });
            });
    });
});

// Manual opt-out toggle, for when someone asks the front desk directly.
app.patch('/api/contacts/:id/optout', authenticateToken, (req, res) => {
    const optOut = !!req.body?.opted_out;
    db.run(
        `UPDATE contacts SET opted_out = ?, opted_out_at = CASE WHEN ? THEN NOW() ELSE NULL END
         WHERE id = ? AND org_id = ?`,
        [optOut, optOut, req.params.id, req.user.org_id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Contact not found' });
            if (optOut) {
                db.run(`UPDATE automation_logs SET status = 'cancelled', error_reason = 'Contact opted out'
                        WHERE contact_id = ? AND status = 'pending'`, [req.params.id]);
            }
            res.json({ success: true, opted_out: !!optOut });
        }
    );
});

// Today's confirmation picture — the thing a front desk actually wants at
// 9am: who is coming, who moved, who dropped out, and who never answered.
app.get('/api/dashboard/responses', authenticateToken, (req, res) => {
    // Was a SQLite datetime() modifier string ('start of day', '-2 hours').
    // Resolved here so the query is plain SQL and the value is a real timestamp.
    const rawSince = req.query.since || 'start of day';
    const sinceTs = (() => {
        const m = /^-(\d+)\s*(minute|hour|day)s?$/.exec(rawSince);
        if (m) return new Date(Date.now() - Number(m[1]) * { minute: 6e4, hour: 36e5, day: 864e5 }[m[2]]);
        const d = new Date(); d.setHours(0, 0, 0, 0); return d;   // start of day
    })();
    db.all(`
        SELECT
          SUM(CASE WHEN al.response = 'confirm'    THEN 1 ELSE 0 END)::int AS confirmed,
          SUM(CASE WHEN al.response = 'reschedule' THEN 1 ELSE 0 END)::int AS reschedule,
          SUM(CASE WHEN al.response = 'cancel'     THEN 1 ELSE 0 END)::int AS cancelled,
          SUM(CASE WHEN al.response IS NULL        THEN 1 ELSE 0 END)::int AS no_reply,
          COUNT(*) AS total
        FROM automation_logs al
        JOIN automations a ON a.id = al.automation_id
        WHERE a.org_id = ?
          AND al.status IN ('delivered','sent','read')
          AND al.sent_time >= $2
    `, [req.user.org_id, sinceTs], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const r = (rows && rows[0]) || {};
        const summary = {
            confirmed: r.confirmed || 0,
            reschedule: r.reschedule || 0,
            cancelled: r.cancelled || 0,
            no_reply: r.no_reply || 0,
            total: r.total || 0,
        };

        // Names too, so the list is actionable rather than just a number.
        db.all(`
            SELECT c.name, c.phone, al.response, al.responded_at
            FROM automation_logs al
            JOIN automations a ON a.id = al.automation_id
            LEFT JOIN contacts c ON c.id = al.contact_id
            WHERE a.org_id = ? AND al.response IS NOT NULL
              AND al.sent_time >= date_trunc('day', NOW())
            ORDER BY al.responded_at DESC LIMIT 50
        `, [req.user.org_id], (e2, detail) => {
            res.json({ ...summary, responses: detail || [] });
        });
    });
});

// A single chronological stream of what happened: replies coming in and
// messages going out, merged. Cheaper to scan than two separate tables.
app.get('/api/feed', authenticateToken, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    db.all(`
        SELECT 'inbound' AS kind, im.received_at AS at,
               COALESCE(c.name, 'Unknown') AS who, im.from_number AS phone,
               im.body AS text, im.intent AS detail, NULL AS status
          FROM inbound_messages im
          LEFT JOIN contacts c ON c.id = im.contact_id
         WHERE im.org_id = ?
        UNION ALL
        SELECT 'outbound' AS kind, al.sent_time AS at,
               COALESCE(c.name, 'Unknown') AS who, c.phone AS phone,
               al.content AS text, al.response AS detail, al.status AS status
          FROM automation_logs al
          JOIN automations a ON a.id = al.automation_id
          LEFT JOIN contacts c ON c.id = al.contact_id
         WHERE a.org_id = ? AND al.status != 'pending'
        ORDER BY at DESC
        LIMIT ?
    `, [req.user.org_id, req.user.org_id, limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// --- API key management (dashboard-authenticated) ---

app.get('/api/apikey', authenticateToken, (req, res) => {
    db.get(`SELECT key_prefix, name, created_at, last_used_at FROM api_keys
             WHERE org_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        [req.user.org_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        // The raw key is only ever shown once, at creation. Afterwards only
        // the prefix exists, because the rest is stored hashed.
        res.json(row
            ? { api_key: null, key_prefix: row.key_prefix, name: row.name, created_at: row.created_at, last_used_at: row.last_used_at }
            : { api_key: null, key_prefix: null, created_at: null });
    });
});

// Also used to rotate: issuing a new key immediately invalidates the old one.
app.post('/api/apikey', authenticateToken, async (req, res) => {
    try {
        // Issuing a new key revokes the old one, as before.
        await db.query('UPDATE api_keys SET revoked_at = NOW() WHERE org_id = ? AND revoked_at IS NULL', [req.user.org_id]);
        const key = await publicApi.issueKey(req.user.org_id, { createdBy: req.user.id });
        res.json({ api_key: key, created_at: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/apikey', authenticateToken, (req, res) => {
    db.run('UPDATE api_keys SET revoked_at = NOW() WHERE org_id = ? AND revoked_at IS NULL', [req.user.org_id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- Health ---
app.get('/api/health/alerts', authenticateToken, (req, res) => {
    db.all('SELECT kind, detail, created_at FROM health_alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT 20',
        [req.user.org_id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
});

// --- Dashboard & Meta Endpoints ---
app.get('/api/dashboard/stats', authenticateToken, (req, res) => {
    const stats = { sent: 0, failed: 0, activeAutomations: 0, phone: whatsappClient.getStatus(req.user.org_id).phone };
    
    db.get(`SELECT COUNT(*) as count FROM automation_logs al JOIN automations a ON al.automation_id = a.id WHERE a.org_id = ? AND (al.status = 'delivered' OR al.status = 'read' OR al.status = 'sent')`, [req.user.org_id], (err, row) => {
        if (!err && row) stats.sent = row.count;

        db.get(`SELECT COUNT(*) as count FROM automation_logs al JOIN automations a ON al.automation_id = a.id WHERE a.org_id = ? AND al.status = 'failed'`, [req.user.org_id], (err2, row2) => {
            if (!err2 && row2) stats.failed = row2.count;

            db.get(`SELECT COUNT(*) as count FROM automations WHERE org_id = ? AND status = 'Active'`, [req.user.org_id], (err3, row3) => {
                if (!err3 && row3) stats.activeAutomations = row3.count;
                            res.json(stats);
            });
        });
    });
});

app.get('/api/dashboard/graph-data', authenticateToken, (req, res) => {
    // Return counts for the last 24 hours grouped by hour
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const query = `
        SELECT to_char(date_trunc('hour', sent_time), 'HH24:00') as hour, COUNT(*) as count, MIN(sent_time) as sent_time
        FROM automation_logs al
        JOIN automations a ON al.automation_id = a.id
        WHERE a.org_id = ? AND al.status IN ('delivered', 'read', 'sent') AND al.sent_time >= ?
        GROUP BY date_trunc('hour', sent_time)
        ORDER BY sent_time ASC
    `;

    db.all(query, [req.user.org_id, twentyFourHoursAgo], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Fill in missing hours with 0
        const result = [];
        for (let i = 0; i < 24; i++) {
            const date = new Date(now.getTime() - (23 - i) * 60 * 60 * 1000);
            const hour = date.getHours();
            const hourLabel = hour.toString().padStart(2, '0') + ':00';
            
            // Re-matching logic: find if we have an entry for this specific hour in the last 24h
            const found = rows.find(r => {
                const rDate = new Date(r.sent_time);
                return rDate.getHours() === hour && (now - rDate) <= 24 * 60 * 60 * 1000;
            });

            result.push({
                time: hourLabel,
                count: found ? found.count : 0,
                isNight: hour >= 20 || hour <= 6
            });
        }
        res.json(result);
    });
});

app.get('/api/logs', authenticateToken, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let whereClause = `a.org_id = ?`;
    let queryParams = [req.user.org_id];

    if (status && status !== 'all') {
        const statuses = status.split(',');
        const statusPlaceholders = statuses.map(() => '?').join(',');
        whereClause += ` AND al.status IN (${statusPlaceholders})`;
        queryParams.push(...statuses);
    }

    const countQuery = `SELECT COUNT(*) as total FROM automation_logs al JOIN automations a ON al.automation_id = a.id WHERE ${whereClause}`;
    db.get(countQuery, queryParams, (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });

        const total = countRow.total;

        const dataQuery = `
            SELECT al.*, c.phone as contact, a.name as workflow 
            FROM automation_logs al
            LEFT JOIN contacts c ON al.contact_id = c.id
            LEFT JOIN automations a ON al.automation_id = a.id
            WHERE ${whereClause}
            ORDER BY al.id DESC
            LIMIT ? OFFSET ?
        `;

        const allParams = [...queryParams, limit, offset];
        db.all(dataQuery, allParams, (err2, rows) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({
                data: rows,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages: Math.ceil(total / limit)
                }
            });
        });
    });
});

// --- Automations Endpoints ---
app.get('/api/automations', authenticateToken, (req, res) => {
    db.all(`
        SELECT a.*, (SELECT COUNT(*) FROM automation_logs WHERE automation_id = a.id AND status = 'pending') as count 
        FROM automations a
        WHERE a.org_id = ? AND a.status != 'Deleted'
        ORDER BY a.id DESC
    `, [req.user.org_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/automations', authenticateToken, (req, res) => {
    const { name, start_time, end_time, message_template, contacts, clientOffset, active_days, ask_confirmation } = req.body;
    // Accept an array or a comma-separated string. Previously a plain string
    // here reached .forEach on a non-array and killed the whole process — and
    // with PM2 pinned to a single instance that is a full outage per bad request.
    const contactList = Array.isArray(contacts)
        ? contacts.map((c) => String(c).replace(/\D/g, '')).filter(Boolean)
        : String(contacts || '').split(',').map((c) => c.replace(/\D/g, '')).filter(Boolean);

    const orgId = req.user.org_id;

    // Default to server offset if not provided (for older clients)
    const offsetMins = clientOffset !== undefined ? clientOffset : new Date().getTimezoneOffset();
    const daysArray = active_days || [0, 1, 2, 3, 4, 5, 6];
    const daysJson = JSON.stringify(daysArray);

    // Provide the JSON-structured message template securely or store string if format was a string.
    // It's expected message_template is a string (JSON stringified) or regular string. Check if it's object or array and stringify
    let msgTemplateStr = message_template;
    if (typeof msgTemplateStr === 'object') {
        msgTemplateStr = JSON.stringify(msgTemplateStr);
    }

    db.run(`INSERT INTO automations (org_id, name, start_time, end_time, message_template, status, active_days, timezone_offset, ask_confirmation) VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
        [orgId, name, start_time, end_time, msgTemplateStr, daysJson, offsetMins, ask_confirmation ? 1 : 0],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });

            const automationId = this.lastID;

            const [startH, startM] = start_time.split(':').map(Number);
            const [endH, endM] = end_time.split(':').map(Number);

            let startTotalMins = startH * 60 + startM;
            let endTotalMins = endH * 60 + endM;

            if (endTotalMins <= startTotalMins) {
                endTotalMins += 24 * 60; 
            }

            const contactCount = contactList.length;
            const nowUTC = new Date();
            let clientNow = new Date(nowUTC.getTime() - (offsetMins * 60000));
            const clientCurrentTotalMins = clientNow.getUTCHours() * 60 + clientNow.getUTCMinutes();

            let clientBaseDate = new Date(clientNow);
            clientBaseDate.setUTCHours(startH, startM, 0, 0);

            if (clientCurrentTotalMins > startTotalMins) {
                if (clientCurrentTotalMins < endTotalMins) {
                    clientBaseDate.setUTCHours(clientNow.getUTCHours(), clientNow.getUTCMinutes(), 0, 0);
                } else {
                    clientBaseDate.setUTCDate(clientBaseDate.getUTCDate() + 1);
                    clientBaseDate.setUTCHours(startH, startM, 0, 0);
                }
            } else {
                clientBaseDate.setUTCHours(startH, startM, 0, 0);
            }

            while (!daysArray.includes(clientBaseDate.getDay())) {
                clientBaseDate.setUTCDate(clientBaseDate.getUTCDate() + 1);
                clientBaseDate.setUTCHours(startH, startM, 0, 0);
            }

            let absoluteBaseDateUTC = new Date(clientBaseDate.getTime() + (offsetMins * 60000));

            let clientEndTime = new Date(clientBaseDate);
            clientEndTime.setUTCHours(endH, endM, 0, 0);
            if (clientEndTime <= clientBaseDate) {
                clientEndTime.setUTCDate(clientEndTime.getUTCDate() + 1);
            }
            
            const adjustedWindowMinutes = (clientEndTime - clientBaseDate) / (1000 * 60);
            const actualBaseInterval = Math.max(adjustedWindowMinutes / Math.max(contactCount, 1), 1); 

            let currentTimeOffset = 0;
            
            contactList.forEach((contactPhone) => {
                const jitterMs = (Math.random() * 0.6 - 0.3) * actualBaseInterval * 60 * 1000;
                currentTimeOffset += actualBaseInterval;
                const scheduledTime = new Date(absoluteBaseDateUTC.getTime() + (currentTimeOffset * 60 * 1000) + jitterMs);

                db.get("SELECT id FROM contacts WHERE phone = ? AND org_id = ?", [contactPhone, orgId], (errC, row) => {
                    let cId;
                    if (row) {
                        cId = row.id;
                        insertLogAndReminder(cId, scheduledTime);
                    } else {
                        db.run("INSERT INTO contacts (org_id, name, phone) VALUES (?, ?, ?)", [orgId, 'Unknown', contactPhone], function (errInsert) {
                            if (!errInsert) {
                                cId = this.lastID;
                                insertLogAndReminder(cId, scheduledTime);
                            }
                        });
                    }
                });

                function insertLogAndReminder(contactId, scheduleDate) {
                    db.run(`INSERT INTO automation_logs (automation_id, contact_id, status) VALUES (?, ?, 'pending')`, [automationId, contactId], function (errLog) {
                        if (!errLog) {
                            const logId = this.lastID;
                            const isoString = scheduleDate.toISOString();
                            db.run(`UPDATE automation_logs SET sent_time = ? WHERE id = ?`, [isoString, logId]);
                        }
                    });
                }
            });

            res.status(201).json({ message: 'Automation created and scheduled successfully', id: automationId });
        });
});

app.get('/api/automations/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM automations WHERE id = ? AND org_id = ?`, [id, req.user.org_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Automation not found' });
        
        db.all(`
            SELECT DISTINCT c.phone 
            FROM automation_logs al
            JOIN contacts c ON al.contact_id = c.id
            WHERE al.automation_id = ?
        `, [id], (errC, phoneRows) => {
            if (errC) return res.status(500).json({ error: errC.message });
            row.contacts = phoneRows.map(p => p.phone);
            try {
                // Return parsed message template if possible, else string
                row.message_template = JSON.parse(row.message_template);
            } catch (e) {}
            res.json(row);
        });
    });
});

app.put('/api/automations/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { name, start_time, end_time, message_template, contacts, clientOffset, active_days, ask_confirmation } = req.body;
    // Accept an array or a comma-separated string. Previously a plain string
    // here reached .forEach on a non-array and killed the whole process — and
    // with PM2 pinned to a single instance that is a full outage per bad request.
    const contactList = Array.isArray(contacts)
        ? contacts.map((c) => String(c).replace(/\D/g, '')).filter(Boolean)
        : String(contacts || '').split(',').map((c) => c.replace(/\D/g, '')).filter(Boolean);

    const orgId = req.user.org_id;

    // First ensure ownership
    db.get('SELECT id FROM automations WHERE id = ? AND org_id = ?', [id, orgId], (errCheck, rowCheck) => {
        if (errCheck || !rowCheck) return res.status(403).json({ error: 'Not authorized or automation not found' });

        const offsetMins = clientOffset !== undefined ? clientOffset : new Date().getTimezoneOffset();
        const daysArray = active_days || [0, 1, 2, 3, 4, 5, 6];
        const daysJson = JSON.stringify(daysArray);

        let msgTemplateStr = message_template;
        if (typeof msgTemplateStr === 'object') {
            msgTemplateStr = JSON.stringify(msgTemplateStr);
        }

        db.run(`UPDATE automations SET name = ?, start_time = ?, end_time = ?, message_template = ?, active_days = ?, timezone_offset = ?, ask_confirmation = ? WHERE id = ? AND org_id = ?`,
            [name, start_time, end_time, msgTemplateStr, daysJson, offsetMins, ask_confirmation ? 1 : 0, id, orgId],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });

                db.run(`DELETE FROM automation_logs WHERE automation_id = ? AND status = 'pending'`, [id], function (errDel) {
                    if (errDel) return res.status(500).json({ error: errDel.message });

                    const [startH, startM] = start_time.split(':').map(Number);
                    const [endH, endM] = end_time.split(':').map(Number);

                    let startTotalMins = startH * 60 + startM;
                    let endTotalMins = endH * 60 + endM;

                    if (endTotalMins <= startTotalMins) {
                        endTotalMins += 24 * 60; 
                    }

                    const contactCount = contactList.length;
                    if (contactCount === 0) {
                        return res.status(200).json({ message: 'Automation updated, no pending contacts found', id });
                    }

                    const nowUTC = new Date();
                    let clientNow = new Date(nowUTC.getTime() - (offsetMins * 60000));
                    const clientCurrentTotalMins = clientNow.getUTCHours() * 60 + clientNow.getUTCMinutes();

                    let clientBaseDate = new Date(clientNow);
                    clientBaseDate.setUTCHours(startH, startM, 0, 0);

                    if (clientCurrentTotalMins > startTotalMins) {
                        if (clientCurrentTotalMins < endTotalMins) {
                            clientBaseDate.setUTCHours(clientNow.getUTCHours(), clientNow.getUTCMinutes(), 0, 0);
                        } else {
                            clientBaseDate.setUTCDate(clientBaseDate.getUTCDate() + 1);
                            clientBaseDate.setUTCHours(startH, startM, 0, 0);
                        }
                    } else {
                        clientBaseDate.setUTCHours(startH, startM, 0, 0);
                    }

                    while (!daysArray.includes(clientBaseDate.getDay())) {
                        clientBaseDate.setUTCDate(clientBaseDate.getUTCDate() + 1);
                        clientBaseDate.setUTCHours(startH, startM, 0, 0);
                    }

                    let absoluteBaseDateUTC = new Date(clientBaseDate.getTime() + (offsetMins * 60000));

                    let clientEndTime = new Date(clientBaseDate);
                    clientEndTime.setUTCHours(endH, endM, 0, 0);
                    if (clientEndTime <= clientBaseDate) {
                        clientEndTime.setUTCDate(clientEndTime.getUTCDate() + 1);
                    }
                    
                    const adjustedWindowMinutes = (clientEndTime - clientBaseDate) / (1000 * 60);
                    const actualBaseInterval = Math.max(adjustedWindowMinutes / Math.max(contactCount, 1), 1); 

                    let currentTimeOffset = 0;

                    contactList.forEach((contactPhone) => {
                        const jitterMs = (Math.random() * 0.6 - 0.3) * actualBaseInterval * 60 * 1000;
                        currentTimeOffset += actualBaseInterval;
                        const scheduledTime = new Date(absoluteBaseDateUTC.getTime() + (currentTimeOffset * 60 * 1000) + jitterMs);

                        db.get("SELECT id FROM contacts WHERE phone = ? AND org_id = ?", [contactPhone, orgId], (errC, row) => {
                            let cId;
                            if (row) {
                                cId = row.id;
                                insertLogAndReminder(cId, scheduledTime);
                            } else {
                                db.run("INSERT INTO contacts (org_id, name, phone) VALUES (?, ?, ?)", [orgId, 'Unknown', contactPhone], function (errInsert) {
                                    if (!errInsert) {
                                        cId = this.lastID;
                                        insertLogAndReminder(cId, scheduledTime);
                                    }
                                });
                            }
                        });

                        function insertLogAndReminder(contactId, scheduleDate) {
                            db.run(`INSERT INTO automation_logs (automation_id, contact_id, status) VALUES (?, ?, 'pending')`, [id, contactId], function (errLog) {
                                if (!errLog) {
                                    const logId = this.lastID;
                                    const isoString = scheduleDate.toISOString();
                                    db.run(`UPDATE automation_logs SET sent_time = ? WHERE id = ?`, [isoString, logId]);
                                }
                            });
                        }
                    });

                    res.status(200).json({ message: 'Automation updated and rescheduled successfully', id });
                });
            });
    });
});

app.delete('/api/automations/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const orgId = req.user.org_id;
    
    // Ensure ownership before delete
    db.get('SELECT id FROM automations WHERE id = ? AND org_id = ?', [id, orgId], (errCheck, rowCheck) => {
        if (errCheck || !rowCheck) return res.status(403).json({ error: 'Not authorized or automation not found' });
        
        // Remove only pending logs so we don't process them anymore
        db.run('DELETE FROM automation_logs WHERE automation_id = ? AND status = "pending"', [id], (errLog) => {
            if (errLog) return res.status(500).json({ error: errLog.message });
            
            // Soft delete the automation to keep Delivered logs intact
            db.run('UPDATE automations SET status = "Deleted" WHERE id = ? AND org_id = ?', [id, orgId], (errAuto) => {
                if (errAuto) return res.status(500).json({ error: errAuto.message });
                res.json({ message: 'Automation deleted successfully' });
            });
        });
    });
});

app.patch('/api/automations/:id/toggle', authenticateToken, (req, res) => {
    const { id } = req.params;
    const orgId = req.user.org_id;
    
    db.get('SELECT status FROM automations WHERE id = ? AND org_id = ?', [id, orgId], (errCheck, rowCheck) => {
        if (errCheck || !rowCheck) return res.status(403).json({ error: 'Not authorized or automation not found' });
        
        const newStatus = rowCheck.status === 'Active' ? 'Paused' : 'Active';
        db.run('UPDATE automations SET status = ? WHERE id = ?', [newStatus, id], (errUpdate) => {
             if (errUpdate) return res.status(500).json({ error: errUpdate.message });
             res.json({ message: 'Status updated', status: newStatus });
        });
    });
});

// ============================================================
//  MolarPlus integration API (headless WhatsApp sessions)
//  Registered before the SPA catch-all so /api/* is never shadowed.
// ============================================================

// ── MolarPlus session API — REMOVED ──────────────────────────────────────────
// Six /api/sessions routes and four /api/clinic routes lived here. Four of them
// had no authentication at all, and POST /api/sessions returned the *existing*
// api_key for a guessable sequential clinic_id — anyone could enumerate ids,
// harvest every tenant's key, send WhatsApp messages from their real number,
// read their history, and unpair their phone.
//
// It is deleted rather than patched because the per-user API key in
// publicApi.js supersedes it: a user IS the account, so a parallel session
// identity has nothing left to do. api_sessions and api_messages were both
// empty — the stack was never used in production.
//
// Anything that needs programmatic sending now uses /api/v1 with a user key.


// Fallback route for React Router
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        return next(); // Don't serve index.html for API 404s
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
const PORT = process.env.PORT || 3000;
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// We need socket auth to map them to user rooms
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
        return next(new Error("Authentication error: No token provided"));
    }
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return next(new Error("Authentication error: Invalid token"));
        if (!user.id) return next(new Error("Authentication error: Not a user token"));
        socket.user = user;
        next();
    });
});

// Pass io to whatsapp client
whatsappClient.setIo(io);

io.on('connection', (socket) => {
    // `socket.user.id` is the USER; the WhatsApp number, the contacts and the
    // inbox all belong to the ORG. These were the same integer before the
    // multi-tenant migration and are now two different UUIDs, so every emit
    // aimed at `user_<orgId>` was landing in an empty room — status updates,
    // inbound replies and notifications all silently went nowhere.
    const { id: userId, org_id: orgId, username } = socket.user;
    socket.join(`org_${orgId}`);
    socket.join(`user_${userId}`);

    socket.emit('wa_status', whatsappClient.getStatus(orgId));

    // Presence, so two agents on one number can see each other.
    socket.to(`org_${orgId}`).emit('presence', { userId, username, online: true });
    socket.on('presence:who', () => {
        socket.to(`org_${orgId}`).emit('presence:ping', { userId, username });
    });
    socket.on('presence:pong', () => {
        socket.to(`org_${orgId}`).emit('presence', { userId, username, online: true });
    });

    // Typing indicators are agent-to-agent — "someone else is already
    // answering this" — and never reach the patient.
    socket.on('inbox:typing', ({ conversationId, typing }) => {
        if (!conversationId) return;
        socket.to(`org_${orgId}`).emit('inbox:typing', {
            conversationId, userId, username, typing: !!typing,
        });
    });

    socket.on('disconnect', () => {
        socket.to(`org_${orgId}`).emit('presence', { userId, username, online: false });
    });
});

server.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Evolution owns session persistence, so boot just reconciles our cache
    // with what it already has. No staggering — that only existed to avoid
    // launching several Chromium processes at once.
    // Instance names must be in memory before any send resolves one.
    await require('./orgInstances').load().catch(e => console.error('[instances] load failed:', e.message));

    db.all('SELECT id FROM organisations', [], async (err, rows) => {
        const userIds = (!err && rows) ? rows.map(r => r.id) : [];
        await whatsappClient.bootAll(userIds).catch(e => console.error('[WA] bootAll error:', e.message));
    });
});
