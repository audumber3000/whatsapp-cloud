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
        req.user = user;
        next();
    });
};

// --- Auth Endpoints ---
app.post('/api/signup', throttleAuth, async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword], function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ message: 'User created successfully' });
        });
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
            if (await bcrypt.compare(password, user.password)) {
                whatsappClient.initializeUserClient(user.id);
                clearAuthAttempts(req);
                const accessToken = jwt.sign({ username: user.username, id: user.id }, JWT_SECRET, { expiresIn: config.jwtExpiresIn });
                res.json({ accessToken });
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
        SELECT u.id, u.username, u.email, u.personal_whatsapp_number,
               COUNT(DISTINCT a.id) as total_automations,
               COUNT(DISTINCT al.id) as total_messages
        FROM users u
        LEFT JOIN automations a ON u.id = a.user_id AND a.status != 'Deleted'
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
    db.get('SELECT email, personal_whatsapp_number FROM users WHERE id = ?', [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || { email: '', personal_whatsapp_number: '' });
    });
});

app.put('/api/settings', authenticateToken, (req, res) => {
    const { email, personal_whatsapp_number } = req.body;
    
    // Clean and validate recipients
    const cleanEmail = email ? email.split(',').map(e => e.trim()).filter(Boolean).join(',') : '';
    const cleanPhone = personal_whatsapp_number ? personal_whatsapp_number.split(',').map(p => p.trim()).filter(Boolean).join(',') : '';

    db.run(`UPDATE users SET email = ?, personal_whatsapp_number = ? WHERE id = ?`, [cleanEmail, cleanPhone, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: 'Failed to update settings' });
        res.json({ message: 'Settings updated successfully' });
    });
});

app.get('/api/notifications/logs', authenticateToken, (req, res) => {
    db.all('SELECT * FROM notification_logs WHERE user_id = ? ORDER BY sent_at DESC LIMIT 50', [req.user.id], (err, rows) => {
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
            `INSERT INTO media_attachments (user_id, original_name, stored_name, mimetype, size) VALUES (?, ?, ?, ?, ?)`,
            [req.user.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size],
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
    db.get('SELECT * FROM media_attachments WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, row) => {
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
    db.get('SELECT * FROM media_attachments WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        fs.unlink(path.join(MEDIA_DIR, row.stored_name), () => {});
        db.run('DELETE FROM media_attachments WHERE id = ?', [req.params.id], () => res.json({ message: 'Deleted' }));
    });
});

// --- API Endpoints ---
app.get('/api/wa/status', authenticateToken, (req, res) => {
    const status = whatsappClient.getStatus(req.user.id);
    console.log(`WA Status requested for user ${req.user.id}. isConnected:`, status.isConnected, 'QR length:', status.currentQR ? status.currentQR.length : 0);
    res.json(status);
});

app.post('/api/wa/disconnect', authenticateToken, async (req, res) => {
    try {
        const success = await whatsappClient.disconnectClient(req.user.id);
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
app.get('/api/contacts', authenticateToken, (req, res) => {
    const search = (req.query.search || '').trim();
    let sql = 'SELECT * FROM contacts WHERE user_id = ?';
    const params = [req.user.id];
    if (search) {
        sql += ' AND (name LIKE ? OR phone LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    sql += ' ORDER BY name COLLATE NOCASE ASC';
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

const cleanPhone = (p) => String(p || '').replace(/[^\d]/g, '');

// Add a contact
app.post('/api/contacts', authenticateToken, (req, res) => {
    const name = (req.body.name || '').trim();
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'A valid phone number is required' });
    db.run('INSERT INTO contacts (user_id, name, phone) VALUES (?, ?, ?)', [req.user.id, name, phone], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Contact already exists for this user' });
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, name, phone });
    });
});

// Edit a contact
app.put('/api/contacts/:id', authenticateToken, (req, res) => {
    const name = (req.body.name || '').trim();
    const phone = cleanPhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'A valid phone number is required' });
    db.run('UPDATE contacts SET name = ?, phone = ? WHERE id = ? AND user_id = ?',
        [name, phone, req.params.id, req.user.id], function (err) {
            if (err) {
                if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Another contact already uses this number' });
                return res.status(500).json({ error: err.message });
            }
            if (this.changes === 0) return res.status(404).json({ error: 'Contact not found' });
            res.json({ id: Number(req.params.id), name, phone });
        });
});

// Delete a contact
app.delete('/api/contacts/:id', authenticateToken, (req, res) => {
    db.run('DELETE FROM contacts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Contact not found' });
        res.json({ message: 'Deleted' });
    });
});

