import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, CalendarClock, XCircle, Clock, MessageSquareDashed } from 'lucide-react';

/**
 * Today's replies at a glance.
 *
 * This is the payoff of the confirmation work: a front desk opening WA Reach at
 * 9am wants to know who is coming, who moved, who dropped out, and who has not
 * answered — not a raw message count.
 */

const TILES = [
    { key: 'confirmed',  label: 'Confirmed',   Icon: CheckCircle2,  color: 'var(--success)' },
    { key: 'reschedule', label: 'Reschedule',  Icon: CalendarClock, color: 'var(--warning)' },
    { key: 'cancelled',  label: 'Cancelled',   Icon: XCircle,       color: 'var(--danger)' },
    { key: 'no_reply',   label: 'No reply',    Icon: Clock,         color: 'var(--text-muted)' },
];

export default function ResponseSummary({ apiUrl, token, socket }) {
    const [data, setData] = useState(null);

    const load = useCallback(async () => {
        try {
            const r = await fetch(`${apiUrl}/dashboard/responses`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (r.ok) setData(await r.json());
        } catch { /* leave the previous view up */ }
    }, [apiUrl, token]);

    useEffect(() => { load(); }, [load]);

    // A reply should move these numbers without a refresh.
    useEffect(() => {
        if (!socket) return;
        socket.on('inbound_message', load);
        return () => socket.off('inbound_message', load);
    }, [socket, load]);

    if (!data) return null;

    const answered = data.confirmed + data.reschedule + data.cancelled;
    const rate = data.total ? Math.round((answered / data.total) * 100) : 0;

    return (
        <div className="card" style={{ marginBottom: 22 }}>
            <div className="card-header">
                <div className="card-title-group">
                    <h3>Today's replies</h3>
                    <span className="card-desc">
                        {data.total === 0
                            ? 'No reminders sent yet today'
                            : `${answered} of ${data.total} answered · ${rate}% response rate`}
                    </span>
                </div>
            </div>

            <div className="response-tiles">
                {TILES.map(({ key, label, Icon, color }) => (
                    <div className="response-tile" key={key}>
                        <Icon size={17} style={{ color }} />
                        <span className="rt-n" style={{ color }}>{data[key]}</span>
                        <span className="rt-l">{label}</span>
                    </div>
                ))}
            </div>

            {data.total > 0 && (
                <div className="response-bar" title={`${rate}% answered`}>
                    {data.confirmed > 0 && <div style={{ width: `${(data.confirmed / data.total) * 100}%`, background: 'var(--success)' }} />}
                    {data.reschedule > 0 && <div style={{ width: `${(data.reschedule / data.total) * 100}%`, background: 'var(--warning)' }} />}
                    {data.cancelled > 0 && <div style={{ width: `${(data.cancelled / data.total) * 100}%`, background: 'var(--danger)' }} />}
                    {data.no_reply > 0 && <div style={{ width: `${(data.no_reply / data.total) * 100}%`, background: 'var(--border-strong)' }} />}
                </div>
            )}

            {data.responses?.length > 0 ? (
                <div className="response-list">
                    {data.responses.slice(0, 8).map((r, i) => (
                        <div className="response-row" key={i}>
                            <span className="rr-name">{r.name && r.name !== 'Unknown' ? r.name : `+${r.phone}`}</span>
                            <span className={`badge badge-${r.response === 'confirm' ? 'delivered' : r.response === 'cancel' ? 'failed' : 'pending'}`}>
                                {r.response === 'confirm' ? 'Confirmed' : r.response === 'reschedule' ? 'Reschedule' : 'Cancelled'}
                            </span>
                        </div>
                    ))}
                </div>
            ) : data.total > 0 ? (
                <div className="response-none">
                    <MessageSquareDashed size={17} />
                    <span>No replies yet. Turn on <strong>Ask for confirmation</strong> in an automation to collect them.</span>
                </div>
            ) : null}
        </div>
    );
}
