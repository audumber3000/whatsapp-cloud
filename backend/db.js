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
            // Ensure Users table exists with new columns
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                email TEXT,
                personal_whatsapp_number TEXT
            )`);
            
            // Safe migrations to add columns if they don't exist
            db.run(`ALTER TABLE users ADD COLUMN email TEXT`, (err) => {});
            db.run(`ALTER TABLE users ADD COLUMN personal_whatsapp_number TEXT`, (err) => {});

            // Create Contacts table (without global UNIQUE on phone)
            db.run(`CREATE TABLE IF NOT EXISTS contacts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                name TEXT,
                phone TEXT NOT NULL,
                UNIQUE(user_id, phone),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )`);

            // Safe migration for contacts
            db.run(`ALTER TABLE contacts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`, (err) => {
                if (!err) {
                    // If we successfully added user_id, it means this is an old DB.
                    // We might still have the global UNIQUE constraint on phone. 
                    // Let's migrate to a new table to drop that global unique constraint.
                    console.log("Migrating contacts table to support multi-tenancy...");
                    db.run(`ALTER TABLE contacts RENAME TO contacts_old`);
                    db.run(`CREATE TABLE contacts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        user_id INTEGER NOT NULL DEFAULT 1,
                        name TEXT,
                        phone TEXT NOT NULL,
                        UNIQUE(user_id, phone),
                        FOREIGN KEY (user_id) REFERENCES users(id)
                    )`);
                    db.run(`INSERT INTO contacts (id, user_id, name, phone) SELECT id, user_id, name, phone FROM contacts_old`);
                    db.run(`DROP TABLE contacts_old`);
                }
            });

            // Create Reminders table
            db.run(`CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                contact_id INTEGER,
                message TEXT NOT NULL,
                scheduled_time TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (contact_id) REFERENCES contacts(id)
            )`);
            db.run(`ALTER TABLE reminders ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`, (err) => {});

            // Create Automations table
            db.run(`CREATE TABLE IF NOT EXISTS automations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL DEFAULT 1,
                name TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT NOT NULL,
                message_template TEXT NOT NULL,
                status TEXT DEFAULT 'Active',
                active_days TEXT DEFAULT '[1,2,3,4,5]',
                last_summary_sent_date TEXT,
                last_start_notified_date TEXT,
                timezone_offset INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )`);
            db.run(`ALTER TABLE automations ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`, (err) => {});
            db.run(`ALTER TABLE automations ADD COLUMN last_summary_sent_date TEXT`, (err) => {});
            db.run(`ALTER TABLE automations ADD COLUMN last_start_notified_date TEXT`, (err) => {});
            db.run(`ALTER TABLE automations ADD COLUMN timezone_offset INTEGER DEFAULT 0`, (err) => {});

            // Create Automation Logs table
            db.run(`CREATE TABLE IF NOT EXISTS automation_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                automation_id INTEGER,
                contact_id INTEGER,
                status TEXT DEFAULT 'pending',
                error_reason TEXT,
                content TEXT,
                sent_time DATETIME,
                FOREIGN KEY (automation_id) REFERENCES automations(id),
                FOREIGN KEY (contact_id) REFERENCES contacts(id)
            )`);
            db.run(`ALTER TABLE automation_logs ADD COLUMN content TEXT`, (err) => {});

            // Create Notification Logs table
            db.run(`CREATE TABLE IF NOT EXISTS notification_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                category TEXT NOT NULL,
                recipient TEXT NOT NULL,
                content TEXT,
                status TEXT NOT NULL,
                sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )`);
        });
    }
});

module.exports = db;
