import { useState, useEffect } from 'react';
import { Key, Copy, Check, RefreshCw, AlertTriangle, Terminal } from 'lucide-react';
import { useConfirm } from './ui/ConfirmDialog';

/**
 * API key management.
 *
 * WA Reach's second product: a user links their own WhatsApp here, takes this
 * key, and any app they use can then send through their number.
 */
export default function ApiKeyPanel({ apiUrl, token }) {
    const [key, setKey] = useState(null);
    const [created, setCreated] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState('');
    const confirm = useConfirm();

    const auth = { Authorization: `Bearer ${token}` };

    useEffect(() => {
        (async () => {
            try {
                const r = await fetch(`${apiUrl}/apikey`, { headers: auth });
                if (r.ok) { const d = await r.json(); setKey(d.api_key); setCreated(d.created_at); }
            } finally { setLoading(false); }
        })();
    }, [apiUrl, token]);

    const issue = async () => {
        // Rotating invalidates the old key immediately, so anything still using
        // it breaks — worth saying out loud rather than discovering in prod.
        if (key) {
            const ok = await confirm({
                title: 'Generate a new key?',
                body: 'The current key stops working immediately, and anything using it will start failing until you update it there.',
                confirmLabel: 'Generate new key',
                danger: true,
            });
            if (!ok) return;
        }
        setBusy(true);
        try {
            const r = await fetch(`${apiUrl}/apikey`, { method: 'POST', headers: auth });
            if (r.ok) { const d = await r.json(); setKey(d.api_key); setCreated(d.created_at); }
        } finally { setBusy(false); }
    };

    const copy = (text, what) => {
        navigator.clipboard?.writeText(text);
        setCopied(what);
        setTimeout(() => setCopied(''), 1800);
    };

    const example = `curl -X POST ${window.location.origin}/api/v1/messages \\
  -H "Authorization: Bearer ${key || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"919876543210","text":"Your appointment is tomorrow at 4pm."}'`;

    if (loading) return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
                <h4 style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Your API key</h4>
                <p style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: 0, maxWidth: '62ch' }}>
                    Anything holding this key can send WhatsApp messages through your connected
                    number. Treat it like a password — don't commit it or put it in front-end code.
                </p>
            </div>

            {key ? (
                <div className="apikey-box">
                    <Key size={16} style={{ color: 'var(--brand-teal)', flex: 'none' }} />
                    <code>{key}</code>
                    <button className="btn-outline btn-sm" onClick={() => copy(key, 'key')}>
                        {copied === 'key' ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}
                    </button>
                </div>
            ) : (
                <div className="alert-box info">
                    <Key size={16} style={{ flex: 'none', marginTop: 1 }} />
                    <span>No key yet. Generate one to start sending programmatically.</span>
                </div>
            )}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn-primary btn-sm" onClick={issue} disabled={busy}>
                    <RefreshCw size={14} /> {busy ? 'Generating…' : key ? 'Regenerate key' : 'Generate key'}
                </button>
                {created && (
                    <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
                        Created {new Date(created).toLocaleString()}
                    </span>
                )}
            </div>

            {key && (
                <div className="alert-box warning">
                    <AlertTriangle size={16} style={{ flex: 'none', marginTop: 1 }} />
                    <span>Regenerating invalidates the current key immediately. Any app using it will stop working until you update it there.</span>
                </div>
            )}

            <div>
                <h4 style={{ fontSize: 14.5, fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Terminal size={15} /> Send a message
                </h4>
                <div className="code-block">
                    <button className="code-copy" onClick={() => copy(example, 'curl')}>
                        {copied === 'curl' ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                    <pre>{example}</pre>
                </div>
                <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>
                    Also available: <code>GET /api/v1/status</code> to check the connection, and{' '}
                    <code>GET /api/v1/messages</code> for what you've sent. Contacts who opted out are
                    rejected with <code>403</code>, and sending is capped at 60 messages per minute.
                </p>
            </div>
        </div>
    );
}
