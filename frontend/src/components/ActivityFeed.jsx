import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, CheckCircle2, Ban, XCircle, Send, AlertCircle, Activity } from 'lucide-react';

/**
 * One chronological stream of everything that happened — replies arriving and
 * messages going out — rather than making someone read two tables and join them
 * in their head.
 */

function relTime(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime()) / 1000);
    if (Number.isNaN(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function describe(row) {
    if (row.kind === 'inbound') {
        switch (row.detail) {
            case 'confirm':    return { cls: 'confirm', Icon: CheckCircle2, color: 'var(--success)', verb: 'confirmed' };
            case 'opt_out':    return { cls: 'optout',  Icon: Ban,          color: 'var(--danger)',  verb: 'opted out' };
            case 'cancel':     return { cls: 'optout',  Icon: XCircle,      color: 'var(--danger)',  verb: 'cancelled' };
            case 'reschedule': return { cls: 'reply',   Icon: MessageSquare, color: 'var(--warning)', verb: 'asked to reschedule' };
            default:           return { cls: 'reply',   Icon: MessageSquare, color: 'var(--brand-teal)', verb: 'replied' };
        }
    }
    if (row.status === 'failed')    return { cls: 'failed', Icon: AlertCircle, color: 'var(--danger)', verb: 'delivery failed' };
    if (row.status === 'cancelled') return { cls: 'optout', Icon: Ban, color: 'var(--text-muted)', verb: 'cancelled' };
    return { cls: 'sent', Icon: Send, color: 'var(--text-muted)', verb: 'message sent' };
}

export default function ActivityFeed({ apiUrl, token, socket, limit = 12 }) {
    const [rows, setRows] = useState(null);

    const load = useCallback(async () => {
        try {
            const r = await fetch(`${apiUrl}/feed?limit=${limit}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (r.ok) setRows(await r.json());
        } catch { /* keep whatever is on screen */ }
    }, [apiUrl, token, limit]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!socket) return;
        socket.on('inbound_message', load);
        return () => socket.off('inbound_message', load);
    }, [socket, load]);

    return (
        <div className="card">
            <div className="card-header">
                <div className="card-title-group">
                    <h3>Activity</h3>
                    <span className="card-desc">Replies and deliveries, newest first.</span>
                </div>
            </div>

            {rows === null ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>
            ) : rows.length === 0 ? (
                <div className="empty-state" style={{ padding: '28px 16px' }}>
                    <div className="empty-art" style={{ width: 58, height: 58 }}><Activity size={24} strokeWidth={1.5} /></div>
                    <h4>Nothing yet</h4>
                    <p>Once an automation runs, sends and replies show up here as they happen.</p>
                </div>
            ) : rows.map((row, i) => {
                const { cls, Icon, color, verb } = describe(row);
                return (
                    <div className={`feed-item ${cls}`} key={i}>
                        <span className="feed-ico"><Icon size={16} style={{ color }} /></span>
                        <div className="feed-body">
                            <div className="feed-top">
                                <span className="feed-who">
                                    {row.who && row.who !== 'Unknown' ? row.who : `+${row.phone || ''}`}
                                    <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> {verb}</span>
                                </span>
                                <span className="feed-when">{relTime(row.at)}</span>
                            </div>
                            {row.text && <div className="feed-text">{row.text}</div>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
