import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Building2, Users, MessageCircle, Bell, KeyRound, ScrollText, CreditCard,
    Tag as TagIcon, Plus, Trash2, Copy, Check, AlertTriangle, Mail, Clock,
    ShieldCheck, X,
} from 'lucide-react';
import Modal from './ui/Modal';
import { useConfirm } from './ui/ConfirmDialog';
import Avatar from './ui/Avatar';

/**
 * Settings.
 *
 * This replaces three inline tabs — a notification email, a phone number, and
 * an API key — with the surface a CRM actually needs. The sections are the
 * ones a clinic asks for by name, in the order they ask.
 *
 * Everything that mutates is manager-only server-side; the UI mirrors that by
 * disabling rather than hiding, so an agent can see what exists and who to ask.
 */

const SECTIONS = [
    { key: 'workspace', label: 'Workspace', Icon: Building2 },
    { key: 'members', label: 'Members', Icon: Users },
    { key: 'whatsapp', label: 'WhatsApp', Icon: MessageCircle },
    { key: 'notifications', label: 'Notifications', Icon: Bell },
    { key: 'tags', label: 'Tags & labels', Icon: TagIcon },
    { key: 'api', label: 'API keys', Icon: KeyRound },
    { key: 'audit', label: 'Audit log', Icon: ScrollText },
    { key: 'billing', label: 'Plan & usage', Icon: CreditCard },
];

const DAYS = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
              ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];

const EVENT_LABEL = {
    daily_summary: ['Daily summary', 'What went out and how people replied, once a day.'],
    start_alert: ['Automation started', 'When a scheduled run begins sending.'],
    send_failure: ['Send failures', 'When messages fail — usually a number that is not on WhatsApp.'],
    new_reply: ['New reply', 'When a patient writes in.'],
    disconnected: ['WhatsApp disconnected', 'The number unlinked. Nothing sends until it is re-linked.'],
};

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];

const when = (iso) => iso ? new Date(iso).toLocaleString([], {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
}) : '—';

export default function SettingsView({ apiUrl, token, onToast, role }) {
    const [section, setSection] = useState('workspace');
    const canManage = role === 'owner' || role === 'manager';

    const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
    const jsonHeaders = useMemo(() => ({ ...auth, 'Content-Type': 'application/json' }), [auth]);

    const props = { apiUrl, auth, jsonHeaders, onToast, canManage, role };

    return (
        <div className="view-container">
            <div className="settings-shell">
                <nav className="settings-nav" aria-label="Settings sections">
                    {SECTIONS.map((s) => (
                        <button key={s.key} className={section === s.key ? 'active' : ''}
                                onClick={() => setSection(s.key)}
                                aria-current={section === s.key ? 'page' : undefined}>
                            <s.Icon size={16} /> <span>{s.label}</span>
                        </button>
                    ))}
                </nav>

                <div className="settings-body">
                    {!canManage && (
                        <div className="alert-box info" style={{ marginBottom: 14 }}>
                            <ShieldCheck size={15} style={{ flex: 'none', marginTop: 1 }} />
                            <span>You are an agent here, so these are read-only. Ask an owner or
                                  manager to change them.</span>
                        </div>
                    )}
                    {section === 'workspace' && <Workspace {...props} />}
                    {section === 'members' && <Members {...props} />}
                    {section === 'whatsapp' && <WhatsAppSection {...props} />}
                    {section === 'notifications' && <Notifications {...props} />}
                    {section === 'tags' && <TagsAndLabels {...props} />}
                    {section === 'api' && <ApiKeys {...props} />}
                    {section === 'audit' && <AuditLog {...props} />}
                    {section === 'billing' && <Billing {...props} />}
                </div>
            </div>
        </div>
    );
}

function Section({ title, sub, children, footer }) {
    return (
        <section className="settings-card">
            <header>
                <h3>{title}</h3>
                {sub && <p>{sub}</p>}
            </header>
            <div className="settings-card-body">{children}</div>
            {footer && <footer>{footer}</footer>}
        </section>
    );
}

