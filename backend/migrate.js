#!/usr/bin/env node
/**
 * Migration runner.
 *
 * db.js previously ran DDL inline on every boot with swallowed ALTER TABLE
 * errors — which cannot express a rename, a backfill, or a rollback, and gave
 * no way to know what had actually been applied. Migrations are now numbered
 * files applied once, in order, inside a transaction, recorded in
 * schema_migrations.
 *
 *   node migrate.js          apply anything pending
 *   node migrate.js status   show applied vs pending
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DIR = path.join(__dirname, 'migrations');
const url = process.env.DATABASE_URL;

if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
}

const pool = new Pool({ connectionString: url });

function files() {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
}

const checksum = (body) => crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);

async function ensureTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            name        TEXT PRIMARY KEY,
            checksum    TEXT NOT NULL,
            applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
}

async function applied(client) {
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
    return new Map(rows.map(r => [r.name, r.checksum]));
}

async function status() {
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const done = await applied(client);
        for (const f of files()) {
            const sum = checksum(fs.readFileSync(path.join(DIR, f), 'utf8'));
            if (!done.has(f)) console.log(`  pending  ${f}`);
            else if (done.get(f) !== sum) console.log(`  CHANGED  ${f}  (already applied but the file has been edited)`);
            else console.log(`  applied  ${f}`);
        }
    } finally { client.release(); }
}

async function up() {
    const client = await pool.connect();
    try {
        await ensureTable(client);
        const done = await applied(client);
        let ran = 0;

        for (const f of files()) {
            const body = fs.readFileSync(path.join(DIR, f), 'utf8');
            const sum = checksum(body);

            if (done.has(f)) {
                // An edited migration means the database and the file disagree;
                // failing loudly beats silently diverging.
                if (done.get(f) !== sum) {
                    throw new Error(`${f} was already applied but has since been edited. Write a new migration instead.`);
                }
                continue;
            }

            process.stdout.write(`  applying ${f} ... `);
            try {
                await client.query('BEGIN');
                await client.query(body);
                await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f, sum]);
                await client.query('COMMIT');
                console.log('ok');
                ran++;
            } catch (e) {
                await client.query('ROLLBACK');
                console.log('FAILED');
                throw e;
            }
        }
        console.log(ran ? `\n${ran} migration(s) applied.` : '\nNothing to apply — schema is current.');
    } finally { client.release(); }
}

(async () => {
    try {
        if (process.argv[2] === 'status') await status();
        else await up();
        await pool.end();
        process.exit(0);
    } catch (e) {
        console.error('\nMigration failed:', e.message);
        await pool.end().catch(() => {});
        process.exit(1);
    }
})();
