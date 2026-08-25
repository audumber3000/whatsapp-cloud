/**
 * Analytics.
 *
 * The dashboard has three numbers on it — sent, failed, active automations —
 * and nothing that answers a question. "43 failures" has never been
 * diagnosable without opening psql, which is the specific gap this closes:
 * every panel here is a question a clinic actually asks.
 *
 * Each query is a plain function, so a single-panel route and the combined
 * /overview call the same code — there is exactly one definition of every
 * number. Every aggregate is cast, because COUNT returns int8 and SUM returns
 * numeric, and node-pg hands both back as strings.
 */

const express = require('express');
const db = require('./db');

/** Windows are named, not free-form; an arbitrary range is a later concern. */
const RANGE = {
    '7d':  { days: 7,  bucket: 'day',  label: 'Last 7 days' },
    '30d': { days: 30, bucket: 'day',  label: 'Last 30 days' },
    '90d': { days: 90, bucket: 'week', label: 'Last 90 days' },
};

const rangeOf = (q) => RANGE[q] || RANGE['30d'];

/**
 * A dense bucket series.
 *
 * Postgres only returns buckets that have rows, so a quiet Sunday would vanish
 * from the result and the line would join Saturday straight to Monday —
 * implying activity that never happened. generate_series fills the gaps.
 */
const buckets = (bucket, days) => `
        SELECT generate_series(
            date_trunc('${bucket}', NOW() - INTERVAL '${days} days'),
            date_trunc('${bucket}', NOW()),
            INTERVAL '1 ${bucket}'
        ) AS bucket
`;

/* ── the queries ────────────────────────────────────────────────────────── */

