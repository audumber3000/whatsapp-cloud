/**
 * Production hardening.
 *
 * Everything here is written by hand rather than pulled in as a dependency.
 * The list is short, the behaviour is visible in one file, and a deploy that
 * is already fragile does not need three more packages in its supply chain.
 *
 * What this fixes, concretely:
 *   - `app.use(cors())` allowed any origin to call the API with credentials
 *   - no security headers at all, so the SPA had no framing or sniffing defence
 *   - only /api/v1 was rate limited; the dashboard API had no ceiling
 *   - an async route that threw fell through to Express's default handler,
 *     which prints a stack trace to the client
 *   - an unhandled rejection took the whole process down, and PM2 pins this to
 *     one instance — so a single bad request was a full outage
 */

const crypto = require('crypto');

/* ── request id + structured logging ────────────────────────────────────── */

/**
 * Every request gets an id, echoed in the response header and attached to any
 * log line it produces. Without it, "a 500 at 14:32" cannot be traced to the
 * error that caused it.
 */
function requestId(req, res, next) {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
}

const SLOW_MS = 1000;

/** One line per request, as JSON, so a log aggregator can read it later. */
function accessLog(req, res, next) {
    const started = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - started;
        // Health checks and static assets would drown everything else.
        if (req.path === '/api/health' || !req.path.startsWith('/api/')) return;
        // Only what is worth reading: errors, and anything slow enough to notice.
        if (res.statusCode < 400 && ms < SLOW_MS) return;
        console.log(JSON.stringify({
            t: new Date().toISOString(),
            id: req.id,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms,
            org: req.user?.org_id || null,
            ip: req.ip,
        }));
    });
    next();
}

/* ── security headers ───────────────────────────────────────────────────── */

/**
 * The CSP is deliberately not `unsafe-eval`, and `script-src 'self'` only —
 * the app is a bundled SPA with no inline scripts, so nothing needs more.
 * `style-src` keeps 'unsafe-inline' because the app sets inline styles on
 * elements, which CSP counts as inline style.
 */
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // Media the clinic uploaded is served from our own origin; data: covers
    // the QR code and workspace logos, which are data-URIs.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The socket connects back to the same origin over ws/wss.
    "connect-src 'self' ws: wss:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Clickjacking: nothing here should ever be framed.
    "frame-ancestors 'none'",
].join('; ');

function securityHeaders({ https = false } = {}) {
    return (req, res, next) => {
        res.setHeader('Content-Security-Policy', CSP);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        // Only over TLS: sending HSTS from a plain-HTTP dev server would pin
        // localhost to https in the browser and be a nuisance to undo.
        if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        // An API response is never a document; stop a browser rendering one.
        if (req.path.startsWith('/api/')) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        next();
    };
}

/* ── CORS ───────────────────────────────────────────────────────────────── */

/**
 * The dashboard is served from the same origin as the API, so in production
 * it needs no CORS at all. An allowlist exists for local development and for
 * the programmable API, which other products call from their own origins.
 */
function corsPolicy({ allowed = [], allowAll = false } = {}) {
    const list = new Set(allowed.filter(Boolean));
    return (req, res, next) => {
        const origin = req.headers.origin;
        if (!origin) return next();   // same-origin or server-to-server

        const ok = allowAll || list.has(origin);
        if (ok) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Access-Control-Allow-Headers',
                'Authorization, Content-Type, X-Request-Id, apikey');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
            res.setHeader('Access-Control-Max-Age', '600');
        }
        if (req.method === 'OPTIONS') return res.sendStatus(ok ? 204 : 403);
        next();
    };
}

/* ── rate limiting ──────────────────────────────────────────────────────── */

/**
 * A fixed window per key, in memory.
 *
 * In memory is honest about what this is: one process, one box. It stops a
 * script hammering the dashboard API; it is not a distributed quota, and the
 * moment there are two instances this needs Redis. Said out loud here rather
 * than discovered later.
 */
function rateLimit({ max = 300, windowMs = 60_000, name = 'api', keyOf } = {}) {
    const hits = new Map();

    // Bounded sweep, so a burst of one-off IPs cannot grow the map forever.
    setInterval(() => {
        const now = Date.now();
        for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    }, windowMs).unref();

    return (req, res, next) => {
        const key = keyOf ? keyOf(req) : (req.user?.id || req.ip || 'anon');
        const now = Date.now();
        let rec = hits.get(key);
        if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; hits.set(key, rec); }
        rec.count += 1;

        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - rec.count)));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(rec.reset / 1000)));

        if (rec.count > max) {
            const retry = Math.ceil((rec.reset - now) / 1000);
            res.setHeader('Retry-After', String(retry));
            console.warn(`[ratelimit] ${name}: ${key} exceeded ${max}/${windowMs}ms`);
            return res.status(429).json({
                error: 'Too many requests',
                detail: `Slow down and try again in ${retry} seconds.`,
                retryAfter: retry,
            });
        }
        next();
    };
}

/* ── errors ─────────────────────────────────────────────────────────────── */

/** 404 for anything under /api that no route claimed. */
function apiNotFound(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    res.status(404).json({ error: 'Not found', path: req.path });
}

/**
 * The last handler.
 *
 * Express's default prints a stack trace into the response body. This returns
 * a request id the user can quote instead, and keeps the detail in the log
 * where it belongs.
 */
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    // A body that is not JSON, or is over the limit, is the caller's mistake.
    if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'That request body is not valid JSON', requestId: req.id });
    }
    if (err?.type === 'entity.too.large') {
        return res.status(413).json({ error: 'That request is too large', requestId: req.id });
    }

    console.error(JSON.stringify({
        t: new Date().toISOString(),
        id: req.id,
        level: 'error',
        method: req.method,
        path: req.path,
        org: req.user?.org_id || null,
        message: err?.message,
        stack: err?.stack?.split('\n').slice(0, 6).join(' | '),
    }));

    res.status(err?.status || 500).json({
        error: 'Something went wrong on our side',
        requestId: req.id,
    });
}

/*
 * There is deliberately no asyncWrap helper here: this app is on Express 5,
 * which forwards a rejected promise from a handler to the error handler on its
 * own. A wrapper would only be Express-4 muscle memory, and having one invites
 * the belief that unwrapped routes are unsafe.
 */

/**
 * Process-level guards.
 *
 * PM2 pins this app to a single instance, so an uncaught exception is a full
 * outage — that is exactly how one bad request took the product down before.
 * A rejection is logged and survived; an uncaught exception is logged and then
 * exits deliberately, because the process state is no longer trustworthy and
 * the supervisor can restart cleanly.
 */
function guardProcess() {
    process.on('unhandledRejection', (reason) => {
        console.error(JSON.stringify({
            t: new Date().toISOString(), level: 'fatal-ish', kind: 'unhandledRejection',
            message: reason?.message || String(reason),
            stack: reason?.stack?.split('\n').slice(0, 6).join(' | '),
        }));
    });

    process.on('uncaughtException', (err) => {
        console.error(JSON.stringify({
            t: new Date().toISOString(), level: 'fatal', kind: 'uncaughtException',
            message: err?.message, stack: err?.stack?.split('\n').slice(0, 8).join(' | '),
        }));
        setTimeout(() => process.exit(1), 250).unref();
    });
}

module.exports = {
    requestId, accessLog, securityHeaders, corsPolicy, rateLimit,
    apiNotFound, errorHandler, guardProcess, CSP,
};
