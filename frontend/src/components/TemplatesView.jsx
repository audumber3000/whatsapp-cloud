import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Pencil, Trash2, FileText, Search, AlertTriangle } from 'lucide-react';
import Modal from './ui/Modal';
import { useConfirm } from './ui/ConfirmDialog';

/**
 * Templates — message wording, named once.
 *
 * The preview is a real WhatsApp bubble rather than a text box, because the
 * question a clinic is actually asking is "what will the patient see" — and it
 * renders against a real contact, so an unresolved `{{clinic}}` is visible
 * here instead of going out in 300 messages.
 */

const CATEGORY = {
    utility:   { label: 'Utility',   hint: 'Reminders, confirmations, account updates' },
    service:   { label: 'Service',   hint: 'Replies to something the patient asked' },
    marketing: { label: 'Marketing', hint: 'Offers and campaigns — needs opt-in' },
};

export default function TemplatesView({ apiUrl, token, onToast }) {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [editing, setEditing] = useState(null);
    const confirm = useConfirm();

    const auth = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await fetch(`${apiUrl}/templates`, { headers: auth });
            setRows(await r.json());
        } catch { onToast('error', 'Could not load templates'); }
        finally { setLoading(false); }
    }, [apiUrl, auth, onToast]);

    useEffect(() => { load(); }, [load]);

    const remove = async (t) => {
        const ok = await confirm({
            title: `Delete "${t.name}"?`,
            body: 'Broadcasts that already used it keep their own copy of the wording, so their reports stay intact.',
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        const r = await fetch(`${apiUrl}/templates/${t.id}`, { method: 'DELETE', headers: auth });
        if (!r.ok) {
            const d = await r.json().catch(() => ({}));
            return onToast('error', d.error || 'Could not delete that template');
        }
        onToast('success', 'Template deleted.');
        load();
    };

    const shown = rows.filter((t) =>
        !search || t.name.toLowerCase().includes(search.toLowerCase()) ||
        t.body.toLowerCase().includes(search.toLowerCase()));

    return (
        <div className="view-container">
            <div className="card" style={{ padding: 0 }}>
                <div className="card-header" style={{ padding: '13px 14px 11px', marginBottom: 0 }}>
                    <div className="card-title-group">
                        <h3 style={{ fontSize: 15 }}>{rows.length} template{rows.length === 1 ? '' : 's'}</h3>
                        <span className="card-desc">Reused by automations, broadcasts and the inbox.</span>
                    </div>
                    <div className="page-actions">
                        <div className="search-box" style={{ margin: 0 }}>
                            <Search size={16} />
                            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates…" />
                        </div>
                        <button className="btn-primary btn-sm" onClick={() => setEditing({ category: 'utility', buttons: [] })}>
                            <Plus size={14} /> New template
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="empty-state"><p>Loading…</p></div>
                ) : shown.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-art"><FileText size={26} strokeWidth={1.5} /></div>
                        <h4>{search ? 'Nothing matches' : 'No templates yet'}</h4>
                        <p>{search ? 'Try a different search.'
                            : 'Write your reminder once here and every automation and broadcast can use it.'}</p>
                        {!search && (
                            <button className="btn-primary btn-sm" onClick={() => setEditing({ category: 'utility', buttons: [] })}>
                                <Plus size={14} /> New template
                            </button>
                        )}
                    </div>
                ) : (
                    <div className="template-grid">
                        {shown.map((t) => (
                            <article className="template-card" key={t.id}>
                                <header>
                                    <div style={{ minWidth: 0 }}>
                                        <h4>{t.name}</h4>
                                        <span className="badge badge-prose"
                                              style={{ background: 'var(--surface-sunken)', borderColor: 'var(--border)',
                                                       color: 'var(--text-muted)' }}>
                                            {CATEGORY[t.category]?.label || t.category}
                                        </span>
                                    </div>
                                    <div style={{ display: 'flex', gap: 4, flex: 'none' }}>
                                        <button className="icon-btn" title="Edit" onClick={() => setEditing(t)}>
                                            <Pencil size={15} />
                                        </button>
                                        <button className="icon-btn" title="Delete" onClick={() => remove(t)}
                                                style={{ color: 'var(--danger)' }}>
                                            <Trash2 size={15} />
                                        </button>
                                    </div>
                                </header>

                                <div className="template-preview">
                                    <div className="bubble out" style={{ maxWidth: '100%', alignSelf: 'stretch' }}>
                                        <div className="bubble-body">{t.body}</div>
                                        {t.footer && <div className="template-footer">{t.footer}</div>}
                                    </div>
                                    {t.buttons?.length > 0 && (
                                        <div className="template-buttons">
                                            {t.buttons.map((b) => <span key={b.id}>{b.text}</span>)}
                                        </div>
                                    )}
                                </div>

                                <footer>
                                    {t.variables.length > 0
                                        ? t.variables.map((v) => <code key={v}>{`{{${v}}}`}</code>)
                                        : <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>No variables</span>}
                                </footer>
                            </article>
                        ))}
                    </div>
                )}
            </div>

            <TemplateEditor
                open={!!editing} template={editing} apiUrl={apiUrl} auth={auth}
                onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onToast={onToast}
            />
        </div>
    );
}

