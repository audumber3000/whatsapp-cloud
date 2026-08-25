import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Plus, Megaphone, Users, Clock, CheckCircle2, XCircle, Ban, Send,
    AlertTriangle, Trash2, Search,
} from 'lucide-react';
import Modal from './ui/Modal';
import Drawer from './ui/Drawer';
import { useConfirm } from './ui/ConfirmDialog';
import useEvent from '../hooks/useEvent';

/**
 * Broadcasts.
 *
 * The point of this screen over the old "paste a list of numbers into an
 * automation" flow is that the audience is a filter you can see the size of
 * before you commit, and that afterwards there is a row per recipient — so
 * "43 failures" is a list of names, not a number.
 */

const STATUS = {
    draft:     { label: 'Draft',     cls: '' },
    scheduled: { label: 'Scheduled', cls: 'badge-pending' },
    sending:   { label: 'Sending',   cls: 'badge-sent' },
    sent:      { label: 'Sent',      cls: 'badge-delivered' },
    cancelled: { label: 'Stopped',   cls: 'badge-cancelled' },
    failed:    { label: 'Failed',    cls: 'badge-failed' },
};

const SKIP_REASON = {
    opted_out: 'Opted out',
    not_on_whatsapp: 'Not on WhatsApp',
    no_number: 'No number',
};

const when = (iso) => iso ? new Date(iso).toLocaleString([], {
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
}) : '—';

