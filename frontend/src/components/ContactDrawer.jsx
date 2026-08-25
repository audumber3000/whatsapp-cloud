import { useState, useEffect, useCallback } from 'react';
import {
    Send, MessageSquare, StickyNote, Ban, CheckCircle2, XCircle,
    AlertCircle, Tag as TagIcon, Trash2, Clock,
} from 'lucide-react';
import Drawer from './ui/Drawer';
import { useConfirm } from './ui/ConfirmDialog';

/**
 * The contact record.
 *
 * There was no detail view of any kind — a row in the contacts table was inert,
 * and the person's history lived scattered across two tables nobody joined.
 */

function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const secs = Math.floor((Date.now() - d.getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    if (secs < 604800) return `${Math.floor(secs / 86400)}d ago`;
    return d.toLocaleDateString();
}

const ENTRY = {
    outbound: { Icon: Send, colour: 'var(--text-muted)', label: 'Sent' },
    inbound: { Icon: MessageSquare, colour: 'var(--brand-teal)', label: 'Replied' },
    note: { Icon: StickyNote, colour: 'var(--c2)', label: 'Note' },
};

export default function ContactDrawer({ open, contactId, apiUrl, token, onClose, onChanged, onToast }) {
    const [contact, setContact] = useState(null);
    const [timeline, setTimeline] = useState([]);
    const [allTags, setAllTags] = useState([]);
    const [note, setNote] = useState('');
    const [tab, setTab] = useState('activity');
    const [busy, setBusy] = useState(false);
    const confirm = useConfirm();

    const auth = { Authorization: `Bearer ${token}` };

    const load = useCallback(async () => {
        if (!contactId) return;
        const [c, t, tags] = await Promise.all([
            fetch(`${apiUrl}/contacts/${contactId}`, { headers: auth }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetch(`${apiUrl}/contacts/${contactId}/timeline`, { headers: auth }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
            fetch(`${apiUrl}/tags`, { headers: auth }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        ]);
        setContact(c);
        setTimeline(Array.isArray(t) ? t : []);
        setAllTags(Array.isArray(tags) ? tags : []);
    }, [apiUrl, token, contactId]);

    useEffect(() => { if (open) { setTab('activity'); load(); } }, [open, load]);

    const save = async (patch) => {
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/contacts/${contactId}`, {
                method: 'PUT',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...contact, ...patch }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return onToast('error', d.error || 'Could not save');
            onToast('success', 'Contact updated.');
            onChanged?.();
            load();
        } finally { setBusy(false); }
    };

    const toggleTag = async (tagId) => {
        const have = contact.tags.some((t) => t.id === tagId);
        const next = have ? contact.tags.filter((t) => t.id !== tagId).map((t) => t.id)
                          : [...contact.tags.map((t) => t.id), tagId];
        const r = await fetch(`${apiUrl}/contacts/${contactId}/tags`, {
            method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag_ids: next }),
        });
        if (r.ok) { load(); onChanged?.(); } else onToast('error', 'Could not update tags');
    };

    const addNote = async (e) => {
        e.preventDefault();
        const body = note.trim();
        if (!body) return;
        const r = await fetch(`${apiUrl}/contacts/${contactId}/notes`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ body }),
        });
        if (r.ok) { setNote(''); load(); } else onToast('error', 'Could not save the note');
    };

    const toggleOptOut = async () => {
        const turningOff = !contact.opted_out;
        if (turningOff) {
            const ok = await confirm({
                title: `Stop messaging ${contact.name || contact.phone}?`,
                body: 'Anything already queued for them is cancelled, and automations will skip them from now on.',
                confirmLabel: 'Stop messaging', danger: true,
            });
            if (!ok) return;
        }
        const r = await fetch(`${apiUrl}/contacts/${contactId}/optout`, {
            method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ opted_out: turningOff }),
        });
        if (r.ok) { load(); onChanged?.(); onToast('success', turningOff ? 'Contact opted out.' : 'Contact opted back in.'); }
    };

    if (!open) return null;

    const title = contact ? (contact.name || `+${contact.phone}`) : 'Contact';

    return (
        <Drawer
            open={open}
            onClose={onClose}
            title={title}
            subtitle={contact ? `+${contact.phone}` : ''}
            width={520}
            footer={contact && (
                <>
                    <button className="btn-outline btn-sm" onClick={toggleOptOut}>
                        <Ban size={14} /> {contact.opted_out ? 'Allow messages' : 'Stop messaging'}
                    </button>
                    <button className="btn-primary btn-sm" onClick={() => save({})} disabled={busy}>
                        {busy ? 'Saving…' : 'Save'}
                    </button>
                </>
            )}
        >
            {!contact ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : (
                <>
                    {contact.opted_out && (
                        <div className="alert-box danger" style={{ marginBottom: 14 }}>
                            <Ban size={15} style={{ flex: 'none', marginTop: 1 }} />
                            <span>This contact has opted out. Automations and the API will skip them.</span>
                        </div>
                    )}
                    {contact.wa_valid === false && (
                        <div className="alert-box warning" style={{ marginBottom: 14 }}>
                            <AlertCircle size={15} style={{ flex: 'none', marginTop: 1 }} />
                            <span>This number isn't registered on WhatsApp, so messages to it will fail.</span>
                        </div>
                    )}

                    <div className="form-group">
                        <label htmlFor="cd-name">Name</label>
                        <input id="cd-name" value={contact.name || ''}
                               onChange={(e) => setContact({ ...contact, name: e.target.value })} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="cd-phone">Phone</label>
                        <input id="cd-phone" value={contact.phone || ''}
                               onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="cd-email">Email</label>
                        <input id="cd-email" type="email" value={contact.email || ''}
                               onChange={(e) => setContact({ ...contact, email: e.target.value })} />
                    </div>

                    <div className="form-group">
                        <label><TagIcon size={13} style={{ verticalAlign: '-2px' }} /> Tags</label>
                        {allTags.length === 0 ? (
                            <p style={{ fontSize: 12.5, color: 'var(--text-faint)', margin: 0 }}>
                                No tags yet — create them in Settings.
                            </p>
                        ) : (
                            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                                {allTags.map((t) => {
                                    const on = contact.tags.some((x) => x.id === t.id);
                                    return (
                                        <button key={t.id} type="button" onClick={() => toggleTag(t.id)}
                                            className="tag-chip"
                                            style={on
                                                ? { background: t.colour, borderColor: t.colour, color: '#fff' }
                                                : undefined}>
                                            {t.name}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    <div className="ds-tabs" style={{ marginTop: 18, marginBottom: 14 }}>
                        <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>
                            Activity
                        </button>
                        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
                            Notes {contact.notes.length ? `(${contact.notes.length})` : ''}
                        </button>
                    </div>

                    {tab === 'notes' ? (
                        <>
                            <form onSubmit={addNote} style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                                <input value={note} onChange={(e) => setNote(e.target.value)}
                                       placeholder="Add a note about this patient…" />
                                <button className="btn-primary btn-sm" type="submit" disabled={!note.trim()}>Add</button>
                            </form>
                            {contact.notes.length === 0 ? (
                                <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No notes yet.</p>
                            ) : contact.notes.map((n) => (
                                <div className="feed-item" key={n.id}>
                                    <span className="feed-ico"><StickyNote size={15} style={{ color: 'var(--c2)' }} /></span>
                                    <div className="feed-body">
                                        <div className="feed-top">
                                            <span className="feed-who">{n.author || 'Someone'}</span>
                                            <span className="feed-when">{when(n.created_at)}</span>
                                        </div>
                                        <div className="feed-text">{n.body}</div>
                                    </div>
                                </div>
                            ))}
                        </>
                    ) : timeline.length === 0 ? (
                        <div className="empty-state" style={{ padding: '28px 12px' }}>
                            <div className="empty-art" style={{ width: 54, height: 54 }}><Clock size={22} strokeWidth={1.5} /></div>
                            <h4>Nothing yet</h4>
                            <p>Messages sent to this contact and their replies will appear here.</p>
                        </div>
                    ) : timeline.map((row, i) => {
                        const meta = ENTRY[row.kind] || ENTRY.note;
                        const Icon = meta.Icon;
                        return (
                            <div className={`feed-item ${row.kind === 'inbound' ? 'reply' : row.status === 'failed' ? 'failed' : 'sent'}`} key={i}>
                                <span className="feed-ico"><Icon size={15} style={{ color: meta.colour }} /></span>
                                <div className="feed-body">
                                    <div className="feed-top">
                                        <span className="feed-who">
                                            {meta.label}
                                            {row.source && <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {row.source}</span>}
                                        </span>
                                        <span className="feed-when">{when(row.at)}</span>
                                    </div>
                                    {row.body && <div className="feed-text">{row.body}</div>}
                                    <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                                        {row.delivery_status && (
                                            <span className="badge badge-delivered"><CheckCircle2 size={11} /> {row.delivery_status}</span>
                                        )}
                                        {row.status === 'failed' && (
                                            <span className="badge badge-failed"><XCircle size={11} /> failed</span>
                                        )}
                                        {row.kind === 'inbound' && row.response && (
                                            <span className="badge badge-pending">{row.response}</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </>
            )}
        </Drawer>
    );
}
