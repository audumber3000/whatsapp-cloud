import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    Send, Inbox as InboxIcon, Search, Check, CheckCheck, Clock, AlertTriangle,
    Image as ImageIcon, StickyNote, UserPlus, CheckCircle2, Tag as TagIcon,
    MoreVertical, ArrowLeft, Ban, MessageSquare,
} from 'lucide-react';
import Avatar from './ui/Avatar';
import Dropdown, { DropdownItem, DropdownDivider } from './ui/Dropdown';
import { useIsMobile } from '../hooks/useMediaQuery';
import useEvent from '../hooks/useEvent';

/**
 * The team inbox, built to read like WhatsApp Web.
 *
 * Clinic staff already live in WhatsApp Web all day, so this borrows its
 * geometry rather than inventing a CRM inbox: chat list left, thread on the
 * tinted ground right, tailed bubbles with the clock and ticks inside them,
 * centred date chips.
 *
 * What WhatsApp Web has no concept of — assignment, internal notes, resolve,
 * labels, canned replies — is expressed in the same idiom instead of bolted on
 * beside it.
 *
 * Note this product links an ORDINARY number through Evolution, not the Meta
 * Cloud API. The 24-hour customer service window is a Meta construct and does
 * not apply: an agent can reply whenever they like, exactly as they could from
 * the phone itself. What is real on an unofficial number is ban risk, so the
 * composer warns about cold outreach rather than refusing to send.
 *
 * Note this screen previously called three endpoints that were never written:
 * every request 404'd and the component swallowed it, which is why it always
 * said "No replies yet".
 */

const STATUS_TABS = [
    { key: 'open', label: 'Open' },
    { key: 'pending', label: 'Waiting' },
    { key: 'resolved', label: 'Resolved' },
];

const INTENT_LABEL = {
    confirm: 'Confirmed', reschedule: 'Reschedule',
    cancel: 'Cancelled', opt_out: 'Opted out',
};

