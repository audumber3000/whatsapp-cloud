/**
 * Configuration and secrets.
 *
 * Everything sensitive is read from the environment here, once, and validated
 * at boot. Previously JWT_SECRET was a string literal in server.js — committed
 * to git, and committed a second time in a script that used it to mint tokens
 * for arbitrary user ids. docker-compose.prod.yml was already passing
 * JWT_SECRET, ADMIN_USERNAME and ADMIN_PASSWORD, which the code never read, so
 * the deployment looked configured and was not.
 */

const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';
const missing = [];

function required(name) {
    const v = process.env[name];
    if (!v || !v.trim()) {
        missing.push(name);
        return null;
    }
    return v.trim();
}

/**
 * In production a missing secret is fatal — failing to boot is far better than
 * running on a predictable key. In development we generate an ephemeral one,
 * which logs everyone out on restart and is exactly what you want locally.
 */
function requiredSecret(name, minLength = 32) {
    const v = process.env[name];
    if (v && v.trim().length >= minLength) return v.trim();

    if (isProd) {
        missing.push(v ? `${name} (too short — need ${minLength}+ chars)` : name);
        return null;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    console.warn(`[config] ${name} not set — generated an ephemeral dev secret. Sessions reset on restart.`);
    return generated;
}

const config = {
    isProd,
    port: parseInt(process.env.PORT, 10) || 3000,

    jwtSecret: requiredSecret('JWT_SECRET'),
    // Short-lived by design; refresh tokens arrive with the sessions table.
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

    admin: {
        username: process.env.ADMIN_USERNAME || (isProd ? null : 'admin'),
        // Stored as a bcrypt hash so the plaintext never sits in env or memory.
        passwordHash: process.env.ADMIN_PASSWORD_HASH || null,
        // Dev-only fallback so the panel is reachable locally without setup.
        devPassword: isProd ? null : (process.env.ADMIN_PASSWORD || 'admin'),
    },

    evolution: {
        url: process.env.EVOLUTION_URL || 'http://evolution:8080',
        apiKey: process.env.EVOLUTION_API_KEY || '',
        webhookUrl: process.env.EVOLUTION_WEBHOOK_URL || '',
        // Mandatory in production: the receiver previously skipped its auth
        // check entirely when this was blank, leaving the webhook wide open.
        webhookSecret: isProd ? required('EVOLUTION_WEBHOOK_SECRET') : (process.env.EVOLUTION_WEBHOOK_SECRET || 'dev-webhook-secret'),
    },

    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),

    partners: loadPartners(),
};

/**
 * Products that provision workspaces for their own customers (partnerApi.js).
 *
 * One entry per partner, read from `<PREFIX>_PARTNER_KEY` and friends. A
 * partner with no key is simply not enabled, so a box without MolarPlus
 * configured behaves exactly as before.
 *
 *   MOLARPLUS_PARTNER_KEY       32+ chars; the partner's server holds the same value
 *   MOLARPLUS_ALLOWED_IPS       comma-separated source IPs. Required in production:
 *                               this box speaks plain HTTP, so a key seen on the
 *                               wire must still be useless from anywhere else
 *   MOLARPLUS_URL               where the partner's API lives (webhooks go here)
 *   MOLARPLUS_WEBHOOK_URL       full webhook URL, if it is not the default path
 *   WAREACH_WEBHOOK_SECRET      signs the webhooks the partner receives
 *
 * A misconfigured partner is switched off with a loud error rather than
 * refusing to boot: the same process carries every other workspace's live
 * WhatsApp, and a typo in one partner's settings must not take those down.
 */
function loadPartners() {
    const KNOWN = [
        {
            id: 'molarplus',
            prefix: 'MOLARPLUS',
            name: 'MolarPlus',
            webhookPath: '/api/v1/integrations/wareach/webhook',
            webhookSecretEnv: 'WAREACH_WEBHOOK_SECRET',
        },
    ];
    const out = {};
    for (const p of KNOWN) {
        const key = (process.env[`${p.prefix}_PARTNER_KEY`] || '').trim();
        if (!key) continue;
        if (key.length < 32) {
            if (isProd) {
                console.error(`[config] ${p.prefix}_PARTNER_KEY is shorter than 32 chars — partner "${p.id}" is DISABLED.`);
                continue;
            }
            console.warn(`[config] ${p.prefix}_PARTNER_KEY is shorter than 32 chars — fine for dev only.`);
        }
        const allowedIps = (process.env[`${p.prefix}_ALLOWED_IPS`] || '')
            .split(',').map((s) => s.trim()).filter(Boolean);
        if (isProd && !allowedIps.length) {
            console.error(`[config] ${p.prefix}_ALLOWED_IPS is empty — partner "${p.id}" is DISABLED. `
                + 'Set it to the partner server\'s public IP.');
            continue;
        }
        const base = (process.env[`${p.prefix}_URL`] || '').trim().replace(/\/$/, '');
        const webhookUrl = (process.env[`${p.prefix}_WEBHOOK_URL`] || '').trim()
            || (base ? `${base}${p.webhookPath}` : '');
        const webhookSecret = (process.env[p.webhookSecretEnv] || '').trim();
        if (!webhookUrl || !webhookSecret) {
            console.warn(`[config] partner "${p.id}" has no webhook URL or secret — it will have to poll for status.`);
        }
        out[p.id] = {
            id: p.id,
            name: p.name,
            keyHash: crypto.createHash('sha256').update(key).digest(),
            allowedIps,
            webhookUrl,
            webhookSecret,
        };
    }
    return out;
}

if (missing.length) {
    console.error('\n[config] Refusing to start — missing required configuration:');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('\nSet these in the environment (see .env.example) and restart.\n');
    process.exit(1);
}

if (isProd && !config.admin.passwordHash) {
    console.warn('[config] ADMIN_PASSWORD_HASH not set — the admin panel is disabled.');
}

module.exports = config;
