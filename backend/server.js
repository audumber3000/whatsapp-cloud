const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('./db');
// We will import whatsapp and scheduler later
const whatsappClient = require('./whatsapp');
require('./scheduler');

const JWT_SECRET = 'super-secret-wa-reach-key-123'; // In prod, use environment variable

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

// --- Auth Endpoints ---
app.post('/api/signup', async (req, res) => {
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

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(400).json({ error: 'Cannot find user' });

        try {
            if (await bcrypt.compare(password, user.password)) {
                whatsappClient.initializeUserClient(user.id);
                const accessToken = jwt.sign({ username: user.username, id: user.id }, JWT_SECRET);
                res.json({ accessToken });
            } else {
                res.status(401).json({ error: 'Not Allowed' });
            }
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
});

// --- Master Admin Endpoints ---
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'Audumber' && password === 'Audumber') {
        const adminToken = jwt.sign({ username: 'Audumber', role: 'admin' }, JWT_SECRET);
        res.json({ accessToken: adminToken });
    } else {
        res.status(401).json({ error: 'Invalid admin credentials' });
    }
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
    db.run('UPDATE users SET email = ?, personal_whatsapp_number = ? WHERE id = ?', [email, personal_whatsapp_number, req.user.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Settings updated' });
    });
});

// --- API Endpoints ---
app.get('/api/wa/status', authenticateToken, (req, res) => {
    const status = whatsappClient.getStatus(req.user.id);
    console.log(`WA Status requested for user ${req.user.id}. isConnected:`, status.isConnected, 'QR length:', status.currentQR ? status.currentQR.length : 0);
    res.json(status);
});

// DEBUG ONLY: Remove before production
app.get('/api/debug/wa-status', (req, res) => {
    // Only use for testing without auth
    res.json(whatsappClient.getStatus(1)); // hardcoded user 1
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

// Get all contacts
app.get('/api/contacts', authenticateToken, (req, res) => {
    db.all('SELECT * FROM contacts WHERE user_id = ?', [req.user.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a contact
app.post('/api/contacts', authenticateToken, (req, res) => {
    const { name, phone } = req.body;
    db.run('INSERT INTO contacts (user_id, name, phone) VALUES (?, ?, ?)', [req.user.id, name, phone], function (err) {
        if (err) {
            if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Contact already exists for this user' });
            return res.status(500).json({ error: err.message });
        }
        res.json({ id: this.lastID, name, phone });
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
    const { contact_id, message, scheduled_time } = req.body;
    // Ensure contact exists for this user
    db.get('SELECT id FROM contacts WHERE id = ? AND user_id = ?', [contact_id, req.user.id], (errC, row) => {
        if (errC || !row) return res.status(400).json({ error: 'Invalid contact' });
        
        db.run(`INSERT INTO reminders (user_id, contact_id, message, scheduled_time, status) VALUES (?, ?, ?, ?, 'pending')`,
            [req.user.id, contact_id, message, scheduled_time],
            function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ id: this.lastID, contact_id, message, scheduled_time, status: 'pending' });
            });
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

app.get('/api/logs', authenticateToken, (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const countQuery = `SELECT COUNT(*) as total FROM automation_logs al JOIN automations a ON al.automation_id = a.id WHERE a.user_id = ?`;
    db.get(countQuery, [req.user.id], (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });

        const total = countRow.total;

        const dataQuery = `
            SELECT al.*, c.phone as contact, a.name as workflow 
            FROM automation_logs al
            LEFT JOIN contacts c ON al.contact_id = c.id
            LEFT JOIN automations a ON al.automation_id = a.id
            WHERE a.user_id = ?
            ORDER BY al.id DESC
            LIMIT ? OFFSET ?
        `;

        db.all(dataQuery, [req.user.id, limit, offset], (err2, rows) => {
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
    const { name, start_time, end_time, message_template, contacts, clientOffset, active_days } = req.body;
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

    db.run(`INSERT INTO automations (user_id, name, start_time, end_time, message_template, status, active_days) VALUES (?, ?, ?, ?, ?, 'Active', ?)`,
        [userId, name, start_time, end_time, msgTemplateStr, daysJson],
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

            const contactCount = contacts.length;
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
            
            contacts.forEach((contactPhone) => {
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
    const { name, start_time, end_time, message_template, contacts, clientOffset, active_days } = req.body;
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

        db.run(`UPDATE automations SET name = ?, start_time = ?, end_time = ?, message_template = ?, active_days = ? WHERE id = ? AND user_id = ?`,
            [name, start_time, end_time, msgTemplateStr, daysJson, id, userId],
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

                    const contactCount = contacts.length;
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

                    contacts.forEach((contactPhone) => {
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
    
    // On Server start, initialize active WhatsApp sessions for all users to catch background schedules
    db.all('SELECT id FROM users', [], async (err, rows) => {
        if (!err && rows.length > 0) {
            console.log(`Booting WhatsApp sessions for ${rows.length} users with staggering...`);
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                console.log(`Booting session for user ${row.id}...`);
                whatsappClient.initializeUserClient(row.id);
                if (i < rows.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, i === 0 ? 5000 : 10000));
                }
            }
        }
    });
});
