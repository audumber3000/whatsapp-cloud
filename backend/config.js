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
};

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