const clock = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function dayLabel(iso) {
    const d = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return d.toLocaleDateString([], { weekday: 'long' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** WhatsApp's list clock: time today, "Yesterday", then the date. */
function listStamp(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return clock(iso);
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function waited(since) {
    const mins = Math.floor((Date.now() - new Date(since).getTime()) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Delivery ticks, WhatsApp's own vocabulary. */
function Ticks({ status, delivery }) {
    if (status === 'failed') return <AlertTriangle size={13} />;
    const state = delivery || status;
    if (state === 'read') return <CheckCheck size={15} className="tick-read" />;
    if (state === 'delivered') return <CheckCheck size={15} />;
    if (state === 'sent' || status === 'sent') return <Check size={15} />;
    return <Clock size={12} />;
}

export default function InboxView({ apiUrl, token, socket, onToast: rawToast }) {
    // Stable identity: a parent passing an inline arrow must not make
    // every fetch callback re-fire. See hooks/useEvent.js.
    const onToast = useEvent(rawToast);
    const [list, setList] = useState([]);
    const [counts, setCounts] = useState({ open: 0, pending: 0, resolved: 0, mine: 0, unassigned: 0 });
    const [statusTab, setStatusTab] = useState('open');
    const [assignee, setAssignee] = useState('all');
    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [activeId, setActiveId] = useState(null);
    const [thread, setThread] = useState(null);
    const [members, setMembers] = useState([]);
    const [labels, setLabels] = useState([]);
    const [canned, setCanned] = useState([]);
    const [draft, setDraft] = useState('');
    const [mode, setMode] = useState('reply');       // reply | note
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const [typingBy, setTypingBy] = useState(null);
    const paneRef = useRef(null);
    const typingTimer = useRef(null);
    const isMobile = useIsMobile();

    const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
    const jsonHeaders = useMemo(() => ({ ...auth, 'Content-Type': 'application/json' }), [auth]);

    useEffect(() => { const t = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(t); }, [search]);

    const loadList = useCallback(async () => {
        try {
            const q = new URLSearchParams({ status: statusTab, assignee });
            if (debounced) q.set('search', debounced);
            const r = await fetch(`${apiUrl}/inbox?${q}`, { headers: auth });
            if (!r.ok) throw new Error();
            const d = await r.json();
            setList(d.data || []);
            setCounts((prev) => d.counts || prev);
        } catch { onToast?.('error', 'Could not load the inbox'); }
        finally { setLoading(false); }
    }, [apiUrl, auth, statusTab, assignee, debounced, onToast]);

    const loadThread = useCallback(async (id) => {
        if (!id) { setThread(null); return; }
        try {
            const r = await fetch(`${apiUrl}/inbox/${id}`, { headers: auth });
            if (!r.ok) throw new Error();
            setThread(await r.json());
            // Opening a conversation is reading it.
            fetch(`${apiUrl}/inbox/${id}`, {
                method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ read: true }),
            }).then(() => setList((l) => l.map((c) => c.id === id ? { ...c, unread_count: 0 } : c)));
        } catch { onToast?.('error', 'Could not open that conversation'); }
    }, [apiUrl, auth, jsonHeaders, onToast]);

    useEffect(() => { loadList(); }, [loadList]);
    useEffect(() => { loadThread(activeId); }, [activeId, loadThread]);

    useEffect(() => {
        Promise.all([
            fetch(`${apiUrl}/inbox/members`, { headers: auth }).then((r) => r.json()).catch(() => []),
            fetch(`${apiUrl}/labels`, { headers: auth }).then((r) => r.json()).catch(() => []),
            fetch(`${apiUrl}/canned-replies`, { headers: auth }).then((r) => r.json()).catch(() => []),
        ]).then(([m, l, c]) => {
            setMembers(Array.isArray(m) ? m : []);
            setLabels(Array.isArray(l) ? l : []);
            setCanned(Array.isArray(c) ? c : []);
        });
    }, [apiUrl, auth]);

    /* ── live ───────────────────────────────────────────────────────────── */
    useEffect(() => {
        const sock = socket?.current || socket;
        if (!sock?.on) return;
        const onInbound = () => { loadList(); if (activeId) loadThread(activeId); };
        const onMessage = ({ conversationId, message }) => {
            loadList();
            if (conversationId === activeId) {
                setThread((t) => t ? { ...t, messages: [...t.messages, message] } : t);
            }
        };
        const onUpdated = ({ conversation }) => {
            loadList();
            if (conversation?.id === activeId) setThread((t) => t ? { ...t, conversation } : t);
        };
        const onTyping = ({ conversationId, username, typing }) => {
            if (conversationId !== activeId) return;
            setTypingBy(typing ? username : null);
        };
        sock.on('inbound_message', onInbound);
        sock.on('inbox:message', onMessage);
        sock.on('inbox:updated', onUpdated);
        sock.on('inbox:typing', onTyping);
        return () => {
            sock.off('inbound_message', onInbound);
            sock.off('inbox:message', onMessage);
            sock.off('inbox:updated', onUpdated);
            sock.off('inbox:typing', onTyping);
        };
    }, [socket, activeId, loadList, loadThread]);

    useEffect(() => {
        const pane = paneRef.current;
        if (pane) pane.scrollTop = pane.scrollHeight;
    }, [thread?.messages?.length, activeId]);

    /* ── actions ────────────────────────────────────────────────────────── */
    const patch = async (body, quiet) => {
        const r = await fetch(`${apiUrl}/inbox/${activeId}`, {
            method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return onToast?.('error', d.error || 'That did not work');
        setThread((t) => t ? { ...t, conversation: d } : t);
        loadList();
        if (!quiet) onToast?.('success', 'Conversation updated.');
    };

    const resolveAndNext = async () => {
        const rest = list.filter((c) => c.id !== activeId);
        await patch({ status: 'resolved', read: true }, true);
        onToast?.('success', 'Resolved.');
        setActiveId(rest[0]?.id || null);
    };

    const send = async (e) => {
        e?.preventDefault();
        const body = draft.trim();
        if (!body || sending) return;
        setSending(true);
        try {
            const url = mode === 'note' ? `${apiUrl}/inbox/${activeId}/notes` : `${apiUrl}/inbox/${activeId}/reply`;
            const r = await fetch(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ body }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return onToast?.('error', d.detail || d.error || 'Could not send that');
            setDraft('');
            loadThread(activeId);
            loadList();
        } finally { setSending(false); }
    };

    const onDraftChange = (v) => {
        setDraft(v);
        const sock = socket?.current || socket;
        if (!sock?.emit || !activeId || mode === 'note') return;
        sock.emit('inbox:typing', { conversationId: activeId, typing: true });
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(
            () => sock.emit('inbox:typing', { conversationId: activeId, typing: false }), 2500);
    };

    // "/" at the start of an empty-ish draft opens the canned-reply picker.
    const cannedQuery = draft.startsWith('/') ? draft.slice(1).toLowerCase() : null;
    const cannedMatches = cannedQuery === null ? []
        : canned.filter((c) => c.shortcut.includes(cannedQuery) || c.title.toLowerCase().includes(cannedQuery));

    const applyCanned = (c) => {
        const name = thread?.conversation?.name || 'there';
        setDraft(c.body.replace(/\{\{\s*name\s*\}\}/gi, name));
    };

    const cv = thread?.conversation;
    const showList = !isMobile || !activeId;
    const showThread = !isMobile || !!activeId;

    return (
        <div className="view-container">
            <div className="inbox-layout" style={isMobile ? { gridTemplateColumns: '1fr' } : undefined}>
                {showList && (
                    <div className="inbox-list">
                        <div className="inbox-list-head">
                            <div className="search-box">
                                <Search size={15} />
                                <input value={search} onChange={(e) => setSearch(e.target.value)}
                                       placeholder="Search or start a new chat" />
                            </div>
                        </div>

                        <div className="inbox-filters">
                            {STATUS_TABS.map((t) => (
                                <button key={t.key} className={`inbox-chip${statusTab === t.key ? ' active' : ''}`}
                                        onClick={() => setStatusTab(t.key)}>
                                    {t.label}{counts[t.key] > 0 && <span className="n">{counts[t.key]}</span>}
                                </button>
                            ))}
                        </div>
                        <div className="inbox-filters" style={{ paddingBottom: 9 }}>
                            {[['all', 'Everyone'], ['me', 'Mine'], ['unassigned', 'Unassigned']].map(([k, label]) => (
                                <button key={k} className={`inbox-chip${assignee === k ? ' active' : ''}`}
                                        onClick={() => setAssignee(k)}>
                                    {label}
                                    {k !== 'all' && counts[k] > 0 && <span className="n">{counts[k]}</span>}
                                </button>
                            ))}
                        </div>

                        <div className="inbox-list-scroll">
                            {loading ? (
                                <div className="inbox-empty"><p>Loading…</p></div>
                            ) : list.length === 0 ? (
                                <div className="inbox-empty">
                                    <InboxIcon size={30} strokeWidth={1.5} />
                                    <p>
                                        <strong>Nothing here</strong>
                                        {statusTab === 'open'
                                            ? 'When a patient replies, the conversation lands here.'
                                            : 'No conversations match this filter.'}
                                    </p>
                                </div>
                            ) : list.map((c) => {
                                const unread = c.unread_count > 0;
                                const lm = c.last_message || {};
                                // The SLA clock only runs while they are waiting on us.
                                const awaiting = c.last_inbound_at && !c.first_response_at && c.status !== 'resolved';
                                const mins = awaiting ? (Date.now() - new Date(c.last_inbound_at)) / 60000 : 0;
                                return (
                                    <button key={c.id} className={`inbox-row${c.id === activeId ? ' active' : ''}${unread ? ' unread' : ''}`}
                                            onClick={() => setActiveId(c.id)}>
                                        <Avatar name={c.name || c.phone} size={42} />
                                        <div className="inbox-row-main">
                                            <div className="inbox-row-top">
                                                <span className="inbox-name">{c.name || `+${c.phone}`}</span>
                                                <span className="inbox-time">{listStamp(c.last_message_at)}</span>
                                            </div>
                                            <div className="inbox-row-bot">
                                                <span className="inbox-preview">
                                                    {lm.direction === 'out' && <Check size={13} style={{ flex: 'none' }} />}
                                                    {lm.body || <em>No messages yet</em>}
                                                </span>
                                                {unread && <span className="inbox-unread">{c.unread_count}</span>}
                                            </div>
                                            <div className="inbox-row-meta">
                                                {awaiting && (
                                                    <span className={`sla-chip${mins > 240 ? ' late' : mins > 60 ? ' warn' : ''}`}>
                                                        <Clock size={9} /> {waited(c.last_inbound_at)}
                                                    </span>
                                                )}
                                                {c.assignee_name && (
                                                    <span className="sla-chip">
                                                        {c.assignee_full_name || c.assignee_name}
                                                    </span>
                                                )}
                                                {(c.labels || []).map((l) => (
                                                    <span key={l.id} className="tag-chip"
                                                          style={{ background: l.colour, borderColor: l.colour, color: '#fff' }}>
                                                        {l.name}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}

                {showThread && (!cv ? (
                    <div className="thread-blank">
                        <MessageSquare size={44} strokeWidth={1} color="var(--text-faint)" />
                        <h4>WA Reach for teams</h4>
                        <p>Pick a conversation to read it. Replies, confirmations and photos
                           patients send all land here, and anyone on your team can pick one up.</p>
                    </div>
                ) : (
                    <div className="inbox-thread">
                        <ThreadHeader
                            cv={cv} members={members} labels={labels} typingBy={typingBy} isMobile={isMobile}
                            onBack={() => setActiveId(null)}
                            onAssign={(id) => patch({ assignee_id: id })}
                            onStatus={(s) => patch({ status: s })}
                            onResolveNext={resolveAndNext}
                            onLabels={async (ids) => {
                                const r = await fetch(`${apiUrl}/inbox/${cv.id}/labels`, {
                                    method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ label_ids: ids }),
                                });
                                if (!r.ok) return;
                                const fresh = await r.json();
                                setThread((t) => t ? { ...t, conversation: fresh } : t);
                                loadList();
                            }}
                        />

                        <div className="thread-messages" ref={paneRef}>
                            <Timeline messages={thread.messages} />
                        </div>

                        {cv.opted_out ? (
                            <div className="composer-closed">
                                <Ban size={16} style={{ flex: 'none', marginTop: 1 }} />
                                <span>This contact opted out of messages. Automations, the API and this
                                      composer all skip them until they message in again.</span>
                            </div>
                        ) : (
                            <>
                                {cv.outreach?.cold && mode === 'reply' && (
                                    <div className="composer-caution">
                                        <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                                        <span>
                                            <b>They have never messaged you.</b> Sending first is what gets a
                                            number reported and banned — this is a linked personal number, not a
                                            verified business one. Keep it expected and personal.
                                        </span>
                                    </div>
                                )}
                                <div className="composer-mode">
                                    <button className={mode === 'reply' ? 'active' : ''} onClick={() => setMode('reply')}>
                                        Reply
                                    </button>
                                    <button className={`note-mode${mode === 'note' ? ' active' : ''}`}
                                            onClick={() => setMode('note')}>
                                        <StickyNote size={12} style={{ verticalAlign: -2 }} /> Internal note
                                    </button>
                                    {canned.length > 0 && mode === 'reply' && (
                                        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', alignSelf: 'center', marginLeft: 4 }}>
                                            type <b>/</b> for a saved reply
                                        </span>
                                    )}
                                </div>
                                <form className="thread-composer" onSubmit={send} style={{ position: 'relative' }}>
                                    {cannedMatches.length > 0 && (
                                        <div className="canned-pop">
                                            {cannedMatches.map((c) => (
                                                <button type="button" key={c.id} className="canned-item"
                                                        onClick={() => applyCanned(c)}>
                                                    <b>/{c.shortcut} — {c.title}</b>
                                                    <span>{c.body}</span>
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                    <textarea
                                        value={draft}
                                        onChange={(e) => onDraftChange(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); }
                                        }}
                                        placeholder={mode === 'note'
                                            ? 'Internal note — the patient never sees this'
                                            : 'Type a message'}
                                        rows={1}
                                        aria-label={mode === 'note' ? 'Internal note' : 'Message'}
                                    />
                                    <button className="composer-send" disabled={sending || !draft.trim()}
                                            aria-label={mode === 'note' ? 'Save note' : 'Send message'}>
                                        {mode === 'note' ? <StickyNote size={17} /> : <Send size={17} />}
                                    </button>
                                </form>
                            </>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

/* ── header ─────────────────────────────────────────────────────────────── */
function ThreadHeader({ cv, members, labels, typingBy, isMobile, onBack, onAssign, onStatus, onResolveNext, onLabels }) {
    const activeLabels = new Set((cv.labels || []).map((l) => l.id));
    const toggleLabel = (id) => {
        const next = new Set(activeLabels);
        next.has(id) ? next.delete(id) : next.add(id);
        onLabels([...next]);
    };

    return (
        <>
            <div className="thread-head">
                {isMobile && (
                    <button className="icon-btn" onClick={onBack} aria-label="Back to conversations">
                        <ArrowLeft size={19} />
                    </button>
                )}
                <Avatar name={cv.name || cv.phone} size={38} />
                <div className="thread-who">
                    <h4>{cv.name || `+${cv.phone}`}</h4>
                    <div className="thread-sub">
                        {typingBy ? (
                            <span className="typing-note">{typingBy} is typing…</span>
                        ) : (
                            <>
                                <span>+{cv.phone}</span>
                                {cv.assignee_name
                                    ? <span>· {cv.assignee_full_name || cv.assignee_name}</span>
                                    : <span>· Unassigned</span>}
                                {cv.outreach?.lastInboundAt
                                    ? <span>· wrote {waited(cv.outreach.lastInboundAt)} ago</span>
                                    : <span style={{ color: 'var(--warning)' }}>· never messaged you</span>}
                            </>
                        )}
                    </div>
                </div>

                <div className="thread-actions">
                    {cv.status !== 'resolved' && (
                        <button className="btn-outline btn-sm" onClick={onResolveNext}
                                aria-label="Resolve and open the next conversation">
                            <CheckCircle2 size={14} />{!isMobile && ' Resolve & next'}
                        </button>
                    )}
                    <Dropdown width={230} trigger={<span className="icon-btn"><MoreVertical size={18} /></span>}>
                        <div style={{ padding: '6px 10px 3px', fontSize: 11, fontWeight: 700,
                                      textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-faint)' }}>
                            Assign to
                        </div>
                        {members.map((m) => (
                            <DropdownItem key={m.id} icon={<UserPlus size={15} />} onClick={() => onAssign(m.id)}>
                                {m.full_name || m.username}{m.id === cv.assignee_id ? ' ✓' : ''}
                            </DropdownItem>
                        ))}
                        {cv.assignee_id && (
                            <DropdownItem icon={<UserPlus size={15} />} onClick={() => onAssign(null)}>Unassign</DropdownItem>
                        )}
                        <DropdownDivider />
                        <DropdownItem icon={<Clock size={15} />} onClick={() => onStatus('pending')}>
                            Mark as waiting on patient
                        </DropdownItem>
                        <DropdownItem icon={<InboxIcon size={15} />} onClick={() => onStatus('open')}>
                            Reopen
                        </DropdownItem>
                        {labels.length > 0 && <DropdownDivider />}
                        {labels.map((l) => (
                            <DropdownItem key={l.id} icon={<TagIcon size={15} />} onClick={() => toggleLabel(l.id)}>
                                {l.name}{activeLabels.has(l.id) ? ' ✓' : ''}
                            </DropdownItem>
                        ))}
                    </Dropdown>
                </div>
            </div>

            {(cv.labels || []).length > 0 && (
                <div className="thread-labels">
                    <TagIcon size={13} color="var(--text-faint)" />
                    {cv.labels.map((l) => (
                        <span key={l.id} className="tag-chip"
                              style={{ background: l.colour, borderColor: l.colour, color: '#fff' }}>
                            {l.name}
                        </span>
                    ))}
                </div>
            )}
        </>
    );
}

/* ── message stream ─────────────────────────────────────────────────────── */
function Timeline({ messages }) {
    let lastDay = null;
    let lastKind = null;

    return messages.map((m, i) => {
        const day = dayLabel(m.at);
        const newDay = day !== lastDay;
        lastDay = day;

        // Only the first bubble of a run carries a tail, as WhatsApp does.
        const runStart = newDay || m.kind !== lastKind;
        lastKind = m.kind;

        const chip = newDay ? <div className="thread-chip" key={`d${i}`}>{day}</div> : null;

        if (m.kind === 'event') {
            const who = m.author || 'Someone';
            const to = m.detail?.to;
            const text = m.event_kind === 'assigned' ? `${who} assigned this to ${to}`
                : m.event_kind === 'unassigned' ? `${who} unassigned this`
                : m.event_kind === 'status' ? `${who} marked this ${to === 'pending' ? 'as waiting' : to}`
                : `${who} updated this`;
            return (
                <div key={i}>
                    {chip}
                    <div className="thread-chip system" style={{ display: 'block', width: 'fit-content', margin: '8px auto' }}>
                        {text} · {clock(m.at)}
                    </div>
                </div>
            );
        }

        if (m.kind === 'note') {
            return (
                <div key={i} style={{ display: 'contents' }}>
                    {chip}
                    <div className="bubble note">
                        <div className="bubble-author"><StickyNote size={12} /> Internal note · {m.author || 'Someone'}</div>
                        <div className="bubble-body">{m.body}</div>
                        <span className="bubble-meta">{clock(m.at)}</span>
                    </div>
                </div>
            );
        }

        const out = m.kind === 'out';
        return (
            <div key={i} style={{ display: 'contents' }}>
                {chip}
                <div className={`bubble ${out ? 'out' : 'in'}${runStart ? '' : ' tailless'}`}>
                    {out && m.author && <div className="bubble-author">{m.author}</div>}
                    {m.media_type && (
                        <div className="bubble-media"><ImageIcon size={13} /> {m.media_type}</div>
                    )}
                    <span className="bubble-body">
                        {m.body}
                        {!out && INTENT_LABEL[m.intent] && (
                            <span className="badge badge-delivered badge-prose"
                                  style={{ marginLeft: 8, verticalAlign: 'middle' }}>
                                {INTENT_LABEL[m.intent]}
                            </span>
                        )}
                    </span>
                    <span className="bubble-meta">
                        {clock(m.at)}
                        {out && <Ticks status={m.status} delivery={m.delivery_status} />}
                    </span>
                </div>
            </div>
        );
    });
}