// Bulk import contacts. Accepts { contacts: [{name, phone}] }.
app.post('/api/contacts/bulk', authenticateToken, (req, res) => {
    const list = Array.isArray(req.body.contacts) ? req.body.contacts : [];
    if (list.length === 0) return res.status(400).json({ error: 'No contacts provided' });

    let added = 0, skipped = 0, processed = 0;
    const done = () => { if (++processed === list.length) res.json({ added, skipped }); };
    list.forEach((c) => {
        const phone = cleanPhone(c.phone);
        const name = (c.name || '').trim();
        if (!phone) { skipped++; return done(); }
        db.run('INSERT OR IGNORE INTO contacts (user_id, name, phone) VALUES (?, ?, ?)',
            [req.user.id, name, phone], function (err) {
                if (!err && this.changes > 0) added++; else skipped++;
                done();
            });
    });
});

// Get reminders
app.get('/api/reminders', authenticateToken, (req, res) => {
    db.all(`
    SELECT reminders.*, contacts.name, contacts.phone 
    FROM reminders 
    LEFT JOIN contacts ON reminders.contact_id = contacts.id
    WHERE reminders.user_id = ?
    ORDER BY scheduled_time ASC
  `, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a reminder
app.post('/api/reminders', authenticateToken, (req, res) => {
    const { contact_id, message, scheduled_time, media_id } = req.body;
    // Ensure contact exists for this user
    db.get('SELECT id FROM contacts WHERE id = ? AND user_id = ?', [contact_id, req.user.id], (errC, row) => {
        if (errC || !row) return res.status(400).json({ error: 'Invalid contact' });

        const insert = () => {
            db.run(`INSERT INTO reminders (user_id, contact_id, message, scheduled_time, status, media_id) VALUES (?, ?, ?, ?, 'pending', ?)`,
                [req.user.id, contact_id, message, scheduled_time, media_id || null],
                function (err) {
                    if (err) return res.status(500).json({ error: 'Could not create reminder' });
                    res.json({ id: this.lastID, contact_id, message, scheduled_time, status: 'pending', media_id: media_id || null });
                });
        };

        // media_id comes from the client and used to be inserted unchecked,
        // letting a reminder point at another tenant's attachment — which the
        // scheduler would then read and send out over WhatsApp.
        if (!media_id) return insert();
        db.get('SELECT id FROM media_attachments WHERE id = ? AND user_id = ?',
            [media_id, req.user.id], (eM, mRow) => {
                if (eM || !mRow) return res.status(400).json({ error: 'Unknown attachment' });
                insert();
            });
    });
});

// --- Inbox (two-way messaging) ---
// Nothing read inbound messages before Evolution; these expose what now lands.

// Conversation list: one row per contact, newest first, with unread counts.
app.get('/api/inbox', authenticateToken, (req, res) => {
    db.all(`
        SELECT im.contact_id,
               COALESCE(c.name, 'Unknown') AS name,
               im.from_number,
               COUNT(*) AS total,
               SUM(CASE WHEN im.is_read = 0 THEN 1 ELSE 0 END) AS unread,
               MAX(im.received_at) AS last_at,
               (SELECT body FROM inbound_messages x
                 WHERE x.user_id = im.user_id AND x.from_number = im.from_number
                 ORDER BY x.received_at DESC LIMIT 1) AS last_body,
               (SELECT intent FROM inbound_messages x
                 WHERE x.user_id = im.user_id AND x.from_number = im.from_number
                 ORDER BY x.received_at DESC LIMIT 1) AS last_intent,
               COALESCE(c.opted_out, 0) AS opted_out
        FROM inbound_messages im
        LEFT JOIN contacts c ON c.id = im.contact_id
        WHERE im.user_id = ?
        GROUP BY im.from_number
        ORDER BY last_at DESC
        LIMIT 100
    `, [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// Full thread with one contact: what they sent us, and what we sent them.
app.get('/api/inbox/:number', authenticateToken, (req, res) => {
    const num = String(req.params.number).replace(/\D/g, '');
    db.all(
        `SELECT id, body, media_type, media_path, intent, received_at, 'in' AS direction
           FROM inbound_messages WHERE user_id = ? AND from_number = ?
         UNION ALL
         SELECT al.id, al.content AS body, NULL, NULL,
                al.response AS intent, al.sent_time AS received_at, 'out' AS direction
           FROM automation_logs al
           JOIN contacts c ON c.id = al.contact_id
          WHERE c.user_id = ? AND c.phone = ? AND al.status IN ('delivered','sent','read','failed')
         ORDER BY received_at ASC LIMIT 200`,
        [req.user.id, num, req.user.id, num],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            db.run('UPDATE inbound_messages SET is_read = 1 WHERE user_id = ? AND from_number = ?',
                [req.user.id, num]);
            res.json(rows || []);
        }
    );
});

// Reply by hand from the inbox.
app.post('/api/inbox/:number/reply', authenticateToken, async (req, res) => {
    const num = String(req.params.number).replace(/\D/g, '');
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required' });

    await whatsappClient.showTyping(req.user.id, num, 1200).catch(() => {});
    const ok = await whatsappClient.sendMessage(req.user.id, num, text.trim());
    if (!ok) return res.status(409).json({ error: 'WhatsApp is not connected' });
    res.json({ success: true, message_id: typeof ok === 'string' ? ok : null });
});

// --- Contact health ---

// Ask WhatsApp which of these numbers actually exist before we burn sends on them.
app.post('/api/contacts/validate', authenticateToken, async (req, res) => {
    db.all('SELECT phone FROM contacts WHERE user_id = ?', [req.user.id], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const numbers = (rows || []).map(r => r.phone).filter(Boolean);
        if (!numbers.length) return res.json({ checked: 0, invalid: 0 });

        const result = await whatsappClient.validateNumbers(req.user.id, numbers);
        if (!result) return res.status(409).json({ error: 'WhatsApp is not connected' });

        db.get('SELECT COUNT(*) AS n FROM contacts WHERE user_id = ? AND wa_valid = 0',
            [req.user.id], (e2, row) => {
                res.json({ checked: numbers.length, invalid: row ? row.n : 0 });
            });
    });
});

// Manual opt-out toggle, for when someone asks the front desk directly.
app.patch('/api/contacts/:id/optout', authenticateToken, (req, res) => {
    const optOut = req.body?.opted_out ? 1 : 0;
    db.run(
        `UPDATE contacts SET opted_out = ?, opted_out_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE id = ? AND user_id = ?`,
        [optOut, optOut, req.params.id, req.user.id],
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
    const since = req.query.since || 'start of day';
    db.all(`
        SELECT
          SUM(CASE WHEN al.response = 'confirm'    THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN al.response = 'reschedule' THEN 1 ELSE 0 END) AS reschedule,
          SUM(CASE WHEN al.response = 'cancel'     THEN 1 ELSE 0 END) AS cancelled,
          SUM(CASE WHEN al.response IS NULL        THEN 1 ELSE 0 END) AS no_reply,
          COUNT(*) AS total
        FROM automation_logs al
        JOIN automations a ON a.id = al.automation_id
        WHERE a.user_id = ?
          AND al.status IN ('delivered','sent','read')
          AND al.sent_time >= datetime('now', ?)
    `, [req.user.id, since === 'start of day' ? 'start of day' : since], (err, rows) => {
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
            WHERE a.user_id = ? AND al.response IS NOT NULL
              AND al.sent_time >= datetime('now', 'start of day')
            ORDER BY al.responded_at DESC LIMIT 50
        `, [req.user.id], (e2, detail) => {
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
         WHERE im.user_id = ?
        UNION ALL
        SELECT 'outbound' AS kind, al.sent_time AS at,
               COALESCE(c.name, 'Unknown') AS who, c.phone AS phone,
               al.content AS text, al.response AS detail, al.status AS status
          FROM automation_logs al
          JOIN automations a ON a.id = al.automation_id
          LEFT JOIN contacts c ON c.id = al.contact_id
         WHERE a.user_id = ? AND al.status != 'pending'
        ORDER BY at DESC
        LIMIT ?
    `, [req.user.id, req.user.id, limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// --- API key management (dashboard-authenticated) ---

app.get('/api/apikey', authenticateToken, (req, res) => {
    db.get('SELECT api_key, api_key_created_at FROM users WHERE id = ?', [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ api_key: row?.api_key || null, created_at: row?.api_key_created_at || null });
    });
});

// Also used to rotate: issuing a new key immediately invalidates the old one.
app.post('/api/apikey', authenticateToken, async (req, res) => {
    try {
        const key = await publicApi.issueKey(req.user.id);
        res.json({ api_key: key, created_at: new Date().toISOString() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/apikey', authenticateToken, (req, res) => {
    db.run('UPDATE users SET api_key = NULL, api_key_created_at = NULL WHERE id = ?', [req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- Health ---
app.get('/api/health/alerts', authenticateToken, (req, res) => {
    db.all('SELECT kind, detail, created_at FROM health_alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
        [req.user.id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows || []);
        });
});

// --- Dashboard & Meta Endpoints ---
app.get('/api/dashboard/stats', authenticateToken, (req, res) => {
    const stats = { sent: 0, failed: 0, activeAutomations: 0, phone: whatsappClient.getStatus(req.user.id).phone };
    
    db.get(`SELECT COUNT(*) as count FROM automation_logs al JOIN automations a ON al.automation_id = a.id WHERE a.user_id = ? AND (al.status = 'delivered' OR al.status = 'read' OR al.status = 'sent')`, [req.user.id], (err, row) => {
        if (!err && row) stats.sent = row.count;

        db.get(`SELECT COUNT(*) as count FROM automation_logs al JOIN automations a ON al.automation_id = a.id WHERE a.user_id = ? AND al.status = 'failed'`, [req.user.id], (err2, row2) => {
            if (!err2 && row2) stats.failed = row2.count;

            db.get(`SELECT COUNT(*) as count FROM automations WHERE user_id = ? AND status = 'Active'`, [req.user.id], (err3, row3) => {
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
        SELECT strftime('%H:00', sent_time) as hour, COUNT(*) as count, sent_time
        FROM automation_logs al
        JOIN automations a ON al.automation_id = a.id
        WHERE a.user_id = ? AND al.status IN ('delivered', 'read', 'sent') AND al.sent_time >= ?
        GROUP BY strftime('%Y-%m-%d %H:00:00', sent_time)
        ORDER BY sent_time ASC
    `;

    db.all(query, [req.user.id, twentyFourHoursAgo], (err, rows) => {
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

    let whereClause = `a.user_id = ?`;
    let queryParams = [req.user.id];

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
        WHERE a.user_id = ? AND a.status != 'Deleted'
        ORDER BY a.id DESC
    `, [req.user.id], (err, rows) => {
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

    const userId = req.user.id;

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

    db.run(`INSERT INTO automations (user_id, name, start_time, end_time, message_template, status, active_days, timezone_offset, ask_confirmation) VALUES (?, ?, ?, ?, ?, 'Active', ?, ?, ?)`,
        [userId, name, start_time, end_time, msgTemplateStr, daysJson, offsetMins, ask_confirmation ? 1 : 0],
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

                db.get("SELECT id FROM contacts WHERE phone = ? AND user_id = ?", [contactPhone, userId], (errC, row) => {
                    let cId;
                    if (row) {
                        cId = row.id;
                        insertLogAndReminder(cId, scheduledTime);
                    } else {
                        db.run("INSERT INTO contacts (user_id, name, phone) VALUES (?, ?, ?)", [userId, 'Unknown', contactPhone], function (errInsert) {
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
    db.get(`SELECT * FROM automations WHERE id = ? AND user_id = ?`, [id, req.user.id], (err, row) => {
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

    const userId = req.user.id;

    // First ensure ownership
    db.get('SELECT id FROM automations WHERE id = ? AND user_id = ?', [id, userId], (errCheck, rowCheck) => {
        if (errCheck || !rowCheck) return res.status(403).json({ error: 'Not authorized or automation not found' });

        const offsetMins = clientOffset !== undefined ? clientOffset : new Date().getTimezoneOffset();
        const daysArray = active_days || [0, 1, 2, 3, 4, 5, 6];
        const daysJson = JSON.stringify(daysArray);

        let msgTemplateStr = message_template;
        if (typeof msgTemplateStr === 'object') {
            msgTemplateStr = JSON.stringify(msgTemplateStr);
        }

        db.run(`UPDATE automations SET name = ?, start_time = ?, end_time = ?, message_template = ?, active_days = ?, timezone_offset = ?, ask_confirmation = ? WHERE id = ? AND user_id = ?`,
            [name, start_time, end_time, msgTemplateStr, daysJson, offsetMins, ask_confirmation ? 1 : 0, id, userId],
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

                        db.get("SELECT id FROM contacts WHERE phone = ? AND user_id = ?", [contactPhone, userId], (errC, row) => {
                            let cId;
                            if (row) {
                                cId = row.id;
                                insertLogAndReminder(cId, scheduledTime);
                            } else {
                                db.run("INSERT INTO contacts (user_id, name, phone) VALUES (?, ?, ?)", [userId, 'Unknown', contactPhone], function (errInsert) {
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
    const userId = req.user.id;
    
    // Ensure ownership before delete
    db.get('SELECT id FROM automations WHERE id = ? AND user_id = ?', [id, userId], (errCheck, rowCheck) => {
        if (errCheck || !rowCheck) return res.status(403).json({ error: 'Not authorized or automation not found' });
        
        // Remove only pending logs so we don't process them anymore
        db.run('DELETE FROM automation_logs WHERE automation_id = ? AND status = "pending"', [id], (errLog) => {
            if (errLog) return res.status(500).json({ error: errLog.message });
            
            // Soft delete the automation to keep Delivered logs intact
            db.run('UPDATE automations SET status = "Deleted" WHERE id = ? AND user_id = ?', [id, userId], (errAuto) => {
                if (errAuto) return res.status(500).json({ error: errAuto.message });
                res.json({ message: 'Automation deleted successfully' });
            });
        });
    });
});

app.patch('/api/automations/:id/toggle', authenticateToken, (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    
    db.get('SELECT status FROM automations WHERE id = ? AND user_id = ?', [id, userId], (errCheck, rowCheck) => {
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
    const userId = socket.user.id;
    console.log(`User ${userId} connected via socket`);
    
    // Join a room specific to this user so we can emit targeted status updates
    socket.join(`user_${userId}`);
    
    // Send current status on connection
    socket.emit('wa_status', whatsappClient.getStatus(userId));
    
    socket.on('disconnect', () => {
        console.log(`User ${userId} disconnected via socket`);
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Evolution owns session persistence, so boot just reconciles our cache
    // with what it already has. No staggering — that only existed to avoid
    // launching several Chromium processes at once.
    db.all('SELECT id FROM users', [], async (err, rows) => {
        const userIds = (!err && rows) ? rows.map(r => r.id) : [];
        await whatsappClient.bootAll(userIds).catch(e => console.error('[WA] bootAll error:', e.message));
    });
});