/* ── workspace ──────────────────────────────────────────────────────────── */
function Workspace({ apiUrl, auth, jsonHeaders, onToast, canManage }) {
    const [form, setForm] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        fetch(`${apiUrl}/settings/workspace`, { headers: auth })
            .then((r) => r.json()).then((d) => setForm({ ...d, business_hours: d.business_hours || {} }))
            .catch(() => onToast('error', 'Could not load the workspace'));
    }, [apiUrl, auth, onToast]);

    if (!form) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

    const setDay = (d, patch) => setForm((f) => ({
        ...f,
        business_hours: { ...f.business_hours, [d]: patch === null ? null : { ...(f.business_hours[d] || { open: '09:30', close: '18:00' }), ...patch } },
    }));

    const save = async () => {
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/settings/workspace`, {
                method: 'PUT', headers: jsonHeaders, body: JSON.stringify(form),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return onToast('error', d.error || 'Could not save');
            setForm({ ...d, business_hours: d.business_hours || {} });
            onToast('success', 'Workspace saved.');
        } finally { setBusy(false); }
    };

    return (
        <>
            <Section title="Workspace" sub="How this clinic appears across the product."
                footer={canManage && (
                    <button className="btn-primary" onClick={save} disabled={busy || !form.name?.trim()}>
                        {busy ? 'Saving…' : 'Save changes'}
                    </button>
                )}>
                <div className="settings-grid">
                    <div className="form-group">
                        <label htmlFor="ws-name">Name</label>
                        <input id="ws-name" value={form.name || ''} disabled={!canManage}
                               onChange={(e) => setForm({ ...form, name: e.target.value })} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="ws-tz">Timezone</label>
                        <select id="ws-tz" value={form.timezone || 'Asia/Kolkata'} disabled={!canManage}
                                onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                            {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
                        </select>
                        <small>Automations and business hours are read in this zone.</small>
                    </div>
                </div>
            </Section>

            <Section title="Business hours"
                     sub="Used by the away message, so a patient writing at 11pm is not left wondering.">
                <div className="hours-grid">
                    {DAYS.map(([d, label]) => {
                        const v = form.business_hours[d];
                        return (
                            <div className="hours-row" key={d}>
                                <label className="toggle-row" style={{ padding: '6px 8px', border: 0, background: 'none' }}>
                                    <input type="checkbox" checked={!!v} disabled={!canManage}
                                           onChange={(e) => setDay(d, e.target.checked ? {} : null)} />
                                    <span><strong style={{ fontWeight: 600 }}>{label}</strong></span>
                                </label>
                                {v ? (
                                    <div className="hours-times">
                                        <input type="time" value={v.open} disabled={!canManage}
                                               onChange={(e) => setDay(d, { open: e.target.value })}
                                               aria-label={`${label} opening time`} />
                                        <span>to</span>
                                        <input type="time" value={v.close} disabled={!canManage}
                                               onChange={(e) => setDay(d, { close: e.target.value })}
                                               aria-label={`${label} closing time`} />
                                    </div>
                                ) : <span className="hours-closed">Closed</span>}
                            </div>
                        );
                    })}
                </div>
            </Section>

            <Section title="Away message"
                     sub="Sent once per conversation per day when someone writes outside these hours.">
                <label className="toggle-row" style={{ marginBottom: 10 }}>
                    <input type="checkbox" checked={!!form.away_enabled} disabled={!canManage}
                           onChange={(e) => setForm({ ...form, away_enabled: e.target.checked })} />
                    <span>
                        <strong>Reply automatically outside business hours</strong>
                        <small>Once per conversation per day, so three messages do not get three replies.</small>
                    </span>
                </label>
                <textarea rows={3} value={form.away_message || ''} disabled={!canManage || !form.away_enabled}
                          onChange={(e) => setForm({ ...form, away_message: e.target.value })}
                          placeholder="Thanks for writing! We are closed right now and will reply when we open at 9:30am."
                          aria-label="Away message" />
            </Section>
        </>
    );
}

/* ── members ────────────────────────────────────────────────────────────── */
function Members({ apiUrl, auth, jsonHeaders, onToast, canManage, role }) {
    const [data, setData] = useState(null);
    const [inviting, setInviting] = useState(false);
    const confirm = useConfirm();

    const load = useCallback(() => {
        fetch(`${apiUrl}/settings/members`, { headers: auth })
            .then((r) => r.json()).then(setData).catch(() => onToast('error', 'Could not load the team'));
    }, [apiUrl, auth, onToast]);

    useEffect(() => { load(); }, [load]);
    if (!data) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

    const changeRole = async (m, newRole) => {
        if (newRole === 'owner') {
            const ok = await confirm({
                title: `Make ${m.full_name || m.username} the owner?`,
                body: 'You become a manager. Only the owner can hand ownership on, so this is not something you can undo yourself.',
                confirmLabel: 'Hand over ownership', danger: true,
            });
            if (!ok) return;
        }
        const r = await fetch(`${apiUrl}/settings/members/${m.id}`, {
            method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ role: newRole }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return onToast('error', d.error || 'Could not change that role');
        onToast('success', `${m.full_name || m.username} is now ${newRole === 'agent' ? 'an' : 'a'} ${newRole}. They will need to sign in again.`);
        load();
    };

    const remove = async (m) => {
        const ok = await confirm({
            title: `Remove ${m.full_name || m.username}?`,
            body: 'They lose access immediately and any conversations assigned to them go back to the unassigned queue.',
            confirmLabel: 'Remove', danger: true,
        });
        if (!ok) return;
        const r = await fetch(`${apiUrl}/settings/members/${m.id}`, { method: 'DELETE', headers: auth });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return onToast('error', d.error || 'Could not remove them');
        onToast('success', 'Removed.');
        load();
    };

    const revoke = async (inv) => {
        const r = await fetch(`${apiUrl}/settings/invitations/${inv.id}`, { method: 'DELETE', headers: auth });
        if (!r.ok) return onToast('error', 'Could not revoke that invitation');
        onToast('success', 'Invitation revoked.');
        load();
    };

    return (
        <>
            <Section title={`${data.members.length} member${data.members.length === 1 ? '' : 's'}`}
                sub="An agent works the inbox. A manager also configures the workspace. The owner can hand over ownership."
                footer={canManage && (
                    <button className="btn-primary" onClick={() => setInviting(true)}>
                        <Plus size={15} /> Invite someone
                    </button>
                )}>
                <div className="member-list">
                    {data.members.map((m) => (
                        <div className="member-row" key={m.id}>
                            <Avatar name={m.full_name || m.username} size={36} />
                            <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontWeight: 600, fontSize: 14 }}>
                                    {m.full_name || m.username}
                                    {m.id === data.me && <span className="you-chip">you</span>}
                                </div>
                                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                    {m.email || m.username}
                                    {m.last_login_at && ` · last seen ${when(m.last_login_at)}`}
                                </div>
                            </div>
                            {canManage && m.role !== 'owner' ? (
                                <select value={m.role} onChange={(e) => changeRole(m, e.target.value)}
                                        style={{ width: 'auto' }} aria-label={`Role for ${m.username}`}>
                                    <option value="agent">Agent</option>
                                    <option value="manager">Manager</option>
                                    {role === 'owner' && <option value="owner">Owner</option>}
                                </select>
                            ) : (
                                <span className="badge badge-prose"
                                      style={{ background: 'var(--surface-sunken)', borderColor: 'var(--border)',
                                               color: 'var(--text-muted)' }}>
                                    {m.role}
                                </span>
                            )}
                            {canManage && m.role !== 'owner' && m.id !== data.me && (
                                <button className="icon-btn" onClick={() => remove(m)} title="Remove"
                                        style={{ color: 'var(--danger)' }}>
                                    <Trash2 size={15} />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </Section>

            {data.invitations.length > 0 && (
                <Section title="Pending invitations" sub="These expire seven days after they were sent.">
                    <div className="member-list">
                        {data.invitations.map((i) => (
                            <div className="member-row" key={i.id}>
                                <span className="avatar" style={{ width: 36, height: 36, background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}>
                                    <Mail size={16} />
                                </span>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontWeight: 600, fontSize: 14 }}>{i.email}</div>
                                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                        Invited as {i.role} · expires {when(i.expires_at)}
                                    </div>
                                </div>
                                {canManage && (
                                    <button className="btn-outline btn-sm" onClick={() => revoke(i)}>
                                        <X size={13} /> Revoke
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            <InviteModal open={inviting} onClose={() => setInviting(false)} apiUrl={apiUrl}
                         jsonHeaders={jsonHeaders} onToast={onToast} onDone={() => { setInviting(false); load(); }} />
        </>
    );
}

function InviteModal({ open, onClose, apiUrl, jsonHeaders, onToast, onDone }) {
    const [form, setForm] = useState({ email: '', role: 'agent' });
    const [busy, setBusy] = useState(false);
    const [link, setLink] = useState(null);

    useEffect(() => { if (open) { setForm({ email: '', role: 'agent' }); setLink(null); } }, [open]);

    const send = async () => {
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/settings/invitations`, {
                method: 'POST', headers: jsonHeaders, body: JSON.stringify(form),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return onToast('error', d.error || 'Could not send that invitation');
            if (d.delivered) { onToast('success', `Invitation sent to ${form.email}.`); onDone(); }
            // The invitation is real even if the email did not go — hand over
            // the link rather than leaving them stuck.
            else setLink(d.link);
        } finally { setBusy(false); }
    };

    return (
        <Modal open={open} onClose={onClose} size="sm" title="Invite someone"
            description="They join this workspace, not a new one. The link expires in seven days."
            footer={link ? <button className="btn-primary" onClick={onDone}>Done</button> : <>
                <button className="btn-outline" onClick={onClose}>Cancel</button>
                <button className="btn-primary" onClick={send} disabled={busy || !form.email.trim()}>
                    {busy ? 'Sending…' : 'Send invitation'}
                </button>
            </>}>
            {link ? (
                <>
                    <div className="alert-box warning" style={{ marginBottom: 12 }}>
                        <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                        <span>The invitation exists, but the email could not be sent. Pass this
                              link on yourself — it works the same way.</span>
                    </div>
                    <CopyField value={link} onToast={onToast} />
                </>
            ) : (
                <>
                    <div className="form-group">
                        <label htmlFor="inv-email">Email</label>
                        <input id="inv-email" type="email" value={form.email}
                               onChange={(e) => setForm({ ...form, email: e.target.value })}
                               placeholder="colleague@clinic.com" />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                        <label htmlFor="inv-role">Role</label>
                        <select id="inv-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                            <option value="agent">Agent — works the inbox</option>
                            <option value="manager">Manager — also configures the workspace</option>
                        </select>
                    </div>
                </>
            )}
        </Modal>
    );
}

