/**
 * org_id  <->  Evolution instance name.
 *
 * Instance names used to be derived arithmetically (`wareach_user_${userId}`)
 * from a sequential integer. Ids are UUIDs now, and — more importantly — the
 * existing Evolution instances are still named after the OLD ids, so the name
 * has to be looked up rather than computed or every org would point at an
 * instance that does not exist.
 *
 * wa_instances is the source of truth; this is a cache in front of it, loaded
 * once at boot and updated when an instance is created.
 */

const db = require('./db');

const byOrg = new Map();       // org_id -> instance_name
const byInstance = new Map();  // instance_name -> org_id

async function load() {
    const rows = await db.many('SELECT org_id, instance_name FROM wa_instances');
    byOrg.clear();
    byInstance.clear();
    for (const r of rows) {
        byOrg.set(String(r.org_id), r.instance_name);
        byInstance.set(r.instance_name, String(r.org_id));
    }
    console.log(`[instances] mapped ${rows.length} organisation(s) to Evolution instances`);
    return rows.length;
}

/** Synchronous by design — the WhatsApp module reads this on hot paths. */
function nameFor(orgId) {
    return byOrg.get(String(orgId)) || null;
}

function orgFor(instanceName) {
    return byInstance.get(instanceName) || null;
}

/** Create the row and cache it, if this org has no instance yet. */
async function ensureFor(orgId) {
    const existing = nameFor(orgId);
    if (existing) return existing;

    const row = await db.one('SELECT instance_name FROM wa_instances WHERE org_id = ?', [orgId]);
    if (row) {
        byOrg.set(String(orgId), row.instance_name);
        byInstance.set(row.instance_name, String(orgId));
        return row.instance_name;
    }
    const name = `wareach_org_${orgId}`;
    await db.query('INSERT INTO wa_instances (org_id, instance_name) VALUES (?, ?) ON CONFLICT (org_id) DO NOTHING', [orgId, name]);
    byOrg.set(String(orgId), name);
    byInstance.set(name, String(orgId));
    return name;
}

async function setStatus(instanceName, status, phone) {
    await db.query(
        `UPDATE wa_instances SET status = ?, phone_number = COALESCE(?, phone_number), last_status_at = NOW()
          WHERE instance_name = ?`,
        [status, phone || null, instanceName]
    ).catch(() => {});
}

module.exports = { load, nameFor, orgFor, ensureFor, setStatus };
