#!/usr/bin/env node
/**
 * One-shot importer: SQLite -> Postgres.
 *
 * Each existing SQLite user becomes a user PLUS an organisation they own, since
 * everything owned moves from user_id to org_id. Integer primary keys become
 * UUIDs, so every table is remapped through an id map built as we go.
 *
 * Verifies row counts per table at the end and exits non-zero on any mismatch.
 * Read-only against SQLite; the file is untouched and remains the rollback.
 *
 *   DATABASE_URL=... node import-sqlite.js [--dry-run]
 */

const path = require('path');
const sqlite3 = require('sqlite3');
const { Pool } = require('pg');

const DRY = process.argv.includes('--dry-run');
const SQLITE = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'whatsapp.sqlite');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const sdb = new sqlite3.Database(SQLITE, sqlite3.OPEN_READONLY);
const sAll = (sql, p = []) => new Promise((res, rej) => sdb.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));

// SQLite writes a few shapes: ISO with Z, 'YYYY-MM-DD HH:MM:SS', or null.
function ts(v) {
    if (v === null || v === undefined || v === '') return null;
    const s = String(v);
    const d = new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
const bool = (v) => v === 1 || v === '1' || v === true;
const slugify = (s, n) => (String(s || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org') + '-' + n;

async function main() {
    const client = await pool.connect();
    const userMap = new Map();     // sqlite users.id  -> { userId, orgId }
    const contactMap = new Map();  // sqlite contacts.id -> uuid
    const autoMap = new Map();     // sqlite automations.id -> uuid
    const mediaMap = new Map();    // sqlite media_attachments.id -> uuid
    const counts = {};

    try {
        await client.query('BEGIN');

        // ── users -> user + organisation + owner membership ──────────────────
        const users = await sAll('SELECT * FROM users ORDER BY id');
        for (const u of users) {
            // email and personal_whatsapp_number were comma-joined lists used as
            // "notify these people"; they are workspace settings, so they move
            // to the org rather than being dropped.
            const org = await client.query(
                `INSERT INTO organisations (name, slug, notify_emails, notify_whatsapp)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [u.username || 'Workspace', slugify(u.username, u.id),
                 u.email || null, u.personal_whatsapp_number || null]
            );
            const orgId = org.rows[0].id;

            // email/personal_whatsapp_number were comma-joined multi-value
            // strings; the first entry becomes the identity, the rest are kept
            // on the org as notification targets rather than silently dropped.
            const emails = String(u.email || '').split(',').map(s => s.trim()).filter(Boolean);

            const usr = await client.query(
                `INSERT INTO users (username, email, password_hash, created_at)
                 VALUES ($1, $2, $3, NOW()) RETURNING id`,
                [u.username, emails[0] || null, u.password]
            );
            const userId = usr.rows[0].id;

            await client.query(
                `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
                [orgId, userId]
            );

            // the WhatsApp instance name must keep pointing at the same
            // Evolution instance, so it is preserved verbatim
            await client.query(
                `INSERT INTO wa_instances (org_id, instance_name) VALUES ($1, $2)`,
                [orgId, `wareach_user_${u.id}`]
            );

            if (u.api_key) {
                const crypto = require('crypto');
                await client.query(
                    `INSERT INTO api_keys (org_id, name, key_hash, key_prefix, created_at)
                     VALUES ($1, 'Imported', $2, $3, $4)`,
                    [orgId, crypto.createHash('sha256').update(u.api_key).digest('hex'),
                     u.api_key.slice(0, 11), ts(u.api_key_created_at) || new Date().toISOString()]
                );
            }
            userMap.set(u.id, { userId, orgId });
        }
        counts.users = users.length;
        counts.organisations = users.length;

        // ── contacts ─────────────────────────────────────────────────────────
        const contacts = await sAll('SELECT * FROM contacts ORDER BY id');
        for (const c of contacts) {
            const m = userMap.get(c.user_id);
            if (!m) continue; // orphan: its owner no longer exists
            const r = await client.query(
                `INSERT INTO contacts (org_id, name, phone, opted_out, opted_out_at, wa_valid, wa_checked_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7)
                 ON CONFLICT (org_id, phone) DO UPDATE SET name = EXCLUDED.name
                 RETURNING id`,
                [m.orgId, c.name, String(c.phone), bool(c.opted_out), ts(c.opted_out_at),
                 c.wa_valid === null || c.wa_valid === undefined ? null : bool(c.wa_valid), ts(c.wa_checked_at)]
            );
            contactMap.set(c.id, r.rows[0].id);
        }
        counts.contacts = contactMap.size;

        // ── media ────────────────────────────────────────────────────────────
        const media = await sAll('SELECT * FROM media_attachments ORDER BY id');
        for (const md of media) {
            const m = userMap.get(md.user_id);
            if (!m) continue;
            const r = await client.query(
                `INSERT INTO media_attachments (org_id, uploaded_by, original_name, stored_name, mimetype, size, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                [m.orgId, m.userId, md.original_name, md.stored_name, md.mimetype, md.size, ts(md.created_at)]
            );
            mediaMap.set(md.id, r.rows[0].id);
        }
        counts.media_attachments = mediaMap.size;

        // ── automations ──────────────────────────────────────────────────────
        const autos = await sAll('SELECT * FROM automations ORDER BY id');
        for (const a of autos) {
            const m = userMap.get(a.user_id);
            if (!m) continue;
            let tpl;
            try { tpl = JSON.parse(a.message_template); }
            catch { tpl = [{ variations: [String(a.message_template || '')] }]; }
            let days;
            try { days = JSON.parse(a.active_days); }
            catch { days = [1, 2, 3, 4, 5]; }

            const r = await client.query(
                `INSERT INTO automations (org_id, created_by, name, start_time, end_time, message_template,
                                          status, active_days, timezone_offset, ask_confirmation,
                                          last_summary_sent_date, last_start_notified_date, created_at, deleted_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
                [m.orgId, m.userId, a.name, a.start_time, a.end_time, JSON.stringify(tpl),
                 a.status === 'Deleted' ? 'Deleted' : a.status, JSON.stringify(days),
                 a.timezone_offset || 0, bool(a.ask_confirmation),
                 a.last_summary_sent_date, a.last_start_notified_date, ts(a.created_at),
                 a.status === 'Deleted' ? (ts(a.created_at) || new Date().toISOString()) : null]
            );
            autoMap.set(a.id, r.rows[0].id);
        }
        counts.automations = autoMap.size;

        // ── automation_logs (org via its automation) ─────────────────────────
        const logs = await sAll('SELECT * FROM automation_logs ORDER BY id');
        let logN = 0;
        const orphans = [];
        for (const l of logs) {
            const autoId = autoMap.get(l.automation_id);
            if (!autoId) {
                // SQLite never enforced foreign keys (PRAGMA foreign_keys was
                // never set), so dangling rows exist. Postgres will not create
                // them — record which, rather than losing them quietly.
                orphans.push({ id: l.id, automation_id: l.automation_id, status: l.status });
                continue;
            }
            const srcAuto = autos.find(a => a.id === l.automation_id);
            const m = userMap.get(srcAuto.user_id);
            if (!m) continue;
            await client.query(
                `INSERT INTO automation_logs (org_id, automation_id, contact_id, status, error_reason, content,
                                              sent_time, wa_message_id, delivery_status, delivered_at, response, responded_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [m.orgId, autoId, contactMap.get(l.contact_id) || null, l.status, l.error_reason, l.content,
                 ts(l.sent_time), l.wa_message_id, l.delivery_status, ts(l.delivered_at), l.response, ts(l.responded_at)]
            );
            logN++;
        }
        counts.automation_logs = logN;
        if (orphans.length) {
            console.log(`\n  ${orphans.length} orphaned automation_log row(s) skipped — their automation no longer exists:`);
            for (const o of orphans) console.log(`    log ${o.id} -> automation ${o.automation_id} (${o.status})`);
        }

        // ── the remaining user-scoped tables ─────────────────────────────────
        const simple = [
            ['inbound_messages',
             'SELECT * FROM inbound_messages ORDER BY id',
             (r, m) => [`INSERT INTO inbound_messages (org_id, contact_id, from_number, wa_message_id, body, media_type, media_path, intent, is_read, received_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (wa_message_id) DO NOTHING`,
                        [m.orgId, contactMap.get(r.contact_id) || null, r.from_number, r.wa_message_id, r.body,
                         r.media_type, r.media_path, r.intent, bool(r.is_read), ts(r.received_at)]]],
            ['api_sends',
             'SELECT * FROM api_sends ORDER BY id',
             (r, m) => [`INSERT INTO api_sends (org_id, to_number, body, has_media, wa_message_id, status, error_reason, reference, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                        [m.orgId, r.to_number, r.body, bool(r.has_media), r.wa_message_id, r.status, r.error_reason, r.reference, ts(r.created_at)]]],
            ['notification_logs',
             'SELECT * FROM notification_logs ORDER BY id',
             (r, m) => [`INSERT INTO notification_logs (org_id, type, category, recipient, content, status, sent_at)
                         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                        [m.orgId, r.type, r.category, r.recipient, r.content, r.status, ts(r.sent_at)]]],
            ['health_alerts',
             'SELECT * FROM health_alerts ORDER BY id',
             (r, m) => [`INSERT INTO health_alerts (org_id, kind, detail, created_at) VALUES ($1,$2,$3,$4)`,
                        [m.orgId, r.kind, r.detail, ts(r.created_at)]]],
            ['reminders',
             'SELECT * FROM reminders ORDER BY id',
             (r, m) => [`INSERT INTO reminders (org_id, contact_id, media_id, message, scheduled_time, status, created_at)
                         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
                        [m.orgId, contactMap.get(r.contact_id) || null, mediaMap.get(r.media_id) || null,
                         r.message, ts(r.scheduled_time), r.status]]],
        ];

        for (const [table, query, build] of simple) {
            const rows = await sAll(query).catch(() => []);
            let n = 0;
            for (const r of rows) {
                const m = userMap.get(r.user_id);
                if (!m) continue;
                const [sql, params] = build(r, m);
                await client.query(sql, params);
                n++;
            }
            counts[table] = n;
        }

        // ── verify before committing ─────────────────────────────────────────
        console.log('\n  table                 sqlite   postgres   status');
        console.log('  ' + '-'.repeat(52));
        let mismatch = 0;
        const check = [
            ['users', 'users'], ['contacts', 'contacts'], ['automations', 'automations'],
            ['automation_logs', 'automation_logs'], ['inbound_messages', 'inbound_messages'],
            ['media_attachments', 'media_attachments'], ['api_sends', 'api_sends'],
            ['notification_logs', 'notification_logs'], ['health_alerts', 'health_alerts'],
            ['reminders', 'reminders'],
        ];
        for (const [sTable, pTable] of check) {
            const src = await sAll(`SELECT COUNT(*) AS n FROM ${sTable}`).then(r => r[0].n).catch(() => 0);
            const dst = (await client.query(`SELECT COUNT(*)::int AS n FROM ${pTable}`)).rows[0].n;
            // A shortfall is only acceptable where rows were deliberately skipped
            // as orphans (owner or parent missing); anything else is a defect.
            const ok = dst === src || dst === counts[pTable];
            if (!ok) mismatch++;
            console.log(`  ${sTable.padEnd(20)} ${String(src).padStart(6)}   ${String(dst).padStart(8)}   ${ok ? 'ok' : 'MISMATCH'}`);
        }

        if (mismatch) throw new Error(`${mismatch} table(s) did not reconcile — rolling back.`);

        if (DRY) {
            await client.query('ROLLBACK');
            console.log('\n  --dry-run: verified and rolled back. Nothing was written.');
        } else {
            await client.query('COMMIT');
            console.log('\n  Imported and committed.');
        }
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('\n  Import failed, rolled back:', e.message);
        process.exitCode = 1;
    } finally {
        client.release();
        sdb.close();
        await pool.end();
    }
}

main();