/* ── WhatsApp ───────────────────────────────────────────────────────────── */
function WhatsAppSection({ apiUrl, auth, onToast }) {
    const [d, setD] = useState(null);
    useEffect(() => {
        fetch(`${apiUrl}/settings/whatsapp`, { headers: auth })
            .then((r) => r.json()).then(setD).catch(() => onToast('error', 'Could not load the connection'));
    }, [apiUrl, auth, onToast]);
    if (!d) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

    return (
        <>
            <Section title="Connected number" sub="Everything this workspace sends goes out from here.">
                <div className={`conn-panel${d.connected ? ' ok' : ''}`}>
                    <span className={`conn-dot${d.connected ? ' on' : ''}`} />
                    <div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>
                            {d.connected ? `+${d.phone || 'connected'}` : 'Not connected'}
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                            {d.connected
                                ? `Last send ${when(d.lastSendAt)}`
                                : 'Nothing will send until the number is linked again.'}
                        </div>
                    </div>
                </div>
                {!d.connected && (
                    <div className="alert-box warning" style={{ marginTop: 12 }}>
                        <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                        <span>Open the Dashboard to scan the QR code and re-link. Queued
                              messages stay queued until then rather than being lost.</span>
                    </div>
                )}
            </Section>

            <Section title="Connection history" sub="Every drop and recovery, so a bad week is visible.">
                {d.alerts.length === 0 ? (
                    <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>Nothing recorded yet.</p>
                ) : (
                    <div className="tablewrap">
                        <table className="logs-table">
                            <thead><tr><th>Event</th><th>Detail</th><th style={{ width: 150 }}>When</th></tr></thead>
                            <tbody>
                                {d.alerts.map((a, i) => (
                                    <tr key={i}>
                                        <td><span className="badge badge-prose badge-pending">{a.kind}</span></td>
                                        <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{a.detail || '—'}</td>
                                        <td className="log-time">{when(a.created_at)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </Section>
        </>
    );
}

/* ── notifications ──────────────────────────────────────────────────────── */
function Notifications({ apiUrl, auth, jsonHeaders, onToast, canManage }) {
    const [d, setD] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        fetch(`${apiUrl}/settings/notifications`, { headers: auth })
            .then((r) => r.json()).then(setD).catch(() => onToast('error', 'Could not load notifications'));
    }, [apiUrl, auth, onToast]);
    if (!d) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

    const toggle = (event, channel) => setD((s) => ({
        ...s, events: { ...s.events, [event]: { ...s.events[event], [channel]: !s.events[event][channel] } },
    }));

    const save = async () => {
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/settings/notifications`, {
                method: 'PUT', headers: jsonHeaders, body: JSON.stringify(d),
            });
            if (!r.ok) return onToast('error', 'Could not save');
            onToast('success', 'Notification settings saved.');
        } finally { setBusy(false); }
    };

    return (
        <Section title="Notifications" sub="Where alerts go, and which ones you actually want."
            footer={canManage && (
                <button className="btn-primary" onClick={save} disabled={busy}>
                    {busy ? 'Saving…' : 'Save changes'}
                </button>
            )}>
            <div className="settings-grid">
                <div className="form-group">
                    <label htmlFor="nt-email">Email addresses</label>
                    <input id="nt-email" value={d.emails} disabled={!canManage}
                           onChange={(e) => setD({ ...d, emails: e.target.value })}
                           placeholder="reception@clinic.com, owner@clinic.com" />
                    <small>Comma-separated.</small>
                </div>
                <div className="form-group">
                    <label htmlFor="nt-wa">WhatsApp numbers</label>
                    <input id="nt-wa" value={d.whatsapp} disabled={!canManage}
                           onChange={(e) => setD({ ...d, whatsapp: e.target.value })}
                           placeholder="919876543210" />
                    <small>With country code, comma-separated.</small>
                </div>
            </div>

            <div className="tablewrap" style={{ marginTop: 6 }}>
                <table className="logs-table">
                    <thead>
                        <tr><th>Event</th><th style={{ width: 90 }}>Email</th><th style={{ width: 110 }}>WhatsApp</th></tr>
                    </thead>
                    <tbody>
                        {d.available.map((e) => (
                            <tr key={e}>
                                <td>
                                    <div style={{ fontWeight: 600 }}>{EVENT_LABEL[e]?.[0] || e}</div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{EVENT_LABEL[e]?.[1]}</div>
                                </td>
                                <td><input type="checkbox" disabled={!canManage}
                                           checked={!!d.events[e]?.email} onChange={() => toggle(e, 'email')}
                                           aria-label={`Email me about ${EVENT_LABEL[e]?.[0] || e}`} /></td>
                                <td><input type="checkbox" disabled={!canManage}
                                           checked={!!d.events[e]?.whatsapp} onChange={() => toggle(e, 'whatsapp')}
                                           aria-label={`WhatsApp me about ${EVENT_LABEL[e]?.[0] || e}`} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Section>
    );
}

/* ── tags & labels ──────────────────────────────────────────────────────── */
function TagsAndLabels({ apiUrl, auth, jsonHeaders, onToast, canManage }) {
    const [tags, setTags] = useState([]);
    const [labels, setLabels] = useState([]);
    const [adding, setAdding] = useState({ tag: '', label: '' });
    const confirm = useConfirm();

    const load = useCallback(() => {
        Promise.all([
            fetch(`${apiUrl}/tags`, { headers: auth }).then((r) => r.json()).catch(() => []),
            fetch(`${apiUrl}/labels`, { headers: auth }).then((r) => r.json()).catch(() => []),
        ]).then(([t, l]) => { setTags(Array.isArray(t) ? t : []); setLabels(Array.isArray(l) ? l : []); });
    }, [apiUrl, auth]);

    useEffect(() => { load(); }, [load]);

    const add = async (kind) => {
        const name = adding[kind].trim();
        if (!name) return;
        const r = await fetch(`${apiUrl}/${kind === 'tag' ? 'tags' : 'labels'}`, {
            method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return onToast('error', d.error || 'Could not add that');
        setAdding({ ...adding, [kind]: '' });
        load();
    };

    const remove = async (kind, item) => {
        const ok = await confirm({
            title: `Delete "${item.name}"?`,
            body: kind === 'tag'
                ? 'It is removed from every contact that has it. The contacts themselves are untouched.'
                : 'It is removed from every conversation that has it.',
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        const r = await fetch(`${apiUrl}/${kind === 'tag' ? 'tags' : 'labels'}/${item.id}`, {
            method: 'DELETE', headers: auth,
        });
        if (!r.ok) return onToast('error', 'Could not delete that');
        load();
    };

    const List = ({ kind, items, countKey, empty }) => (
        <>
            <div className="chip-rows">
                {items.length === 0 ? <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>{empty}</p>
                    : items.map((t) => (
                        <div className="chip-row" key={t.id}>
                            <span className="tag-chip" style={{ background: t.colour, borderColor: t.colour, color: '#fff' }}>
                                {t.name}
                            </span>
                            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                {t[countKey] || 0} {kind === 'tag' ? 'contacts' : 'conversations'}
                            </span>
                            {canManage && (
                                <button className="icon-btn" onClick={() => remove(kind, t)} title="Delete"
                                        style={{ color: 'var(--danger)', marginLeft: 'auto' }}>
                                    <Trash2 size={14} />
                                </button>
                            )}
                        </div>
                    ))}
            </div>
            {canManage && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <input value={adding[kind]} onChange={(e) => setAdding({ ...adding, [kind]: e.target.value })}
                           onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(kind); } }}
                           placeholder={kind === 'tag' ? 'e.g. Implant patient' : 'e.g. Needs callback'}
                           aria-label={`New ${kind}`} />
                    <button className="btn-outline" onClick={() => add(kind)}><Plus size={15} /> Add</button>
                </div>
            )}
        </>
    );

    return (
        <>
            <Section title="Contact tags" sub="Describe the person — used to target broadcasts and filter contacts.">
                <List kind="tag" items={tags} countKey="contact_count" empty="No tags yet." />
            </Section>
            <Section title="Conversation labels" sub="Describe this exchange — used in the inbox.">
                <List kind="label" items={labels} countKey="use_count" empty="No labels yet." />
            </Section>
        </>
    );
}

/* ── API keys ───────────────────────────────────────────────────────────── */
function CopyField({ value, onToast }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="apikey-box">
            <code>{value}</code>
            <button className="btn-outline btn-sm" onClick={() => {
                navigator.clipboard?.writeText(value)
                    .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); })
                    .catch(() => onToast?.('error', 'Could not copy — select it manually'));
            }}>
                {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
            </button>
        </div>
    );
}

function ApiKeys({ apiUrl, auth, jsonHeaders, onToast, canManage }) {
    const [keys, setKeys] = useState([]);
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [fresh, setFresh] = useState(null);
    const confirm = useConfirm();

    const load = useCallback(() => {
        fetch(`${apiUrl}/settings/api-keys`, { headers: auth })
            .then((r) => r.json()).then((d) => setKeys(Array.isArray(d) ? d : [])).catch(() => {});
    }, [apiUrl, auth]);
    useEffect(() => { load(); }, [load]);

    const create = async () => {
        const r = await fetch(`${apiUrl}/settings/api-keys`, {
            method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return onToast('error', d.error || 'Could not create that key');
        setFresh(d.api_key); setCreating(false); setName(''); load();
    };

    const revoke = async (k) => {
        const ok = await confirm({
            title: `Revoke "${k.name}"?`,
            body: 'Anything using this key stops working immediately. This cannot be undone — issue a new key instead.',
            confirmLabel: 'Revoke', danger: true,
        });
        if (!ok) return;
        const r = await fetch(`${apiUrl}/settings/api-keys/${k.id}`, { method: 'DELETE', headers: auth });
        if (!r.ok) return onToast('error', 'Could not revoke that key');
        onToast('success', 'Key revoked.');
        load();
    };

    const live = keys.filter((k) => !k.revoked_at);

    return (
        <>
            <Section title="API keys"
                sub="Other products send through this number with a key. Each one is named and revoked on its own."
                footer={canManage && (
                    <button className="btn-primary" onClick={() => setCreating(true)}>
                        <Plus size={15} /> New key
                    </button>
                )}>
                {keys.length === 0 ? (
                    <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>No keys yet.</p>
                ) : (
                    <div className="tablewrap">
                        <table className="logs-table">
                            <thead>
                                <tr><th>Name</th><th style={{ width: 130 }}>Key</th>
                                    <th style={{ width: 150 }}>Last used</th><th style={{ width: 100 }}></th></tr>
                            </thead>
                            <tbody>
                                {keys.map((k) => (
                                    <tr key={k.id} style={k.revoked_at ? { opacity: .55 } : undefined}>
                                        <td>
                                            <div style={{ fontWeight: 600 }}>{k.name}</div>
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                                Created {when(k.created_at)}
                                                {k.created_by_name && ` by ${k.created_by_name}`}
                                            </div>
                                        </td>
                                        <td><code style={{ fontSize: 12 }}>{k.key_prefix}…</code></td>
                                        <td className="log-time">
                                            {k.revoked_at
                                                ? <span className="badge badge-prose badge-cancelled">Revoked</span>
                                                : k.last_used_at ? when(k.last_used_at)
                                                : <span style={{ color: 'var(--text-faint)' }}>Never</span>}
                                        </td>
                                        <td style={{ textAlign: 'right' }}>
                                            {canManage && !k.revoked_at && (
                                                <button className="btn-outline btn-sm" onClick={() => revoke(k)}
                                                        style={{ color: 'var(--danger)', borderColor: 'var(--danger-border)' }}>
                                                    Revoke
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {live.length === 0 && keys.length > 0 && (
                    <div className="alert-box warning" style={{ marginTop: 12 }}>
                        <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                        <span>Every key is revoked, so nothing can send through the API right now.</span>
                    </div>
                )}
            </Section>

            <Section title="Sending from another product"
                     sub="One POST. The key identifies the workspace, so no number is passed.">
                <pre className="code-block"><code>{`curl -X POST ${window.location.origin}/api/v1/messages \\
  -H "Authorization: Bearer wr_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"919876543210","body":"Your report is ready."}'`}</code></pre>
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
                    Opted-out contacts are refused with a 403, and the endpoint is rate limited
                    to 60 requests a minute per key.
                </p>
            </Section>

            <Modal open={creating} onClose={() => setCreating(false)} size="sm" title="New API key"
                description="Name it after what will use it, so revoking the right one later is obvious."
                footer={<>
                    <button className="btn-outline" onClick={() => setCreating(false)}>Cancel</button>
                    <button className="btn-primary" onClick={create} disabled={!name.trim()}>Create key</button>
                </>}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                    <label htmlFor="key-name">Name</label>
                    <input id="key-name" value={name} onChange={(e) => setName(e.target.value)}
                           placeholder="MolarPlus production" />
                </div>
            </Modal>

            <Modal open={!!fresh} onClose={() => setFresh(null)} size="md" title="Copy this key now"
                description="This is the only time it is shown. Only a hash is stored, so it genuinely cannot be recovered."
                footer={<button className="btn-primary" onClick={() => setFresh(null)}>I have saved it</button>}>
                <CopyField value={fresh || ''} onToast={onToast} />
            </Modal>
        </>
    );
}

/* ── audit log ──────────────────────────────────────────────────────────── */
function AuditLog({ apiUrl, auth, canManage }) {
    const [d, setD] = useState(null);
    const [page, setPage] = useState(1);

    useEffect(() => {
        if (!canManage) return;
        fetch(`${apiUrl}/settings/audit?page=${page}&limit=25`, { headers: auth })
            .then((r) => r.json()).then(setD).catch(() => {});
    }, [apiUrl, auth, page, canManage]);

    if (!canManage) {
        return <Section title="Audit log" sub="Only owners and managers can read this." >
            <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>You do not have access.</p>
        </Section>;
    }
    if (!d) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

    return (
        <Section title="Audit log" sub="Every change to the workspace, its team and its keys.">
            {d.data.length === 0 ? (
                <p style={{ color: 'var(--text-faint)', fontSize: 13 }}>Nothing recorded yet.</p>
            ) : (
                <>
                    <div className="tablewrap">
                        <table className="logs-table">
                            <thead>
                                <tr><th style={{ width: 150 }}>When</th><th style={{ width: 130 }}>Who</th>
                                    <th>What</th><th style={{ width: 120 }}>From</th></tr>
                            </thead>
                            <tbody>
                                {d.data.map((a) => (
                                    <tr key={a.id}>
                                        <td className="log-time">{when(a.created_at)}</td>
                                        <td style={{ fontWeight: 500 }}>{a.actor}</td>
                                        <td>
                                            <div style={{ fontWeight: 500 }}>{a.action.replace(/[._]/g, ' ')}</div>
                                            {a.after && (
                                                <div style={{ fontSize: 12, color: 'var(--text-muted)',
                                                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                                              maxWidth: 380 }}>
                                                    {Object.entries(a.after).slice(0, 3)
                                                        .map(([k, v]) => `${k}: ${typeof v === 'object' ? '…' : v}`).join(' · ')}
                                                </div>
                                            )}
                                        </td>
                                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{a.ip || '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {d.pagination.totalPages > 1 && (
                        <div className="pagination">
                            <button className="btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                            <span className="page-info">Page {page} of {d.pagination.totalPages}</span>
                            <button className="btn-outline btn-sm" disabled={page >= d.pagination.totalPages}
                                    onClick={() => setPage(page + 1)}>Next</button>
                        </div>
                    )}
                </>
            )}
        </Section>
    );
}

/* ── billing ────────────────────────────────────────────────────────────── */
function Billing({ apiUrl, auth }) {
    const [d, setD] = useState(null);
    useEffect(() => {
        fetch(`${apiUrl}/settings/billing`, { headers: auth })
            .then((r) => r.json()).then(setD).catch(() => {});
    }, [apiUrl, auth]);
    if (!d) return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;

    return (
        <Section title="Plan & usage" sub={`On the ${d.plan} plan since ${when(d.since)}.`}>
            <div className="stats-row" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 0 }}>
                <div className="stat-box">
                    <span className="stat-title">Messages this month</span>
                    <span className="stat-value">{(d.usage.sends_this_month || 0).toLocaleString()}</span>
                </div>
                <div className="stat-box">
                    <span className="stat-title">Contacts</span>
                    <span className="stat-value">{(d.usage.contacts || 0).toLocaleString()}</span>
                </div>
                <div className="stat-box">
                    <span className="stat-title">Team members</span>
                    <span className="stat-value">{d.usage.members || 0}</span>
                </div>
                <div className="stat-box">
                    <span className="stat-title">Automations</span>
                    <span className="stat-value">{d.usage.automations || 0}</span>
                </div>
            </div>
            <div className="alert-box info" style={{ marginTop: 14 }}>
                <Clock size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>Billing is not switched on yet, so nothing here is enforced or charged.
                      These are the numbers a plan would be based on.</span>
            </div>
        </Section>
    );
}