const QUERIES = {
    /**
     * Delivery funnel: queued → sent → delivered → read → replied.
     *
     * Each step is a subset of the one above, so the gap between two rows is
     * where the loss happened. `read` is only counted when WhatsApp actually
     * sent the ack, rather than assumed from "delivered".
     */
    funnel: async (orgId, { days }) => db.one(
        `SELECT COUNT(*)::int AS queued,
                COUNT(*) FILTER (WHERE status IN ('sent','delivered','read'))::int AS sent,
                COUNT(*) FILTER (WHERE delivery_status IN ('delivered','read')
                                    OR status IN ('delivered','read'))::int AS delivered,
                COUNT(*) FILTER (WHERE delivery_status = 'read' OR status = 'read')::int AS read,
                -- Constrained to rows that actually went out. Without this a
                -- reply recorded against a failed send makes the funnel widen
                -- at the bottom, which reads as a broken chart.
                COUNT(*) FILTER (WHERE response IS NOT NULL
                                   AND status IN ('sent','delivered','read'))::int AS replied,
                COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
           FROM automation_logs
          WHERE org_id = ? AND created_at >= NOW() - (? || ' days')::interval`,
        [orgId, days]),

    /** Volume, failures and replies over time. */
    timeseries: async (orgId, { days, bucket }) => db.many(
        `WITH b AS (${buckets(bucket, days)})
         SELECT to_char(b.bucket, 'DD Mon')  AS label,
                COALESCE(o.sent, 0)::int     AS sent,
                COALESCE(o.failed, 0)::int   AS failed,
                COALESCE(o.replied, 0)::int  AS replied,
                COALESCE(i.inbound, 0)::int  AS inbound
           FROM b
           LEFT JOIN (
                SELECT date_trunc('${bucket}', sent_time) AS bucket,
                       COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) AS sent,
                       COUNT(*) FILTER (WHERE status = 'failed')                     AS failed,
                       COUNT(*) FILTER (WHERE response IS NOT NULL)                  AS replied
                  FROM automation_logs
                 WHERE org_id = ? AND sent_time >= NOW() - (? || ' days')::interval
                 GROUP BY 1
           ) o ON o.bucket = b.bucket
           LEFT JOIN (
                SELECT date_trunc('${bucket}', received_at) AS bucket, COUNT(*) AS inbound
                  FROM inbound_messages
                 WHERE org_id = ? AND received_at >= NOW() - (? || ' days')::interval
                 GROUP BY 1
           ) i ON i.bucket = b.bucket
          ORDER BY b.bucket`,
        [orgId, days, orgId, days]),

    /**
     * Why sends failed — the panel that makes "43 failures" actionable.
     *
     * Raw `error_reason` strings are long and say the same thing several ways,
     * so they are grouped into causes a clinic can act on, and the contacts
     * behind them are listed so the fix is one click away.
     */
    failures: async (orgId, { days }) => {
        const [reasons, worst] = await Promise.all([
            db.many(
                `SELECT CASE
                          WHEN error_reason IS NULL                   THEN 'Unknown'
                          WHEN error_reason ILIKE '%not registered%'
                            OR error_reason ILIKE '%not on whatsapp%' THEN 'Not on WhatsApp'
                          WHEN error_reason ILIKE '%opted out%'       THEN 'Contact opted out'
                          WHEN error_reason ILIKE '%not connected%'
                            OR error_reason ILIKE '%unreachable%'
                            OR error_reason ILIKE '%dispatch%'        THEN 'Number was disconnected'
                          WHEN error_reason ILIKE '%attachment%'
                            OR error_reason ILIKE '%media%'           THEN 'Attachment missing'
                          ELSE 'Other'
                        END AS reason,
                        COUNT(*)::int AS n
                   FROM automation_logs
                  WHERE org_id = ? AND status = 'failed'
                    AND created_at >= NOW() - (? || ' days')::interval
                  GROUP BY 1
                  ORDER BY n DESC`,
                [orgId, days]),
            db.many(
                `SELECT c.id, c.name, c.phone, c.wa_valid, COUNT(*)::int AS failures
                   FROM automation_logs al JOIN contacts c ON c.id = al.contact_id
                  WHERE al.org_id = ? AND al.status = 'failed'
                    AND al.created_at >= NOW() - (? || ' days')::interval
                  GROUP BY c.id, c.name, c.phone, c.wa_valid
                  ORDER BY failures DESC
                  LIMIT 8`,
                [orgId, days]),
        ]);
        return { reasons, worst };
    },

    /** How patients answered, and which automation they answered. */
    responses: async (orgId, { days }) => {
        const [totals, byAutomation] = await Promise.all([
            db.one(
                `SELECT COUNT(*) FILTER (WHERE response = 'confirm')::int    AS confirmed,
                        COUNT(*) FILTER (WHERE response = 'reschedule')::int AS reschedule,
                        COUNT(*) FILTER (WHERE response = 'cancel')::int     AS cancelled,
                        COUNT(*) FILTER (WHERE response IS NULL)::int        AS no_reply,
                        COUNT(*)::int                                        AS total
                   FROM automation_logs
                  WHERE org_id = ? AND status IN ('sent','delivered','read')
                    AND created_at >= NOW() - (? || ' days')::interval`,
                [orgId, days]),
            db.many(
                `SELECT a.name,
                        COUNT(*)::int AS sent,
                        COUNT(*) FILTER (WHERE al.response IS NOT NULL)::int AS replied,
                        COUNT(*) FILTER (WHERE al.status = 'failed')::int    AS failed
                   FROM automation_logs al JOIN automations a ON a.id = al.automation_id
                  WHERE al.org_id = ? AND al.created_at >= NOW() - (? || ' days')::interval
                  GROUP BY a.id, a.name
                  ORDER BY sent DESC
                  LIMIT 8`,
                [orgId, days]),
        ]);
        return {
            totals,
            // Computed here, so the chart and the table can never disagree.
            byAutomation: byAutomation.map((a) => ({
                ...a,
                rate: a.sent ? Math.round((a.replied / a.sent) * 100) : 0,
            })),
        };
    },

    /**
     * Team performance, which only became measurable with the inbox.
     *
     * Median, not mean: one conversation left open overnight would otherwise
     * make a whole week look terrible.
     */
    agents: async (orgId, { days }) => db.many(
        `SELECT COALESCE(u.full_name, u.username) AS name,
                COUNT(DISTINCT cv.id)::int AS conversations,
                COUNT(DISTINCT cv.id) FILTER (WHERE cv.status = 'resolved')::int AS resolved,
                COALESCE(ROUND(EXTRACT(EPOCH FROM percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY cv.first_response_at - cv.last_inbound_at
                )) / 60), 0)::int AS median_minutes,
                (SELECT COUNT(*)::int FROM automation_logs al
                  WHERE al.sent_by = u.id
                    AND al.created_at >= NOW() - (? || ' days')::interval) AS replies_sent
           FROM conversations cv
           JOIN users u ON u.id = cv.assignee_id
          WHERE cv.org_id = ? AND cv.updated_at >= NOW() - (? || ' days')::interval
          GROUP BY u.id, u.username, u.full_name
          ORDER BY conversations DESC
          LIMIT 10`,
        [days, orgId, days]),

    /**
     * The platform side: sends that came in over /api/v1 rather than from an
     * automation or an agent. Those are the ones another product triggered.
     */
    apiUsage: async (orgId, { days, bucket }) => {
        const series = await db.many(
            `WITH b AS (${buckets(bucket, days)})
             SELECT to_char(b.bucket, 'DD Mon') AS label, COALESCE(a.n, 0)::int AS sends
               FROM b
               LEFT JOIN (
                    SELECT date_trunc('${bucket}', created_at) AS bucket, COUNT(*) AS n
                      FROM automation_logs
                     WHERE org_id = ? AND automation_id IS NULL AND sent_by IS NULL
                       AND created_at >= NOW() - (? || ' days')::interval
                     GROUP BY 1
               ) a ON a.bucket = b.bucket
              ORDER BY b.bucket`,
            [orgId, days]);
        return { series, total: series.reduce((s, x) => s + x.sends, 0) };
    },
};

/* ── routes ─────────────────────────────────────────────────────────────── */

function router({ authenticateToken }) {
    const r = express.Router();
    r.use(authenticateToken);

    // One route per query, so a screen can refresh a single panel.
    for (const [name, run] of Object.entries(QUERIES)) {
        r.get(`/${name}`, async (req, res) => {
            try {
                res.json(await run(req.user.org_id, rangeOf(req.query.range)));
            } catch (e) {
                console.error(`[analytics] ${name} failed:`, e.message);
                res.status(500).json({ error: 'Could not load that panel' });
            }
        });
    }

    /**
     * Everything one screen needs, in one round trip.
     *
     * A panel that throws comes back as null rather than failing the page —
     * one empty chart beats a blank dashboard.
     */
    r.get('/overview', async (req, res) => {
        const range = rangeOf(req.query.range);
        const names = Object.keys(QUERIES);
        const results = await Promise.all(names.map((n) =>
            QUERIES[n](req.user.org_id, range).catch((e) => {
                console.error(`[analytics] ${n} failed inside overview:`, e.message);
                return null;
            })));
        const out = { range: range.label, rangeKey: req.query.range || '30d' };
        names.forEach((n, i) => { out[n] = results[i]; });
        res.json(out);
    });

    return r;
}

module.exports = { router, QUERIES, RANGE };
