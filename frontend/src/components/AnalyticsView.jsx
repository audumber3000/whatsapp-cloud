import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    TrendingUp, TrendingDown, AlertTriangle, Table as TableIcon, BarChart3,
} from 'lucide-react';
import {
    ChartCard, TrendLines, Bars, Donut, Gauge, Sparkline, Funnel, Legend, SERIES,
} from './ui/Chart';
import useEvent from '../hooks/useEvent';

/**
 * Analytics.
 *
 * Every panel answers a question a clinic actually asks, in the order they ask
 * them: is it working, where is it losing messages, why did those fail, who is
 * replying, and how fast is the team.
 *
 * Two rules from the design system are load-bearing here. Colours come from
 * --c1..--c4 in fixed order and are never reassigned by rank, so switching the
 * range cannot repaint a series. And because two of those four fall below 3:1
 * against the light surface, every chart carries a legend or direct labels and
 * the page ships a table view — identity never rests on colour alone.
 */

const RANGES = [['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days']];

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

const duration = (mins) => {
    if (!mins) return '—';
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    return h < 24 ? `${h}h ${mins % 60}m` : `${Math.floor(h / 24)}d`;
};

export default function AnalyticsView({ apiUrl, token, onToast: rawToast }) {
    // Stable identity: a parent passing an inline arrow must not make
    // every fetch callback re-fire. See hooks/useEvent.js.
    const onToast = useEvent(rawToast);
    const [range, setRange] = useState('30d');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [asTable, setAsTable] = useState(false);

    const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await fetch(`${apiUrl}/analytics/overview?range=${range}`, { headers: auth });
            if (!r.ok) throw new Error();
            setData(await r.json());
        } catch { onToast?.('error', 'Could not load analytics'); }
        finally { setLoading(false); }
    }, [apiUrl, auth, range, onToast]);

    useEffect(() => { load(); }, [load]);

    if (loading && !data) {
        return <div className="view-container"><div className="card"><p style={{ color: 'var(--text-muted)' }}>Loading…</p></div></div>;
    }
    if (!data) return null;

    const f = data.funnel || {};
    const ts = data.timeseries || [];
    const failures = data.failures || { reasons: [], worst: [] };
    const responses = data.responses || { totals: {}, byAutomation: [] };
    const agents = data.agents || [];
    const api = data.apiUsage || { series: [], total: 0 };

    const attempted = (f.sent || 0) + (f.failed || 0);
    const deliveryRate = pct(f.delivered || 0, attempted);
    const replyRate = pct(f.replied || 0, f.delivered || 0);
    const totalSent = ts.reduce((s, d) => s + d.sent, 0);
    const totalFailed = ts.reduce((s, d) => s + d.failed, 0);

    // The whole window against its first half, so the delta means something
    // rather than comparing today to an arbitrary yesterday.
    const half = Math.floor(ts.length / 2);
    const firstHalf = ts.slice(0, half).reduce((s, d) => s + d.sent, 0);
    const secondHalf = ts.slice(half).reduce((s, d) => s + d.sent, 0);
    const trend = firstHalf ? Math.round(((secondHalf - firstHalf) / firstHalf) * 100) : 0;

    const funnelSteps = [
        { label: 'Queued', value: f.queued || 0, dropLabel: 'never attempted' },
        { label: 'Sent', value: f.sent || 0, dropLabel: 'failed to send' },
        { label: 'Delivered', value: f.delivered || 0, dropLabel: 'not delivered' },
        { label: 'Read', value: f.read || 0, dropLabel: 'unread' },
        { label: 'Replied', value: f.replied || 0, dropLabel: 'no reply' },
    ];

    const replyDonut = [
        { name: 'Confirmed', value: responses.totals.confirmed || 0 },
        { name: 'Reschedule', value: responses.totals.reschedule || 0 },
        { name: 'Cancelled', value: responses.totals.cancelled || 0 },
        { name: 'No reply', value: responses.totals.no_reply || 0 },
    ];
    const anyReplies = replyDonut.some((d) => d.value > 0);

    return (
        <div className="view-container">
            <div className="analytics-head">
                <div className="range-picker" role="group" aria-label="Time range">
                    {RANGES.map(([k, label]) => (
                        <button key={k} className={range === k ? 'active' : ''}
                                onClick={() => setRange(k)} aria-pressed={range === k}>
                            {label}
                        </button>
                    ))}
                </div>
                <button className="btn-outline btn-sm" onClick={() => setAsTable((t) => !t)}>
                    {asTable ? <><BarChart3 size={14} /> Charts</> : <><TableIcon size={14} /> Table view</>}
                </button>
            </div>

            {/* Headline numbers. Not everything needs a chart. */}
            <div className="stats-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
                <div className="stat-box">
                    <span className="stat-title">Messages sent</span>
                    <span className="stat-value">{totalSent.toLocaleString()}</span>
                    {ts.length > 1 && (
                        <span className={`stat-delta ${trend >= 0 ? 'up' : 'down'}`}>
                            {trend >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                            {Math.abs(trend)}% vs the first half
                        </span>
                    )}
                </div>
                <div className="stat-box">
                    <span className="stat-title">Delivery rate</span>
                    <span className="stat-value">{deliveryRate}%</span>
                    <span className="stat-delta" style={{ color: 'var(--text-muted)' }}>
                        {(f.delivered || 0).toLocaleString()} of {attempted.toLocaleString()} attempted
                    </span>
                </div>
                <div className="stat-box">
                    <span className="stat-title">Failed</span>
                    <span className="stat-value" style={{ color: totalFailed ? 'var(--danger)' : undefined }}>
                        {totalFailed.toLocaleString()}
                    </span>
                    <span className="stat-delta" style={{ color: 'var(--text-muted)' }}>
                        {pct(totalFailed, attempted)}% of attempts
                    </span>
                </div>
                <div className="stat-box">
                    <span className="stat-title">Reply rate</span>
                    <span className="stat-value">{replyRate}%</span>
                    <Sparkline data={ts} y="replied" />
                </div>
            </div>

            {asTable ? (
                <TableView ts={ts} failures={failures} responses={responses} agents={agents} />
            ) : (
                <div className="chart-grid">
                    <ChartCard title="Message volume"
                               sub="What went out, what failed, and what came back."
                               span={2}>
                        {totalSent + totalFailed === 0 ? <Blank /> : (
                            <TrendLines data={ts} x="label" series={[
                                { key: 'sent', label: 'Sent', colour: 'var(--c1)' },
                                { key: 'failed', label: 'Failed', colour: 'var(--c4)' },
                                { key: 'inbound', label: 'Replies in', colour: 'var(--c3)' },
                            ]} height={210} />
                        )}
                    </ChartCard>

                    <ChartCard title="Delivery funnel"
                               sub="Each step is a subset of the one above, so the gap is where the loss is.">
                        {f.queued ? <Funnel steps={funnelSteps} /> : <Blank />}
                    </ChartCard>

                    <ChartCard title="Why sends failed"
                               sub={failures.reasons.length
                                   ? 'Grouped into causes you can act on.'
                                   : 'Nothing failed in this window.'}>
                        {failures.reasons.length === 0 ? <Blank text="No failures — nothing to explain." /> : (
                            <Bars data={failures.reasons} x="reason" layout="horizontal" height={190}
                                  series={[{ key: 'n', label: 'Failures', colour: 'var(--c4)' }]} />
                        )}
                    </ChartCard>

                    <ChartCard title="How patients answered"
                               sub="Of everything actually delivered in this window.">
                        {anyReplies ? <Donut data={replyDonut} unit="messages" /> : <Blank />}
                    </ChartCard>

                    <ChartCard title="Reply rate by automation"
                               sub="Which wording actually gets an answer.">
                        {responses.byAutomation.length === 0 ? <Blank /> : (
                            <Bars data={responses.byAutomation} x="name" layout="horizontal" height={190}
                                  series={[{ key: 'rate', label: 'Reply rate %', colour: 'var(--c1)' }]} />
                        )}
                    </ChartCard>

                    {failures.worst.length > 0 && (
                        <ChartCard title="Contacts failing most"
                                   sub="Usually a number that is not on WhatsApp.">
                            <div className="tablewrap" style={{ border: 0 }}>
                                <table className="logs-table">
                                    <thead><tr><th>Contact</th><th style={{ width: 90 }}>Failures</th></tr></thead>
                                    <tbody>
                                        {failures.worst.map((w) => (
                                            <tr key={w.id}>
                                                <td>
                                                    <div style={{ fontWeight: 500 }}>{w.name || '—'}</div>
                                                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                                        +{w.phone}
                                                        {w.wa_valid === false && (
                                                            <span className="badge badge-pending badge-prose" style={{ marginLeft: 6 }}>
                                                                Not on WA
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td style={{ fontWeight: 700, color: 'var(--danger)' }}>{w.failures}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div className="alert-box warning" style={{ marginTop: 10 }}>
                                <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                                <span>Run <b>Check numbers</b> on Contacts to flag the ones not on
                                      WhatsApp, and they stop consuming sends.</span>
                            </div>
                        </ChartCard>
                    )}

                    <ChartCard title="Team response time"
                               sub="Median time to first reply — one conversation left overnight should not skew a week.">
                        {agents.length === 0 ? (
                            <Blank text="No conversations have been assigned yet." />
                        ) : (
                            <div className="tablewrap" style={{ border: 0 }}>
                                <table className="logs-table">
                                    <thead>
                                        <tr><th>Member</th><th style={{ width: 70 }}>Open</th>
                                            <th style={{ width: 80 }}>Resolved</th><th style={{ width: 100 }}>Median</th></tr>
                                    </thead>
                                    <tbody>
                                        {agents.map((a) => (
                                            <tr key={a.name}>
                                                <td style={{ fontWeight: 500 }}>{a.name}</td>
                                                <td>{a.conversations - a.resolved}</td>
                                                <td>{a.resolved}</td>
                                                <td className="log-time">{duration(a.median_minutes)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </ChartCard>

                    <ChartCard title="Delivery health"
                               sub="Delivered as a share of everything attempted.">
                        <Gauge value={deliveryRate} label="delivered" />
                        <div className="chart-note">
                            {attempted === 0 ? 'Nothing attempted in this window.'
                                : deliveryRate >= 95 ? 'Healthy. Nothing to do.'
                                : deliveryRate >= 80 ? 'Some sends are not landing — check the failure reasons.'
                                : 'A lot is not landing. Check the number is still linked.'}
                        </div>
                    </ChartCard>

                    <ChartCard title="API sends"
                               sub="Messages other products sent through this number.">
                        {api.total === 0 ? (
                            <Blank text="No API sends yet. Keys live in Settings." />
                        ) : (
                            <>
                                <Bars data={api.series} x="label" height={170}
                                      series={[{ key: 'sends', label: 'Sends', colour: 'var(--c2)' }]} />
                                <div className="chart-note">{api.total.toLocaleString()} in this window.</div>
                            </>
                        )}
                    </ChartCard>
                </div>
            )}
        </div>
    );
}

function Blank({ text = 'Nothing in this window yet.' }) {
    return <div className="chart-blank">{text}</div>;
}

/**
 * The table view.
 *
 * Two of the four series colours fall below 3:1 against the light surface,
 * which obligates a non-colour route to the same numbers. It is also just the
 * fastest way to read an exact figure off a chart.
 */
function TableView({ ts, failures, responses, agents }) {
    return (
        <div className="chart-grid">
            <ChartCard title="Message volume" span={2}>
                <div className="tablewrap">
                    <table className="logs-table">
                        <thead><tr><th>Day</th><th>Sent</th><th>Failed</th><th>Replied</th><th>Messages in</th></tr></thead>
                        <tbody>
                            {ts.map((d, i) => (
                                <tr key={i}>
                                    <td>{d.label}</td><td>{d.sent}</td>
                                    <td style={{ color: d.failed ? 'var(--danger)' : undefined }}>{d.failed}</td>
                                    <td>{d.replied}</td><td>{d.inbound}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </ChartCard>

            <ChartCard title="Failure reasons">
                <div className="tablewrap">
                    <table className="logs-table">
                        <thead><tr><th>Reason</th><th style={{ width: 80 }}>Count</th></tr></thead>
                        <tbody>
                            {failures.reasons.length === 0
                                ? <tr><td colSpan={2} style={{ color: 'var(--text-faint)' }}>None</td></tr>
                                : failures.reasons.map((r) => (
                                    <tr key={r.reason}><td>{r.reason}</td><td>{r.n}</td></tr>
                                ))}
                        </tbody>
                    </table>
                </div>
            </ChartCard>

            <ChartCard title="Reply rate by automation">
                <div className="tablewrap">
                    <table className="logs-table">
                        <thead><tr><th>Automation</th><th>Sent</th><th>Replied</th><th>Rate</th></tr></thead>
                        <tbody>
                            {responses.byAutomation.length === 0
                                ? <tr><td colSpan={4} style={{ color: 'var(--text-faint)' }}>None</td></tr>
                                : responses.byAutomation.map((a) => (
                                    <tr key={a.name}>
                                        <td>{a.name}</td><td>{a.sent}</td><td>{a.replied}</td><td>{a.rate}%</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
            </ChartCard>

            <ChartCard title="Team">
                <div className="tablewrap">
                    <table className="logs-table">
                        <thead><tr><th>Member</th><th>Conversations</th><th>Resolved</th><th>Median</th></tr></thead>
                        <tbody>
                            {agents.length === 0
                                ? <tr><td colSpan={4} style={{ color: 'var(--text-faint)' }}>None</td></tr>
                                : agents.map((a) => (
                                    <tr key={a.name}>
                                        <td>{a.name}</td><td>{a.conversations}</td><td>{a.resolved}</td>
                                        <td>{duration(a.median_minutes)}</td>
                                    </tr>
                                ))}
                        </tbody>
                    </table>
                </div>
            </ChartCard>
        </div>
    );
}
