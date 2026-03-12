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

// --- API Endpoints ---
app.get('/api/wa/status', authenticateToken, (req, res) => {
    const status = whatsappClient.getStatus();
    console.log('WA Status requested. isConnected:', status.isConnected, 'QR length:', status.currentQR ? status.currentQR.length : 0);
    res.json(status);
});

// DEBUG ONLY: Remove before production
app.get('/api/debug/wa-status', (req, res) => {
    res.json(whatsappClient.getStatus());
});

app.post('/api/wa/disconnect', authenticateToken, async (req, res) => {
    try {
        const success = await whatsappClient.disconnectClient();
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
    db.all('SELECT * FROM contacts', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a contact
app.post('/api/contacts', authenticateToken, (req, res) => {
    const { name, phone } = req.body;
    db.run('INSERT INTO contacts (name, phone) VALUES (?, ?)', [name, phone], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name, phone });
    });
});

// Get reminders
app.get('/api/reminders', authenticateToken, (req, res) => {
    db.all(`
    SELECT reminders.*, contacts.name, contacts.phone 
    FROM reminders 
    LEFT JOIN contacts ON reminders.contact_id = contacts.id
    ORDER BY scheduled_time ASC
  `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a reminder
app.post('/api/reminders', authenticateToken, (req, res) => {
    const { contact_id, message, scheduled_time } = req.body;
    // scheduled_time should be in a format parseable by node-cron or simple cron string
    db.run(`INSERT INTO reminders (contact_id, message, scheduled_time, status) VALUES (?, ?, ?, 'pending')`,
        [contact_id, message, scheduled_time],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, contact_id, message, scheduled_time, status: 'pending' });
        });
});

// --- Dashboard & Meta Endpoints ---
app.get('/api/dashboard/stats', authenticateToken, (req, res) => {
    const stats = { sent: 0, failed: 0, activeAutomations: 0 };
    db.get("SELECT COUNT(*) as count FROM automation_logs WHERE status = 'delivered' OR status = 'read' OR status = 'sent'", [], (err, row) => {
        if (!err && row) stats.sent = row.count;

        db.get("SELECT COUNT(*) as count FROM automation_logs WHERE status = 'failed'", [], (err2, row2) => {
            if (!err2 && row2) stats.failed = row2.count;

            db.get("SELECT COUNT(*) as count FROM automations WHERE status = 'Active'", [], (err3, row3) => {
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

    const countQuery = "SELECT COUNT(*) as total FROM automation_logs";
    db.get(countQuery, [], (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });

        const total = countRow.total;

        const dataQuery = `
            SELECT al.*, c.phone as contact, a.name as workflow 
            FROM automation_logs al
            LEFT JOIN contacts c ON al.contact_id = c.id
            LEFT JOIN automations a ON al.automation_id = a.id
            ORDER BY al.id DESC
            LIMIT ? OFFSET ?
        `;

        db.all(dataQuery, [limit, offset], (err2, rows) => {
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
    // Basic query, ignoring relationships for counts for now to keep it simple, or joining
    db.all(`
        SELECT a.*, (SELECT COUNT(*) FROM automation_logs WHERE automation_id = a.id) as count 
        FROM automations a
        ORDER BY a.id DESC
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post('/api/automations', authenticateToken, (req, res) => {
    const { name, start_time, end_time, message_template, contacts, clientOffset, active_days } = req.body;

    // Default to server offset if not provided (for older clients)
    const offsetMins = clientOffset !== undefined ? clientOffset : new Date().getTimezoneOffset();
    const daysArray = active_days || [0, 1, 2, 3, 4, 5, 6];
    const daysJson = JSON.stringify(daysArray);

    // 1. Insert Automation rule
    db.run(`INSERT INTO automations (name, start_time, end_time, message_template, status, active_days) VALUES (?, ?, ?, ?, 'Active', ?)`,
        [name, start_time, end_time, message_template, daysJson],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });

            const automationId = this.lastID;

            // 2. Schedule the messages inside the time window according to the CLIENT's timezone.
            const [startH, startM] = start_time.split(':').map(Number);
            const [endH, endM] = end_time.split(':').map(Number);

            let startTotalMins = startH * 60 + startM;
            let endTotalMins = endH * 60 + endM;

            if (endTotalMins <= startTotalMins) {
                endTotalMins += 24 * 60; // handles overnight
            }

            const contactCount = contacts.length;
            
            // Get the current UTC time
            const nowUTC = new Date();
            
            // Calculate what time it is for the client RIGHT NOW.
            // getTimezoneOffset() returns minutes *behind* UTC. So to get client local time, we subtract offset.
            // Example: UTC is 10:00, India is UTC+5:30. India offset is -330. 10:00 - (-330) = 15:30 local time.
            let clientNow = new Date(nowUTC.getTime() - (offsetMins * 60000));
            
            const clientCurrentTotalMins = clientNow.getUTCHours() * 60 + clientNow.getUTCMinutes();

            // We need a baseDate representing the start of the window in absolute UTC time.
            let baseDateUTC = new Date(nowUTC);
            // reset to start of client's current day in UTC
            // clientNow.getUTCDate() gets the client's calendar day.
            // To make a UTC Date object that represents midnight in the client's timezone:
            // Just take clientNow, set time to startH:startM, then convert back to true UTC.
            
            let clientBaseDate = new Date(clientNow);
            clientBaseDate.setUTCHours(startH, startM, 0, 0);

            // Time window logic relative to the client's clock
            if (clientCurrentTotalMins > startTotalMins) {
                if (clientCurrentTotalMins < endTotalMins) {
                    // Inside window
                    clientBaseDate.setUTCHours(clientNow.getUTCHours(), clientNow.getUTCMinutes(), 0, 0);
                } else {
                    // Missed window, schedule tomorrow
                    clientBaseDate.setUTCDate(clientBaseDate.getUTCDate() + 1);
                    clientBaseDate.setUTCHours(startH, startM, 0, 0);
                }
            } else {
                // Before window today
                clientBaseDate.setUTCHours(startH, startM, 0, 0);
            }

            // Fast-forward clientBaseDate if the day it landed on is not active
            while (!daysArray.includes(clientBaseDate.getDay())) {
                clientBaseDate.setUTCDate(clientBaseDate.getUTCDate() + 1);
                // When we skip a day, the start time is definitely valid from the very beginning of the window
                clientBaseDate.setUTCHours(startH, startM, 0, 0);
            }

            // Convert clientBaseDate back to absolute UTC by adding the offset back
            let absoluteBaseDateUTC = new Date(clientBaseDate.getTime() + (offsetMins * 60000));

            // Calculate end time
            let clientEndTime = new Date(clientBaseDate);
            clientEndTime.setUTCHours(endH, endM, 0, 0);
            if (clientEndTime <= clientBaseDate) {
                clientEndTime.setUTCDate(clientEndTime.getUTCDate() + 1);
            }
            
            const adjustedWindowMinutes = (clientEndTime - clientBaseDate) / (1000 * 60);
            const actualBaseInterval = Math.max(adjustedWindowMinutes / Math.max(contactCount, 1), 1); 

            let currentTimeOffset = 0;
            
            contacts.forEach((contactPhone, index) => {
                // Apply jitter (±30% of base interval)
                const jitterMs = (Math.random() * 0.6 - 0.3) * actualBaseInterval * 60 * 1000;

                // Calculate precise scheduled time in absolute UTC
                currentTimeOffset += actualBaseInterval;
                const scheduledTime = new Date(absoluteBaseDateUTC.getTime() + (currentTimeOffset * 60 * 1000) + jitterMs);;

                // Ensure contact exists or create
                db.get("SELECT id FROM contacts WHERE phone = ?", [contactPhone], (errC, row) => {
                    let cId;
                    if (row) {
                        cId = row.id;
                        insertLogAndReminder(cId, scheduledTime);
                    } else {
                        db.run("INSERT INTO contacts (name, phone) VALUES (?, ?)", ['Unknown', contactPhone], function (errInsert) {
                            cId = this.lastID;
                            insertLogAndReminder(cId, scheduledTime);
                        });
                    }
                });

                function insertLogAndReminder(contactId, scheduleDate) {
                    db.run(`INSERT INTO automation_logs (automation_id, contact_id, status) VALUES (?, ?, 'pending')`, [automationId, contactId], function (errLog) {
                        const logId = this.lastID;
                        const isoString = scheduleDate.toISOString();
                        db.run(`UPDATE automation_logs SET sent_time = ? WHERE id = ?`, [isoString, logId]);
                    });
                }
            });

            res.status(201).json({ message: 'Automation created and scheduled successfully', id: automationId });
        });
});

app.get('/api/automations/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    db.get(`SELECT * FROM automations WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Automation not found' });
        
        // Also fetch the list of contacts for this automation
        db.all(`
            SELECT DISTINCT c.phone 
            FROM automation_logs al
            JOIN contacts c ON al.contact_id = c.id
            WHERE al.automation_id = ?
        `, [id], (errC, phoneRows) => {
            if (errC) return res.status(500).json({ error: errC.message });
            row.contacts = phoneRows.map(p => p.phone);
            res.json(row);
        });
    });
});

app.put('/api/automations/:id', authenticateToken, (req, res) => {
    const { id } = req.params;
    const { name, start_time, end_time, message_template, contacts, clientOffset, active_days } = req.body;

    const offsetMins = clientOffset !== undefined ? clientOffset : new Date().getTimezoneOffset();
    const daysArray = active_days || [0, 1, 2, 3, 4, 5, 6];
    const daysJson = JSON.stringify(daysArray);

    // 1. Update Automation rule
    db.run(`UPDATE automations SET name = ?, start_time = ?, end_time = ?, message_template = ?, active_days = ? WHERE id = ?`,
        [name, start_time, end_time, message_template, daysJson, id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });

            // 2. Delete existing pending logs for this automation so we can reschedule
            db.run(`DELETE FROM automation_logs WHERE automation_id = ? AND status = 'pending'`, [id], function (errDel) {
                if (errDel) return res.status(500).json({ error: errDel.message });

                // 3. Reschedule the messages inside the new time window according to the CLIENT's timezone
                const [startH, startM] = start_time.split(':').map(Number);
                const [endH, endM] = end_time.split(':').map(Number);

                let startTotalMins = startH * 60 + startM;
                let endTotalMins = endH * 60 + endM;

                if (endTotalMins <= startTotalMins) {
                    endTotalMins += 24 * 60; // handles overnight
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

                // Fast-forward clientBaseDate if the day it landed on is not active
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

                contacts.forEach((contactPhone, index) => {
                    const jitterMs = (Math.random() * 0.6 - 0.3) * actualBaseInterval * 60 * 1000;
                    currentTimeOffset += actualBaseInterval;
                    const scheduledTime = new Date(absoluteBaseDateUTC.getTime() + (currentTimeOffset * 60 * 1000) + jitterMs);

                    db.get("SELECT id FROM contacts WHERE phone = ?", [contactPhone], (errC, row) => {
                        let cId;
                        if (row) {
                            cId = row.id;
                            insertLogAndReminder(cId, scheduledTime);
                        } else {
                            db.run("INSERT INTO contacts (name, phone) VALUES (?, ?)", ['Unknown', contactPhone], function (errInsert) {
                                cId = this.lastID;
                                insertLogAndReminder(cId, scheduledTime);
                            });
                        }
                    });

                    function insertLogAndReminder(contactId, scheduleDate) {
                        db.run(`INSERT INTO automation_logs (automation_id, contact_id, status) VALUES (?, ?, 'pending')`, [id, contactId], function (errLog) {
                            const logId = this.lastID;
                            const isoString = scheduleDate.toISOString();
                            db.run(`UPDATE automation_logs SET sent_time = ? WHERE id = ?`, [isoString, logId]);
                        });
                    }
                });

                res.status(200).json({ message: 'Automation updated and rescheduled successfully', id });
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

// Pass io to whatsapp client
whatsappClient.setIo(io);

io.on('connection', (socket) => {
    console.log('A user connected');
    // Send current status on connection
    socket.emit('wa_status', whatsappClient.getStatus());
    
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
