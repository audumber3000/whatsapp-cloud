import { useState, useEffect, useCallback } from 'react';
import { User, KeyRound, Monitor, Check, Trash2, Shield } from 'lucide-react';
import Avatar from './ui/Avatar';
import { useConfirm } from './ui/ConfirmDialog';

/**
 * The profile screen, which did not exist in any form.
 *
 * There was no way to see who you were signed in as, change your password, or
 * find out where else your account was logged in — and no way to end those
 * sessions, because logout only deleted a token locally while it stayed valid.
 */
export default function ProfileView({ apiUrl, token, onToast, onProfileSaved }) {
    const [me, setMe] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [saving, setSaving] = useState(false);
    const [pw, setPw] = useState({ current_password: '', new_password: '', confirm: '' });
    const [pwBusy, setPwBusy] = useState(false);
    const [pwError, setPwError] = useState('');
    const confirm = useConfirm();

    const auth = { Authorization: `Bearer ${token}` };

    const load = useCallback(async () => {
        const [m, s] = await Promise.all([
            fetch(`${apiUrl}/account/me`, { headers: auth }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetch(`${apiUrl}/account/sessions`, { headers: auth }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
        ]);
        if (m) setMe(m);
        setSessions(Array.isArray(s) ? s : []);
    }, [apiUrl, token]);

    useEffect(() => { load(); }, [load]);

    const saveProfile = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            const r = await fetch(`${apiUrl}/account/me`, {
                method: 'PATCH',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    full_name: me.user.full_name,
                    email: me.user.email,
                    timezone: me.user.timezone,
                }),
            });
            const d = await r.json();
            if (!r.ok) return onToast('error', d.error || 'Could not save');
            onToast('success', d.email_verification_required
                ? 'Saved. Your new email needs verifying.'
                : 'Profile saved.');
            onProfileSaved?.();
            load();
        } finally { setSaving(false); }
    };

    const changePassword = async (e) => {
        e.preventDefault();
        setPwError('');
        if (pw.new_password !== pw.confirm) return setPwError('The new passwords do not match.');
        setPwBusy(true);
        try {
            const r = await fetch(`${apiUrl}/account/password`, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ current_password: pw.current_password, new_password: pw.new_password }),
            });
            const d = await r.json();
            if (!r.ok) return setPwError(d.error || 'Could not change password');
            // Every other session was just revoked, so this one is next.
            onToast('success', d.message || 'Password updated.');
            setPw({ current_password: '', new_password: '', confirm: '' });
            setTimeout(() => { localStorage.removeItem('wa_token'); window.location.reload(); }, 1600);
        } finally { setPwBusy(false); }
    };

    const revoke = async (id) => {
        const ok = await confirm({
            title: 'Sign out this device?',
            body: 'That device will need to sign in again.',
            confirmLabel: 'Sign it out',
            danger: true,
        });
        if (!ok) return;
        const r = await fetch(`${apiUrl}/account/sessions/${id}`, { method: 'DELETE', headers: auth });
        if (r.ok) { onToast('success', 'Device signed out.'); load(); }
        else onToast('error', 'Could not sign that device out.');
    };

    if (!me) return <div className="card"><p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading…</p></div>;

    const name = me.user.full_name || me.user.username;

    return (
        <div className="view-container" style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

            <div className="card">
                <div className="card-header">
                    <div className="card-title-group">
                        <h3><User size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />Your profile</h3>
                        <span className="card-desc">How you appear inside {me.org?.name}.</span>
                    </div>
                    <span className="badge badge-delivered"><Shield size={12} /> {me.org?.role}</span>
                </div>

                <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
                    <Avatar name={name} src={me.user.avatar_url} size={56} />
                    <div>
                        <div style={{ fontSize: 16, fontWeight: 700 }}>{name}</div>
                        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                            @{me.user.username} · joined {new Date(me.user.created_at).toLocaleDateString()}
                        </div>
                    </div>
                </div>

                <form onSubmit={saveProfile}>
                    <div className="form-group">
                        <label htmlFor="pf-name">Full name</label>
                        <input id="pf-name" type="text" value={me.user.full_name || ''}
                               onChange={(e) => setMe({ ...me, user: { ...me.user, full_name: e.target.value } })}
                               placeholder="Dr Priya Sharma" />
                    </div>
                    <div className="form-group">
                        <label htmlFor="pf-email">Email</label>
                        <input id="pf-email" type="email" value={me.user.email || ''}
                               onChange={(e) => setMe({ ...me, user: { ...me.user, email: e.target.value } })}
                               placeholder="you@clinic.com" />
                        <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                            {me.user.email_verified_at
                                ? <><Check size={12} style={{ verticalAlign: '-2px' }} /> Verified</>
                                : 'Used for password resets and alerts. Changing it requires re-verification.'}
                        </p>
                    </div>
                    <div className="form-group">
                        <label htmlFor="pf-tz">Timezone</label>
                        <input id="pf-tz" type="text" value={me.user.timezone || ''}
                               onChange={(e) => setMe({ ...me, user: { ...me.user, timezone: e.target.value } })}
                               placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button className="btn-primary" type="submit" disabled={saving}>
                            {saving ? 'Saving…' : 'Save changes'}
                        </button>
                    </div>
                </form>
            </div>

            <div className="card">
                <div className="card-header">
                    <div className="card-title-group">
                        <h3><KeyRound size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />Password</h3>
                        <span className="card-desc">Changing it signs out every other device.</span>
                    </div>
                </div>
                <form onSubmit={changePassword}>
                    {pwError && <div className="alert-box danger" style={{ marginBottom: 14 }}><span>{pwError}</span></div>}
                    <div className="form-group">
                        <label htmlFor="pw-cur">Current password</label>
                        <input id="pw-cur" type="password" autoComplete="current-password" value={pw.current_password}
                               onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
                    </div>
                    <div className="form-group">
                        <label htmlFor="pw-new">New password</label>
                        <input id="pw-new" type="password" autoComplete="new-password" value={pw.new_password}
                               onChange={(e) => setPw({ ...pw, new_password: e.target.value })} />
                        <p style={{ margin: '5px 0 0', fontSize: 12, color: 'var(--text-faint)' }}>
                            At least 10 characters. A short phrase beats a short jumble.
                        </p>
                    </div>
                    <div className="form-group">
                        <label htmlFor="pw-conf">Confirm new password</label>
                        <input id="pw-conf" type="password" autoComplete="new-password" value={pw.confirm}
                               onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                        <button className="btn-primary" type="submit"
                                disabled={pwBusy || !pw.current_password || !pw.new_password}>
                            {pwBusy ? 'Updating…' : 'Change password'}
                        </button>
                    </div>
                </form>
            </div>

            <div className="card">
                <div className="card-header">
                    <div className="card-title-group">
                        <h3><Monitor size={15} style={{ verticalAlign: '-2px', marginRight: 6 }} />Signed-in devices</h3>
                        <span className="card-desc">Anything you don't recognise can be signed out here.</span>
                    </div>
                </div>
                {sessions.length === 0 ? (
                    <p style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: 0 }}>No other active sessions.</p>
                ) : sessions.map((s) => (
                    <div className="list-item" key={s.id}>
                        <div>
                            <div className="item-title">{(s.user_agent || 'Unknown device').slice(0, 60)}</div>
                            <div className="item-sub">
                                {s.ip || 'unknown IP'} · last seen {new Date(s.last_seen_at).toLocaleString()}
                            </div>
                        </div>
                        <button className="btn-outline btn-sm" onClick={() => revoke(s.id)}>
                            <Trash2 size={13} /> Sign out
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}
