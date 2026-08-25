import { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Search, Plus, Upload, Download, ShieldCheck, Ban, Trash2, Tag as TagIcon,
    ChevronUp, ChevronDown, Users, AlertCircle, X,
} from 'lucide-react';
import Modal from './ui/Modal';
import ContactDrawer from './ContactDrawer';
import { useConfirm } from './ui/ConfirmDialog';

/**
 * Contacts.
 *
 * The previous table had three inert columns, no sorting, no selection, no
 * filters and no pagination — it fetched and rendered every row the account
 * had. Rows did nothing when clicked, because there was no record to open.
 */
export default function ContactsView({ apiUrl, token, onToast }) {
    const [rows, setRows] = useState([]);
    const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0, limit: 25 });
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [debounced, setDebounced] = useState('');
    const [sort, setSort] = useState({ key: 'name', dir: 'asc' });
    const [filter, setFilter] = useState('all');       // all | opted_out | invalid
    const [tagFilter, setTagFilter] = useState('');
    const [selected, setSelected] = useState(new Set());
    const [tags, setTags] = useState([]);
    const [openId, setOpenId] = useState(null);
    const [addOpen, setAddOpen] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [checking, setChecking] = useState(false);
    const confirm = useConfirm();

    const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

    useEffect(() => {
        const t = setTimeout(() => setDebounced(search), 300);
        return () => clearTimeout(t);
    }, [search]);

    const load = useCallback(async (page = pagination.page) => {
        setLoading(true);
        try {
            const q = new URLSearchParams({ page, limit: pagination.limit, sort: sort.key, dir: sort.dir });
            if (debounced) q.set('search', debounced);
            if (filter === 'opted_out') q.set('opted_out', 'true');
            if (filter === 'invalid') q.set('invalid', 'true');
            if (tagFilter) q.set('tag', tagFilter);

            const r = await fetch(`${apiUrl}/contacts?${q}`, { headers: auth });
            if (!r.ok) throw new Error();
            const d = await r.json();
            setRows(d.data || []);
            setPagination(d.pagination);
            setSelected(new Set());
        } catch { onToast('error', 'Could not load contacts'); }
        finally { setLoading(false); }
    }, [apiUrl, auth, debounced, sort, filter, tagFilter, pagination.limit]);

    useEffect(() => { load(1); }, [debounced, sort, filter, tagFilter]); // eslint-disable-line
    useEffect(() => {
        fetch(`${apiUrl}/tags`, { headers: auth }).then((r) => r.json()).then(setTags).catch(() => {});
    }, [apiUrl, auth]);

    const toggleSort = (key) =>
        setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }));

    const allChecked = rows.length > 0 && selected.size === rows.length;
    const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
    const toggleOne = (id) => setSelected((s) => {
        const n = new Set(s);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
    });

    const bulk = async (action, tag_id) => {
        const ids = [...selected];
        if (action === 'delete') {
            const ok = await confirm({
                title: `Delete ${ids.length} contact${ids.length > 1 ? 's' : ''}?`,
                body: 'Their message history is kept, but they are removed from your contact list and any queued messages are cancelled.',
                confirmLabel: 'Delete', danger: true,
            });
            if (!ok) return;
        }
        const r = await fetch(`${apiUrl}/contacts/bulk-action`, {
            method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, action, tag_id }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return onToast('error', d.error || 'Bulk action failed');
        onToast('success', `${d.affected} contact${d.affected === 1 ? '' : 's'} updated.`);
        load();
    };

    const checkNumbers = async () => {
        setChecking(true);
        try {
            const r = await fetch(`${apiUrl}/contacts/validate`, { method: 'POST', headers: auth });
            const d = await r.json();
            if (!r.ok) return onToast('error', d.error || 'Could not check numbers');
            onToast(d.invalid > 0 ? 'warning' : 'success',
                d.invalid > 0
                    ? `Checked ${d.checked} — ${d.invalid} not on WhatsApp.`
                    : `Checked ${d.checked} — all valid.`);
            load();
        } finally { setChecking(false); }
    };

    const exportCsv = () => {
        // The export is an authenticated GET, so it cannot be a plain link.
        fetch(`${apiUrl}/contacts/export`, { headers: auth })
            .then((r) => r.blob())
            .then((b) => {
                const url = URL.createObjectURL(b);
                const a = document.createElement('a');
                a.href = url;
                a.download = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
            })
            .catch(() => onToast('error', 'Export failed'));
    };

    const SortHead = ({ label, k }) => (
        <th>
            <button className="th-sort" onClick={() => toggleSort(k)}
                    aria-label={`Sort by ${label}`}>
                {label}
                {sort.key === k && (sort.dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
            </button>
        </th>
    );

    return (
        <div className="view-container">
            <div className="card" style={{ padding: 0 }}>
                <div className="card-header" style={{ padding: '18px 18px 14px', marginBottom: 0 }}>
                    {/* The page header already reads "Contacts", so this line
                        carries the count and what the current filter is showing
                        rather than repeating the title. */}
                    <div className="card-title-group">
                        <h3 style={{ fontSize: 15 }}>
                            {pagination.total} contact{pagination.total === 1 ? '' : 's'}
                        </h3>
                        {(filter !== 'all' || tagFilter || debounced) && (
                            <span className="card-desc">
                                {[filter === 'opted_out' && 'opted out',
                                  filter === 'invalid' && 'not on WhatsApp',
                                  tagFilter && `tagged ${tagFilter}`,
                                  debounced && `matching "${debounced}"`].filter(Boolean).join(' · ')}
                            </span>
                        )}
                    </div>
                    <div className="page-actions">
                        <div className="search-box" style={{ margin: 0 }}>
                            <Search size={16} />
                            <input value={search} onChange={(e) => setSearch(e.target.value)}
                                   placeholder="Search name or number…" />
                        </div>
                        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }}>
                            <option value="all">All contacts</option>
                            <option value="opted_out">Opted out</option>
                            <option value="invalid">Not on WhatsApp</option>
                        </select>
                        {tags.length > 0 && (
                            <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} style={{ width: 'auto' }}>
                                <option value="">Any tag</option>
                                {tags.map((t) => <option key={t.id} value={t.name}>{t.name} ({t.contact_count})</option>)}
                            </select>
                        )}
                        <button className="btn-outline btn-sm" onClick={checkNumbers} disabled={checking}>
                            <ShieldCheck size={14} /> {checking ? 'Checking…' : 'Check numbers'}
                        </button>
                        <button className="btn-outline btn-sm" onClick={exportCsv}><Download size={14} /> Export</button>
                        <button className="btn-outline btn-sm" onClick={() => setImportOpen(true)}><Upload size={14} /> Import</button>
                        <button className="btn-primary btn-sm" onClick={() => setAddOpen(true)}><Plus size={14} /> Add</button>
                    </div>
                </div>

                {/* Bulk bar appears only with a selection, so it never competes
                    with the toolbar for attention. */}
                {selected.size > 0 && (
                    <div className="bulk-bar">
                        <span><b>{selected.size}</b> selected</span>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {tags.length > 0 && (
                                <select onChange={(e) => e.target.value && bulk('tag', e.target.value)} defaultValue=""
                                        style={{ width: 'auto' }} aria-label="Add tag to selected">
                                    <option value="">Add tag…</option>
                                    {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                            )}
                            <button className="btn-outline btn-sm" onClick={() => bulk('opt_out')}><Ban size={13} /> Opt out</button>
                            <button className="btn-outline btn-sm" onClick={() => bulk('opt_in')}>Opt in</button>
                            <button className="btn-outline btn-sm" onClick={() => bulk('delete')}
                                    style={{ color: 'var(--danger)', borderColor: 'var(--danger-border)' }}>
                                <Trash2 size={13} /> Delete
                            </button>
                            <button className="icon-btn" onClick={() => setSelected(new Set())} aria-label="Clear selection">
                                <X size={16} />
                            </button>
                        </div>
                    </div>
                )}

                <div className="tablewrap" style={{ border: 0, borderRadius: 0 }}>
                    <table className="logs-table">
                        <thead>
                            <tr>
                                <th style={{ width: 38 }}>
                                    <input type="checkbox" checked={allChecked} onChange={toggleAll}
                                           aria-label="Select all on this page" />
                                </th>
                                <SortHead label="Name" k="name" />
                                <SortHead label="Phone" k="phone" />
                                <th>Tags</th>
                                <SortHead label="Last contacted" k="last_contacted" />
                                <th style={{ width: 110 }}>Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</td></tr>
                            ) : rows.length === 0 ? (
                                <tr><td colSpan={6}>
                                    <div className="empty-state">
                                        <div className="empty-art"><Users size={28} strokeWidth={1.5} /></div>
                                        <h4>{debounced || tagFilter || filter !== 'all' ? 'Nothing matches' : 'No contacts yet'}</h4>
                                        <p>{debounced || tagFilter || filter !== 'all'
                                            ? 'Try a different search or filter.'
                                            : 'Import your patient list, or add someone to get started.'}</p>
                                        {!debounced && filter === 'all' && !tagFilter && (
                                            <button className="btn-primary btn-sm" onClick={() => setImportOpen(true)}>
                                                <Upload size={14} /> Import contacts
                                            </button>
                                        )}
                                    </div>
                                </td></tr>
                            ) : rows.map((c) => (
                                <tr key={c.id} onClick={() => setOpenId(c.id)} style={{ cursor: 'pointer' }}>
                                    <td onClick={(e) => e.stopPropagation()}>
                                        <input type="checkbox" checked={selected.has(c.id)}
                                               onChange={() => toggleOne(c.id)}
                                               aria-label={`Select ${c.name || c.phone}`} />
                                    </td>
                                    <td className="log-contact">{c.name || <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                                    <td>+{c.phone}</td>
                                    <td>
                                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                            {(c.tags || []).map((t) => (
                                                <span key={t.id} className="tag-chip"
                                                      style={{ background: t.colour, borderColor: t.colour, color: '#fff' }}>
                                                    {t.name}
                                                </span>
                                            ))}
                                        </div>
                                    </td>
                                    <td className="log-time">
                                        {c.last_contacted_at ? new Date(c.last_contacted_at).toLocaleDateString() : '—'}
                                    </td>
                                    <td>
                                        {c.opted_out && <span className="badge badge-failed"><Ban size={11} /> Opted out</span>}
                                        {!c.opted_out && c.wa_valid === false && (
                                            <span className="badge badge-pending"><AlertCircle size={11} /> Not on WA</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {pagination.totalPages > 1 && (
                    <div className="pagination">
                        <button className="btn-outline btn-sm" disabled={pagination.page <= 1}
                                onClick={() => load(pagination.page - 1)}>Previous</button>
                        <span className="page-info">Page {pagination.page} of {pagination.totalPages}</span>
                        <button className="btn-outline btn-sm" disabled={pagination.page >= pagination.totalPages}
                                onClick={() => load(pagination.page + 1)}>Next</button>
                    </div>
                )}
            </div>

            <ContactDrawer
                open={!!openId} contactId={openId} apiUrl={apiUrl} token={token}
                onClose={() => setOpenId(null)} onChanged={() => load()} onToast={onToast}
            />
            <AddContactModal open={addOpen} onClose={() => setAddOpen(false)}
                             apiUrl={apiUrl} auth={auth} onToast={onToast} onDone={() => load()} />
            <ImportModal open={importOpen} onClose={() => setImportOpen(false)}
                         apiUrl={apiUrl} auth={auth} onToast={onToast} onDone={() => load()} />
        </div>
    );
}

/* ── add ────────────────────────────────────────────────────────────────── */
function AddContactModal({ open, onClose, apiUrl, auth, onToast, onDone }) {
    const [form, setForm] = useState({ name: '', phone: '', email: '' });
    const [busy, setBusy] = useState(false);

    useEffect(() => { if (open) setForm({ name: '', phone: '', email: '' }); }, [open]);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/contacts`, {
                method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return onToast('error', d.error || 'Could not add contact');
            onToast('success', 'Contact added.');
            onDone(); onClose();
        } finally { setBusy(false); }
    };

    return (
        <Modal open={open} onClose={onClose} title="Add contact" size="sm"
            footer={<>
                <button className="btn-outline" onClick={onClose}>Cancel</button>
                <button className="btn-primary" onClick={submit} disabled={busy || !form.phone.trim()}>
                    {busy ? 'Adding…' : 'Add contact'}
                </button>
            </>}>
            <form onSubmit={submit}>
                <div className="form-group">
                    <label htmlFor="ac-name">Name</label>
                    <input id="ac-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                           placeholder="Priya Sharma" />
                </div>
                <div className="form-group">
                    <label htmlFor="ac-phone">Phone (with country code)</label>
                    <input id="ac-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                           placeholder="919876543210" />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                    <label htmlFor="ac-email">Email</label>
                    <input id="ac-email" type="email" value={form.email}
                           onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
            </form>
        </Modal>
    );
}

/* ── import ─────────────────────────────────────────────────────────────── */
function ImportModal({ open, onClose, apiUrl, auth, onToast, onDone }) {
    const [text, setText] = useState('');
    const [preview, setPreview] = useState([]);
    const [report, setReport] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => { if (open) { setText(''); setPreview([]); setReport(null); } }, [open]);

    // Parse as you type so the mapping is visible before anything is sent —
    // the old importer gave no preview and assumed "name,phone" ordering.
    useEffect(() => {
        const rows = text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
            const parts = line.split(/[,\t;]/).map((p) => p.trim());
            const phoneAt = parts.findIndex((p) => p.replace(/\D/g, '').length >= 8);
            return {
                name: parts.filter((_, i) => i !== phoneAt)[0] || '',
                phone: phoneAt >= 0 ? parts[phoneAt] : (parts[1] || ''),
            };
        });
        setPreview(rows.slice(0, 200));
    }, [text]);

    const run = async () => {
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/contacts/import`, {
                method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ rows: preview }),
            });
            const d = await r.json();
            setReport(d);
            if (r.ok) { onToast('success', `${d.added} added, ${d.updated} updated.`); onDone(); }
        } finally { setBusy(false); }
    };

    const onFile = (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => setText(String(reader.result || ''));
        reader.readAsText(f);
    };

    return (
        <Modal open={open} onClose={onClose} title="Import contacts"
            description="Paste rows or choose a CSV. Name and number are detected per line."
            footer={<>
                <button className="btn-outline" onClick={onClose}>{report ? 'Done' : 'Cancel'}</button>
                {!report && (
                    <button className="btn-primary" onClick={run} disabled={busy || !preview.length}>
                        {busy ? 'Importing…' : `Import ${preview.length} row${preview.length === 1 ? '' : 's'}`}
                    </button>
                )}
            </>}>
            {report ? (
                <>
                    <div className="alert-box success" style={{ marginBottom: 12 }}>
                        <span><b>{report.added}</b> added · <b>{report.updated}</b> updated · <b>{report.skipped}</b> skipped</span>
                    </div>
                    {report.invalid?.length > 0 && (
                        <>
                            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>Rows that could not be imported</p>
                            <div className="tablewrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
                                <table className="logs-table">
                                    <thead><tr><th>Line</th><th>Value</th><th>Reason</th></tr></thead>
                                    <tbody>
                                        {report.invalid.map((iv, i) => (
                                            <tr key={i}><td>{iv.line}</td><td>{iv.phone || '—'}</td><td>{iv.reason}</td></tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </>
            ) : (
                <>
                    <div className="form-group">
                        <label htmlFor="imp-file">CSV file</label>
                        <input id="imp-file" type="file" accept=".csv,.txt" onChange={onFile} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="imp-text">Or paste rows</label>
                        <textarea id="imp-text" rows={6} value={text} onChange={(e) => setText(e.target.value)}
                                  placeholder={'Priya Sharma, 919876543210\nRahul Desai, 919812345678'}
                                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }} />
                    </div>
                    {preview.length > 0 && (
                        <>
                            <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 6px' }}>
                                Detected {preview.length} row{preview.length === 1 ? '' : 's'} — first few:
                            </p>
                            <div className="tablewrap" style={{ maxHeight: 160, overflowY: 'auto' }}>
                                <table className="logs-table">
                                    <thead><tr><th>Name</th><th>Phone</th></tr></thead>
                                    <tbody>
                                        {preview.slice(0, 5).map((p, i) => (
                                            <tr key={i}>
                                                <td>{p.name || <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                                                <td>{p.phone}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    )}
                </>
            )}
        </Modal>
    );
}