/* ── editor ─────────────────────────────────────────────────────────────── */
function TemplateEditor({ open, template, apiUrl, auth, onClose, onSaved, onToast }) {
    const [form, setForm] = useState({ name: '', category: 'utility', body: '', footer: '', buttons: [] });
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setForm({
            name: template?.name || '', category: template?.category || 'utility',
            body: template?.body || '', footer: template?.footer || '',
            buttons: template?.buttons || [],
        });
    }, [open, template]);

    // Rendered server-side against a real contact, so the preview cannot drift
    // from what the sender will actually produce.
    useEffect(() => {
        if (!open || !form.body.trim()) { setPreview(null); return; }
        const t = setTimeout(() => {
            fetch(`${apiUrl}/templates/preview`, {
                method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: form.body }),
            }).then((r) => r.json()).then(setPreview).catch(() => {});
        }, 350);
        return () => clearTimeout(t);
    }, [open, form.body, apiUrl, auth]);

    const save = async () => {
        setBusy(true);
        try {
            const editingExisting = template?.id;
            const r = await fetch(`${apiUrl}/templates${editingExisting ? `/${template.id}` : ''}`, {
                method: editingExisting ? 'PUT' : 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify(form),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return onToast('error', d.error || 'Could not save that template');
            onToast('success', editingExisting ? 'Template updated.' : 'Template created.');
            onSaved();
        } finally { setBusy(false); }
    };

    const setButton = (i, text) => setForm((f) => {
        const buttons = [...f.buttons];
        if (!text) buttons.splice(i, 1);
        else buttons[i] = { id: buttons[i]?.id || `btn_${i + 1}`, text };
        return { ...f, buttons };
    });

    return (
        <Modal open={open} onClose={onClose} size="lg"
            title={template?.id ? 'Edit template' : 'New template'}
            description="Use {{name}}, {{first_name}} or any custom field. Anything unknown stays visible rather than sending blank."
            footer={<>
                <button className="btn-outline" onClick={onClose}>Cancel</button>
                <button className="btn-primary" onClick={save} disabled={busy || !form.name.trim() || !form.body.trim()}>
                    {busy ? 'Saving…' : template?.id ? 'Save changes' : 'Create template'}
                </button>
            </>}>
            <div className="template-editor">
                <div>
                    <div className="form-group">
                        <label htmlFor="tpl-name">Name</label>
                        <input id="tpl-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                               placeholder="Appointment reminder" />
                    </div>
                    <div className="form-group">
                        <label htmlFor="tpl-cat">Category</label>
                        <select id="tpl-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                            {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                        <small>{CATEGORY[form.category]?.hint}</small>
                    </div>
                    <div className="form-group">
                        <label htmlFor="tpl-body">Message</label>
                        <textarea id="tpl-body" rows={7} value={form.body}
                                  onChange={(e) => setForm({ ...form, body: e.target.value })}
                                  placeholder="Hi {{first_name}}, this is a reminder for your appointment on {{date}}." />
                        <small>{form.body.length} / 4096</small>
                    </div>
                    <div className="form-group">
                        <label htmlFor="tpl-footer">Footer <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>optional</span></label>
                        <input id="tpl-footer" value={form.footer || ''} onChange={(e) => setForm({ ...form, footer: e.target.value })}
                               placeholder="Smile Dental · Reply STOP to opt out" />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Tappable replies <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>up to 3</span></label>
                        <div style={{ display: 'grid', gap: 6 }}>
                            {[0, 1, 2].map((i) => (
                                <input key={i} value={form.buttons[i]?.text || ''} maxLength={20}
                                       onChange={(e) => setButton(i, e.target.value)}
                                       placeholder={['Confirm', 'Reschedule', 'Cancel'][i]} />
                            ))}
                        </div>
                        <small>A reply comes back as a tap, so the answer is structured instead of guessed from free text.</small>
                    </div>
                </div>

                <div className="template-preview-pane">
                    <span className="preview-label">
                        Preview{preview?.sample?.name ? ` — as ${preview.sample.name} would see it` : ''}
                    </span>
                    <div className="preview-ground">
                        <div className="bubble out" style={{ maxWidth: '100%' }}>
                            <div className="bubble-body">
                                {preview?.rendered || form.body || 'Your message will appear here.'}
                            </div>
                            {form.footer && <div className="template-footer">{form.footer}</div>}
                            <span className="bubble-meta">
                                {new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                            </span>
                        </div>
                        {form.buttons.filter((b) => b?.text).length > 0 && (
                            <div className="template-buttons">
                                {form.buttons.filter((b) => b?.text).map((b, i) => <span key={i}>{b.text}</span>)}
                            </div>
                        )}
                    </div>

                    {preview?.unresolved?.length > 0 && (
                        <div className="alert-box warning" style={{ marginTop: 10 }}>
                            <AlertTriangle size={15} style={{ flex: 'none', marginTop: 1 }} />
                            <span>
                                <b>{preview.unresolved.map((v) => `{{${v}}}`).join(', ')}</b> will not fill in from a
                                contact. Supply a value when you send, or the placeholder goes out as written.
                            </span>
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}
