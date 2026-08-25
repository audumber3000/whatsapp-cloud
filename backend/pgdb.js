/**
 * Postgres behind the sqlite3 callback API.
 *
 * There are ~138 db.get/all/run call sites across the backend. Rewriting each
 * one by hand would be the most error-prone way to make this move, so this
 * exposes the same surface — db.get(sql, params, cb), db.all, db.run with
 * this.lastID / this.changes, db.serialize — over a pg Pool.
 *
 * What it does NOT do is paper over SQL dialect differences. There were only
 * eight genuinely SQLite-specific queries (datetime(), strftime(),
 * INSERT OR IGNORE, COLLATE NOCASE) and those are rewritten in the source
 * where they live, so the SQL a reader sees is the SQL that runs.
 *
 * New code should prefer the promise API: query(), one(), many().
 */

const { Pool, types } = require('pg');

/**
 * int8 (OID 20) arrives as a STRING by default, because bigint can exceed
 * Number.MAX_SAFE_INTEGER. Every COUNT(*) in this codebase is an int8, and
 * SQLite returned numbers — so `confirmed + reschedule + cancelled` silently
 * became string concatenation the moment we moved: 0 + 0 + 1 rendered as
 * "001", and a response rate computed from it was nonsense.
 *
 * Counts and the `automation_logs.id` sequence here are bounded far below 2^53,
 * so parsing them as numbers is safe and restores the behaviour every call site
 * was written against.
 */
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.PG_POOL_MAX, 10) || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
    // An idle client erroring must not take the process down.
    console.error('[pg] idle client error:', err.message);
});

/** `?` placeholders -> `$1..$n`, leaving anything inside quotes alone. */
function toPositional(sql) {
    let out = '';
    let n = 0;
    let quote = null;
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (quote) {
            out += c;
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"') { quote = c; out += c; continue; }
        if (c === '?') { out += '$' + (++n); continue; }
        out += c;
    }
    return out;
}

const isInsert = (sql) => /^\s*insert\s+into/i.test(sql);
const hasReturning = (sql) => /\breturning\b/i.test(sql);

/**
 * sqlite3 hands back lastID on every insert. Postgres only returns what you
 * ask for, so an INSERT without RETURNING gets one appended.
 */
function prepare(sql) {
    let out = toPositional(sql);
    if (isInsert(out) && !hasReturning(out)) out = out.replace(/;?\s*$/, ' RETURNING id');
    return out;
}

function run(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    const text = prepare(sql);
    pool.query(text, params || [])
        .then((res) => {
            if (!cb) return;
            // sqlite3 exposes these on `this` inside the callback.
            const ctx = {
                lastID: res.rows && res.rows[0] ? res.rows[0].id : undefined,
                changes: res.rowCount,
            };
            cb.call(ctx, null);
        })
        .catch((err) => {
            if (cb) cb.call({ lastID: undefined, changes: 0 }, err);
            else console.error('[pg] run failed:', err.message, '\n  sql:', sql);
        });
}

function get(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    pool.query(toPositional(sql), params || [])
        .then((res) => cb && cb(null, res.rows[0]))
        .catch((err) => cb && cb(err));
}

function all(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    pool.query(toPositional(sql), params || [])
        .then((res) => cb && cb(null, res.rows))
        .catch((err) => cb && cb(err, []));
}

/** sqlite3 serialised statements; pg does not need to, so this just runs. */
function serialize(fn) { if (typeof fn === 'function') fn(); }

// ── promise API for new code ────────────────────────────────────────────────
const query = (sql, params = []) => pool.query(toPositional(sql), params);
const one = (sql, params = []) => query(sql, params).then((r) => r.rows[0] || null);
const many = (sql, params = []) => query(sql, params).then((r) => r.rows);

/** Run several statements atomically. */
async function tx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn({
            query: (sql, p = []) => client.query(toPositional(sql), p),
            one: (sql, p = []) => client.query(toPositional(sql), p).then((r) => r.rows[0] || null),
            many: (sql, p = []) => client.query(toPositional(sql), p).then((r) => r.rows),
        });
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function healthy() {
    try { await pool.query('SELECT 1'); return true; } catch { return false; }
}

module.exports = {
    // sqlite3-compatible surface
    run, get, all, serialize,
    // promise API
    query, one, many, tx, healthy, pool,
    // exported for tests
    _toPositional: toPositional, _prepare: prepare,
};
