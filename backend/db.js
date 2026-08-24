/**
 * Database entry point.
 *
 * Every module does require('./db'), so this is the single place the engine is
 * chosen. With DATABASE_URL set we use Postgres via pgdb.js, which exposes the
 * same sqlite3-shaped callback API (db.get/all/run with this.lastID and
 * this.changes) that the ~138 existing call sites already use.
 *
 * Schema is no longer created here. It used to be inline DDL on every boot with
 * swallowed ALTER TABLE errors, which could not express a rename or a backfill
 * and gave no way to know what had actually been applied. That now lives in
 * migrations/, applied by migrate.js.
 */

if (!process.env.DATABASE_URL) {
    console.error(
        '\n[db] DATABASE_URL is not set.\n' +
        '     WA Reach now runs on Postgres. Set DATABASE_URL and apply migrations:\n' +
        '       node migrate.js\n' +
        '     The old SQLite file is still at backend/data/whatsapp.sqlite as a rollback.\n'
    );
    process.exit(1);
}

const pgdb = require('./pgdb');

module.exports = pgdb;