export default function BroadcastsView({ apiUrl, token, onToast: rawToast }) {
    // Stable identity: a parent passing an inline arrow must not make
    // every fetch callback re-fire. See hooks/useEvent.js.
    const onToast = useEvent(rawToast);
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [composing, setComposing] = useState(false);
    const [reportId, setReportId] = useState(null);
    const confirm = useConfirm();

    const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

    const load = useCallback(async () => {
        try {
            const r = await fetch(`${apiUrl}/broadcasts`, { headers: auth });
            setRows(await r.json());
        } catch { onToast('error', 'Could not load broadcasts'); }
        finally { setLoading(false); }
    }, [apiUrl, auth, onToast]);

    useEffect(() => { load(); }, [load]);
    // A run paces itself over minutes, so the list refreshes while one is live.
    useEffect(() => {
        if (!rows.some((b) => b.status === 'sending')) return;
        const t = setInterval(load, 5000);
        return () => clearInterval(t);
    }, [rows, load]);

    const act = async (b, action, label) => {
        if (action === 'cancel') {
            const ok = await confirm({
                title: `Stop "${b.name}"?`,
                body: b.status === 'sending'
                    ? 'Messages already sent cannot be recalled. Everyone not yet reached will be left untouched.'
                    : 'It will not go out at the scheduled time.',
                confirmLabel: 'Stop it', danger: true,
            });
            if (!ok) return;
        }
        if (action === 'delete') {
            const ok = await confirm({
                title: `Delete "${b.name}"?`, body: 'The delivery report goes with it.',
                confirmLabel: 'Delete', danger: true,
            });
            if (!ok) return;
        }
        const r = await fetch(`${apiUrl}/broadcasts/${b.id}${action === 'delete' ? '' : `/${action}`}`, {
            method: action === 'delete' ? 'DELETE' : 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return onToast('error', d.error || 'That did not work');
        onToast('success', label);
        load();
    };

    return (
        <div className="view-container">
            <div className="card" style={{ padding: 0 }}>
                <div className="card-header" style={{ padding: '13px 14px 11px', marginBottom: 0 }}>
                    <div className="card-title-group">
                        <h3 style={{ fontSize: 15 }}>{rows.length} broadcast{rows.length === 1 ? '' : 's'}</h3>
                        <span className="card-desc">One message to a segment, paced so the number stays healthy.</span>
                    </div>
                    <div className="page-actions">
                        <button className="btn-primary btn-sm" onClick={() => setComposing(true)}>
                            <Plus size={14} /> New broadcast
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="empty-state"><p>Loading…</p></div>
                ) : rows.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-art"><Megaphone size={26} strokeWidth={1.5} /></div>
                        <h4>No broadcasts yet</h4>
                        <p>Pick a template, choose who it goes to, and see exactly how many
                           people that is before anything sends.</p>
                        <button className="btn-primary btn-sm" onClick={() => setComposing(true)}>
                            <Plus size={14} /> New broadcast
                        </button>
                    </div>
                ) : (
                    <div className="tablewrap" style={{ border: 0, borderRadius: 0 }}>
                        <table className="logs-table table-stack">
                            <thead>
                                <tr>
                                    <th>Broadcast</th>
                                    <th style={{ width: 110 }}>Status</th>
                                    <th style={{ width: 200 }}>Delivery</th>
                                    <th style={{ width: 150 }}>When</th>
                                    <th style={{ width: 120 }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((b) => {
                                    const done = b.sent_count + b.failed_count + b.skipped_count;
                                    const pct = b.total_count ? Math.round((done / b.total_count) * 100) : 0;
                                    const meta = STATUS[b.status] || { label: b.status, cls: '' };
                                    return (
                                        <tr key={b.id} onClick={() => setReportId(b.id)} style={{ cursor: 'pointer' }}>
                                            <td className="stack-title">
                                                <div style={{ fontWeight: 600 }}>{b.name}</div>
                                                <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 400 }}>
                                                    {b.template_name || 'Custom message'}
                                                </div>
                                            </td>
                                            <td data-label="Status">
                                                <span className={`badge ${meta.cls} badge-prose`}>{meta.label}</span>
                                            </td>
                                            <td data-label="Delivery">
                                                {b.total_count > 0 ? (
                                                    <>
                                                        <div className="bcast-bar" title={`${done} of ${b.total_count}`}>
                                                            <span className="ok" style={{ width: `${(b.sent_count / b.total_count) * 100}%` }} />
                                                            <span className="bad" style={{ width: `${(b.failed_count / b.total_count) * 100}%` }} />
                                                            <span className="skip" style={{ width: `${(b.skipped_count / b.total_count) * 100}%` }} />
                                                        </div>
                                                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3 }}>
                                                            {b.sent_count} sent
                                                            {b.failed_count > 0 && <> · <b style={{ color: 'var(--danger)' }}>{b.failed_count} failed</b></>}
                                                            {b.skipped_count > 0 && <> · {b.skipped_count} skipped</>}
                                                            {b.status === 'sending' && <> · {pct}%</>}
                                                        </div>
                                                    </>
                                                ) : <span style={{ color: 'var(--text-faint)' }}>Not sent yet</span>}
                                            </td>
                                            <td data-label="When" className="log-time">
                                                {when(b.finished_at || b.scheduled_at || b.created_at)}
                                            </td>
                                            <td onClick={(e) => e.stopPropagation()}>
                                                <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                                                    {['draft'].includes(b.status) && (
                                                        <button className="btn-primary btn-sm" onClick={() => act(b, 'send', 'Broadcast started.')}>
                                                            <Send size={13} /> Send
                                                        </button>
                                                    )}
                                                    {['scheduled', 'sending'].includes(b.status) && (
                                                        <button className="btn-outline btn-sm" onClick={() => act(b, 'cancel', 'Broadcast stopped.')}
                                                                style={{ color: 'var(--danger)', borderColor: 'var(--danger-border)' }}>
                                                            <Ban size={13} /> Stop
                                                        </button>
                                                    )}
                                                    {b.status === 'failed' && (
                                                        <button className="btn-outline btn-sm" onClick={() => act(b, 'send', 'Retrying.')}>
                                                            Retry
                                                        </button>
                                                    )}
                                                    {['draft', 'cancelled', 'failed'].includes(b.status) && (
                                                        <button className="icon-btn" title="Delete"
                                                                onClick={() => act(b, 'delete', 'Broadcast deleted.')}
                                                                style={{ color: 'var(--danger)' }}>
                                                            <Trash2 size={15} />
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            <Composer open={composing} apiUrl={apiUrl} auth={auth} onToast={onToast}
                      onClose={() => setComposing(false)}
                      onDone={() => { setComposing(false); load(); }} />
            <ReportDrawer id={reportId} apiUrl={apiUrl} auth={auth} onClose={() => setReportId(null)} />
        </div>
    );
}

/* ── composer ───────────────────────────────────────────────────────────── */
function Composer({ open, apiUrl, auth, onClose, onDone, onToast }) {
    const [templates, setTemplates] = useState([]);
    const [segments, setSegments] = useState([]);
    const [tags, setTags] = useState([]);
    const [form, setForm] = useState({ name: '', template_id: '', body: '', segment_id: '', schedule: 'now', at: '' });
    const [filter, setFilter] = useState({});
    const [audience, setAudience] = useState(null);
    const [vars, setVars] = useState({});
    const [busy, setBusy] = useState(false);

    const jsonHeaders = useMemo(() => ({ ...auth, 'Content-Type': 'application/json' }), [auth]);

    useEffect(() => {
        if (!open) return;
        setForm({ name: '', template_id: '', body: '', segment_id: '', schedule: 'now', at: '' });
        setFilter({}); setVars({});
        Promise.all([
            fetch(`${apiUrl}/templates`, { headers: auth }).then((r) => r.json()).catch(() => []),
            fetch(`${apiUrl}/broadcasts/segments/all`, { headers: auth }).then((r) => r.json()).catch(() => []),
            fetch(`${apiUrl}/tags`, { headers: auth }).then((r) => r.json()).catch(() => []),
        ]).then(([t, s, g]) => { setTemplates(t); setSegments(s); setTags(g); });
    }, [open, apiUrl, auth]);

    // The audience count is recomputed on every change, so the number beside
    // "Send" is always the number of people who will actually be messaged.
    useEffect(() => {
        if (!open) return;
        const t = setTimeout(() => {
            fetch(`${apiUrl}/broadcasts/audience`, {
                method: 'POST', headers: jsonHeaders,
                body: JSON.stringify(form.segment_id ? { segment_id: form.segment_id } : { audience: filter }),
            }).then((r) => r.json()).then(setAudience).catch(() => {});
        }, 250);
        return () => clearTimeout(t);
    }, [open, filter, form.segment_id, apiUrl, jsonHeaders]);

    const chosen = templates.find((t) => t.id === form.template_id);
    const body = form.body || chosen?.body || '';
    const needed = (chosen?.variables || []).filter((v) => !['name', 'first_name', 'phone', 'email'].includes(v));

    const submit = async (sendNow) => {
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/broadcasts`, {
                method: 'POST', headers: jsonHeaders,
                body: JSON.stringify({
                    name: form.name, template_id: form.template_id || null,
                    body: form.body || undefined,
                    segment_id: form.segment_id || null,
                    audience: form.segment_id ? {} : filter,
                    variables: vars,
                }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return onToast('error', d.error || 'Could not create that broadcast');

            if (sendNow) {
                const s = await fetch(`${apiUrl}/broadcasts/${d.id}/send`, {
                    method: 'POST', headers: jsonHeaders,
                    body: JSON.stringify(form.schedule === 'later' && form.at
                        ? { scheduled_at: new Date(form.at).toISOString() } : {}),
                });
                const sd = await s.json().catch(() => ({}));
                if (!s.ok) { onToast('error', sd.error || 'Saved as a draft, but could not start it'); onDone(); return; }
                onToast('success', form.schedule === 'later'
                    ? `Scheduled for ${sd.total} recipient${sd.total === 1 ? '' : 's'}.`
                    : `Sending to ${sd.total} recipient${sd.total === 1 ? '' : 's'}.`);
            } else {
                onToast('success', 'Saved as a draft.');
            }
            onDone();
        } finally { setBusy(false); }
    };

    const ready = form.name.trim() && body.trim() && audience?.total > 0;

    return (
        <Modal open={open} onClose={onClose} size="lg" title="New broadcast"
            description="Pick the message, then who gets it. Nothing sends until you say so."
            footer={<>
                <button className="btn-outline" onClick={onClose}>Cancel</button>
                <button className="btn-outline" onClick={() => submit(false)} disabled={busy || !form.name.trim() || !body.trim()}>
                    Save draft
                </button>
                <button className="btn-primary" onClick={() => submit(true)} disabled={busy || !ready}>
                    {busy ? 'Working…'
                        : form.schedule === 'later' ? 'Schedule'
                        : `Send to ${audience?.total ?? 0}`}
                </button>
            </>}>
            <div className="form-group">
                <label htmlFor="bc-name">Name <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>internal only</span></label>
                <input id="bc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                       placeholder="Monsoon checkup drive" />
            </div>

            <div className="form-group">
                <label htmlFor="bc-tpl">Message</label>
                <select id="bc-tpl" value={form.template_id}
                        onChange={(e) => setForm({ ...form, template_id: e.target.value, body: '' })}>
                    <option value="">Write a one-off message…</option>
                    {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
            </div>

            {!form.template_id && (
                <div className="form-group">
                    <textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
                              placeholder="Hi {{first_name}}, …" aria-label="Message" />
                </div>
            )}

            {body && (
                <div className="preview-ground" style={{ marginBottom: 14 }}>
                    <div className="bubble out" style={{ maxWidth: '100%' }}>
                        <div className="bubble-body">{body}</div>
                    </div>
                </div>
            )}

            {needed.length > 0 && (
                <div className="form-group">
                    <label>Fill in the rest</label>
                    <div style={{ display: 'grid', gap: 6 }}>
                        {needed.map((v) => (
                            <input key={v} value={vars[v] || ''} placeholder={`{{${v}}}`}
                                   onChange={(e) => setVars({ ...vars, [v]: e.target.value })} />
                        ))}
                    </div>
                    <small>{'{{name}}'} and {'{{first_name}}'} come from each contact — these do not.</small>
                </div>
            )}

            <div className="form-group">
                <label htmlFor="bc-seg">Who gets it</label>
                <select id="bc-seg" value={form.segment_id}
                        onChange={(e) => setForm({ ...form, segment_id: e.target.value })}>
                    <option value="">Build a filter…</option>
                    {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
            </div>

            {!form.segment_id && (
                <div className="form-group" style={{ display: 'grid', gap: 8 }}>
                    <select value={filter.tag || ''} onChange={(e) => setFilter({ ...filter, tag: e.target.value || undefined })}>
                        <option value="">Everyone</option>
                        {tags.map((t) => <option key={t.id} value={t.name}>Tagged “{t.name}” ({t.contact_count})</option>)}
                    </select>
                    <label className="toggle-row">
                        <input type="checkbox" checked={!!filter.has_replied}
                               onChange={(e) => setFilter({ ...filter, has_replied: e.target.checked || undefined })} />
                        <span>
                            <strong>Only people who have replied before</strong>
                            <small>They have messaged you at least once, so the 24-hour window has opened.</small>
                        </span>
                    </label>
                    <label className="toggle-row">
                        <input type="checkbox" checked={!!filter.never_contacted}
                               onChange={(e) => setFilter({ ...filter, never_contacted: e.target.checked || undefined })} />
                        <span>
                            <strong>Only people never messaged</strong>
                            <small>Useful for a first announcement without repeating yourself.</small>
                        </span>
                    </label>
                </div>
            )}

            <div className={`alert-box ${audience?.total ? 'info' : 'warning'}`} style={{ marginBottom: 14 }}>
                <Users size={15} style={{ flex: 'none', marginTop: 1 }} />
                <span>
                    {audience === null ? 'Working out the audience…' : audience.total === 0 ? (
                        <>This reaches <b>nobody</b>. Widen the filter, or check that these contacts are not all opted out.</>
                    ) : (
                        <>
                            Reaches <b>{audience.total}</b> {audience.total === 1 ? 'person' : 'people'}
                            {audience.sample?.length > 0 && <> — {audience.sample.map((c) => c.name || `+${c.phone}`).join(', ')}
                                {audience.total > audience.sample.length && ` and ${audience.total - audience.sample.length} more`}</>}.
                            {(audience.excluded?.opted_out > 0 || audience.excluded?.not_on_whatsapp > 0) && (
                                <div style={{ marginTop: 4, fontSize: 12.5 }}>
                                    Excluded automatically: {audience.excluded.opted_out} opted out
                                    {audience.excluded.not_on_whatsapp > 0 && `, ${audience.excluded.not_on_whatsapp} not on WhatsApp`}.
                                </div>
                            )}
                        </>
                    )}
                </span>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="bc-when">When</label>
                <select id="bc-when" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })}>
                    <option value="now">Send now</option>
                    <option value="later">Schedule for later</option>
                </select>
                {form.schedule === 'later' && (
                    <input type="datetime-local" style={{ marginTop: 8 }} value={form.at}
                           onChange={(e) => setForm({ ...form, at: e.target.value })} />
                )}
                <small>Messages go out with a few seconds between them — a burst of identical
                       messages from one number is what gets that number flagged.</small>
            </div>
        </Modal>
    );
}

/* ── delivery report ────────────────────────────────────────────────────── */
function ReportDrawer({ id, apiUrl, auth, onClose }) {
    const [data, setData] = useState(null);
    const [tab, setTab] = useState('all');
    const [q, setQ] = useState('');

    useEffect(() => {
        if (!id) { setData(null); return; }
        setTab('all'); setQ('');
        fetch(`${apiUrl}/broadcasts/${id}`, { headers: auth }).then((r) => r.json()).then(setData).catch(() => {});
    }, [id, apiUrl, auth]);

    const b = data?.broadcast;
    const all = data?.recipients || [];
    const shown = all
        .filter((r) => tab === 'all' || r.status === tab)
        .filter((r) => !q || (r.name || '').toLowerCase().includes(q.toLowerCase()) || r.phone.includes(q));

    const counts = {
        all: all.length,
        sent: all.filter((r) => r.status === 'sent').length,
        failed: all.filter((r) => r.status === 'failed').length,
        skipped: all.filter((r) => r.status === 'skipped').length,
        pending: all.filter((r) => r.status === 'pending').length,
    };

    return (
        <Drawer open={!!id} onClose={onClose} width={640}
                title={b?.name || 'Broadcast'}
                subtitle={b ? `${STATUS[b.status]?.label || b.status} · ${b.template_name || 'Custom message'}` : ''}>
            {!b ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p> : (
                <>
                    <div className="preview-ground" style={{ marginBottom: 14 }}>
                        <div className="bubble out" style={{ maxWidth: '100%' }}>
                            <div className="bubble-body">{b.body}</div>
                        </div>
                    </div>

                    <div className="stats-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 14 }}>
                        <div className="stat-box">
                            <span className="stat-title">Sent</span>
                            <span className="stat-value" style={{ fontSize: 24, color: 'var(--success)' }}>{b.sent_count}</span>
                        </div>
                        <div className="stat-box">
                            <span className="stat-title">Failed</span>
                            <span className="stat-value" style={{ fontSize: 24, color: b.failed_count ? 'var(--danger)' : undefined }}>
                                {b.failed_count}
                            </span>
                        </div>
                        <div className="stat-box">
                            <span className="stat-title">Skipped</span>
                            <span className="stat-value" style={{ fontSize: 24 }}>{b.skipped_count}</span>
                        </div>
                    </div>

                    <div className="inbox-filters" style={{ padding: '0 0 10px' }}>
                        {['all', 'failed', 'skipped', 'sent', 'pending'].map((k) => (
                            counts[k] > 0 || k === 'all' ? (
                                <button key={k} className={`inbox-chip${tab === k ? ' active' : ''}`} onClick={() => setTab(k)}>
                                    {k === 'all' ? 'Everyone' : k[0].toUpperCase() + k.slice(1)}
                                    <span className="n">{counts[k]}</span>
                                </button>
                            ) : null
                        ))}
                    </div>

                    {all.length > 8 && (
                        <div className="search-box" style={{ margin: '0 0 10px' }}>
                            <Search size={15} />
                            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a recipient…" />
                        </div>
                    )}

                    <div className="tablewrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                        <table className="logs-table">
                            <thead><tr><th>Recipient</th><th style={{ width: 100 }}>Result</th><th>Why</th></tr></thead>
                            <tbody>
                                {shown.length === 0 ? (
                                    <tr><td colSpan={3} style={{ padding: 22, textAlign: 'center', color: 'var(--text-faint)' }}>
                                        Nothing here.
                                    </td></tr>
                                ) : shown.map((r, i) => (
                                    <tr key={i}>
                                        <td>
                                            <div style={{ fontWeight: 500 }}>{r.name || '—'}</div>
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>+{r.phone}</div>
                                        </td>
                                        <td>
                                            <span className={`badge badge-prose ${
                                                r.status === 'sent' ? 'badge-delivered'
                                                : r.status === 'failed' ? 'badge-failed'
                                                : r.status === 'skipped' ? 'badge-cancelled' : 'badge-pending'}`}>
                                                {r.status === 'skipped' ? 'Skipped'
                                                    : r.status === 'sent' ? (r.delivery_status === 'read' ? 'Read' : 'Sent')
                                                    : r.status[0].toUpperCase() + r.status.slice(1)}
                                            </span>
                                        </td>
                                        <td style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                                            {SKIP_REASON[r.skip_reason] || r.error_reason ||
                                             (r.status === 'pending' ? 'Not reached yet' : '')}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {b.failed_count > 0 && (
                        <div className="alert-box warning" style={{ marginTop: 12 }}>
                            <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                            <span>{b.failed_count} could not be delivered. The usual cause is a number
                                  that is not on WhatsApp — run <b>Check numbers</b> on Contacts to find them.</span>
                        </div>
                    )}
                </>
            )}
        </Drawer>
    );
}
