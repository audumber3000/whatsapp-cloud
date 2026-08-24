import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Inbox as InboxIcon, CheckCircle2, CalendarClock, XCircle, Ban, Image as ImageIcon, RefreshCw } from 'lucide-react';

/**
 * The inbox. Until now the app was outbound-only — a patient who replied was
 * talking into a void — so this is the first screen that shows both sides of a
 * conversation.
 */

const INTENT = {
    confirm:    { label: 'Confirmed',   icon: CheckCircle2,  cls: 'badge-delivered' },
    reschedule: { label: 'Reschedule',  icon: CalendarClock, cls: 'badge-pending' },
    cancel:     { label: 'Cancelled',   icon: XCircle,       cls: 'badge-failed' },
    opt_out:    { label: 'Opted out',   icon: Ban,           cls: 'badge-failed' },
};

function IntentBadge({ intent }) {
    const meta = INTENT[intent];
    if (!meta) return null;
    const Icon = meta.icon;
    return (
        <span className={`badge ${meta.cls}`}>
            <Icon size={12} /> {meta.label}
        </span>
    );
}

function timeAgo(iso) {
    if (!iso) return '';
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
    return `${Math.floor(secs / 86400)}d`;
}

export default function InboxView({ apiUrl, token, socket, onToast }) {
    const [threads, setThreads] = useState([]);
    const [active, setActive] = useState(null);
    const [messages, setMessages] = useState([]);
    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const endRef = useRef(null);

    const auth = { 'Authorization': `Bearer ${token}` };

    const loadThreads = useCallback(async () => {
        try {
            const r = await fetch(`${apiUrl}/inbox`, { headers: auth });
            if (r.ok) setThreads(await r.json());
        } finally { setLoading(false); }
    }, [apiUrl, token]);

    const loadThread = useCallback(async (number) => {
        const r = await fetch(`${apiUrl}/inbox/${number}`, { headers: auth });
        if (r.ok) setMessages(await r.json());
    }, [apiUrl, token]);

    useEffect(() => { loadThreads(); }, [loadThreads]);
    useEffect(() => { if (active) loadThread(active.from_number); }, [active, loadThread]);
    useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

    // Live updates — a reply should appear without a refresh.
    useEffect(() => {
        if (!socket) return;
        const onInbound = (msg) => {
            loadThreads();
            if (active && msg.from === active.from_number) loadThread(active.from_number);
        };
        socket.on('inbound_message', onInbound);
        return () => socket.off('inbound_message', onInbound);
    }, [socket, active, loadThreads, loadThread]);

    const send = async (e) => {
        e?.preventDefault();
        const text = draft.trim();
        if (!text || !active || sending) return;
        setSending(true);
        try {
            const r = await fetch(`${apiUrl}/inbox/${active.from_number}/reply`, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            if (r.ok) {
                setDraft('');
                setMessages((m) => [...m, {
                    id: `tmp-${Date.now()}`, body: text, direction: 'out',
                    received_at: new Date().toISOString(),
                }]);
            } else {
                const err = await r.json().catch(() => ({}));
                onToast?.('error', err.error || 'Could not send');
            }
        } finally { setSending(false); }
    };

    if (loading) {
        return <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading inbox…</div>;
    }

    return (
        <div className="inbox-layout">
            {/* conversations */}
            <aside className="inbox-list card" style={{ padding: 0 }}>
                <div className="inbox-list-head">
                    <h3>Conversations</h3>
                    <button className="icon-btn" onClick={loadThreads} title="Refresh"><RefreshCw size={16} /></button>
                </div>

                {threads.length === 0 ? (
                    <div className="inbox-empty">
                        <InboxIcon size={30} strokeWidth={1.5} />
                        <p><strong>No replies yet</strong></p>
                        <p>When a patient answers a reminder, the conversation appears here.</p>
                    </div>
                ) : threads.map((t) => (
                    <button
                        key={t.from_number}
                        className={`inbox-row${active?.from_number === t.from_number ? ' active' : ''}`}
                        onClick={() => setActive(t)}
                    >
                        <div className="inbox-row-top">
                            <span className="inbox-name">{t.name}</span>
                            <span className="inbox-time">{timeAgo(t.last_at)}</span>
                        </div>
                        <div className="inbox-row-bot">
                            <span className="inbox-preview">{t.last_body || '(attachment)'}</span>
                            {Number(t.unread) > 0 && <span className="inbox-unread">{t.unread}</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                            <IntentBadge intent={t.last_intent} />
                            {Number(t.opted_out) === 1 && <span className="badge badge-failed"><Ban size={12} /> Opted out</span>}
                        </div>
                    </button>
                ))}
            </aside>

            {/* thread */}
            <section className="inbox-thread card" style={{ padding: 0 }}>
                {!active ? (
                    <div className="inbox-empty" style={{ height: '100%' }}>
                        <InboxIcon size={34} strokeWidth={1.5} />
                        <p><strong>Pick a conversation</strong></p>
                        <p>Replies, confirmations and photos patients send in all land here.</p>
                    </div>
                ) : (
                    <>
                        <div className="inbox-list-head">
                            <div>
                                <h3 style={{ marginBottom: 2 }}>{active.name}</h3>
                                <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>+{active.from_number}</span>
                            </div>
                            {Number(active.opted_out) === 1 && <span className="badge badge-failed"><Ban size={12} /> Opted out</span>}
                        </div>

                        <div className="inbox-messages">
                            {messages.map((m) => (
                                <div key={m.id} className={`bubble ${m.direction === 'in' ? 'in' : 'out'}`}>
                                    {m.media_type && (
                                        <div className="bubble-media"><ImageIcon size={14} /> {m.media_type}</div>
                                    )}
                                    {m.body && <div className="bubble-body">{m.body}</div>}
                                    <div className="bubble-meta">
                                        {m.direction === 'in' && m.intent && INTENT[m.intent] && (
                                            <IntentBadge intent={m.intent} />
                                        )}
                                        <span>{new Date(m.received_at).toLocaleString()}</span>
                                    </div>
                                </div>
                            ))}
                            <div ref={endRef} />
                        </div>

                        <form className="inbox-composer" onSubmit={send}>
                            <input
                                type="text"
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder={Number(active.opted_out) === 1 ? 'This contact opted out' : 'Type a reply…'}
                                disabled={Number(active.opted_out) === 1 || sending}
                            />
                            <button className="btn-primary" type="submit" disabled={!draft.trim() || sending}>
                                <Send size={16} /> {sending ? 'Sending…' : 'Send'}
                            </button>
                        </form>
                    </>
                )}
            </section>
        </div>
    );
}
