const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir);
}

const db = new sqlite3.Database(path.join(dbDir, 'whatsapp.sqlite'), (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.serialize(() => {
            // Create Contacts table
            db.run(`CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        phone TEXT UNIQUE NOT NULL
      )`);

            // Create Users table
            db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
      )`);

            // Create Reminders table
            db.run(`CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER,
        message TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        status TEXT DEFAULT 'pending', -- pending, sent, failed
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      )`);

            // Create Automations table
            db.run(`CREATE TABLE IF NOT EXISTS automations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        start_time TEXT NOT NULL, -- Format: HH:MM
        end_time TEXT NOT NULL, -- Format: HH:MM
        message_template TEXT NOT NULL,
        status TEXT DEFAULT 'Active', -- Active, Paused
        active_days TEXT DEFAULT '[1,2,3,4,5]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

            // Create Automation Logs table
            db.run(`CREATE TABLE IF NOT EXISTS automation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automation_id INTEGER,
        contact_id INTEGER,
        status TEXT DEFAULT 'pending', -- pending, delivered, read, failed
        error_reason TEXT,
        sent_time DATETIME,
        FOREIGN KEY (automation_id) REFERENCES automations(id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
      )`);
        });
    }
});

module.exports = db;
