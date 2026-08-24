import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

/**
 * Catches render errors so one broken component doesn't blank the whole app.
 *
 * There was none of this before, which is why a `ReferenceError` in a click
 * handler took the entire UI down with it and made a working feature look like
 * it had vanished.
 */
export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        // Kept in the console until there's real error tracking (Phase 9).
        console.error('[ErrorBoundary]', error, info?.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;

        return (
            <div className="empty-state" style={{ minHeight: '60vh' }}>
                <div className="empty-art" style={{ color: 'var(--danger)' }}>
                    <AlertTriangle size={30} strokeWidth={1.5} />
                </div>
                <h4>{this.props.title || 'Something broke on this screen'}</h4>
                <p>
                    The rest of the app is still fine — you can move to another section, or reload
                    to try again.
                </p>
                <pre
                    style={{
                        marginTop: 14, maxWidth: 560, textAlign: 'left', overflowX: 'auto',
                        background: 'var(--surface-sunken)', border: '1px solid var(--border)',
                        borderRadius: 'var(--r-md)', padding: '10px 12px',
                        fontSize: 12, color: 'var(--text-muted)',
                    }}
                >
                    {String(this.state.error?.message || this.state.error)}
                </pre>
                <button className="btn-primary btn-sm" onClick={() => this.setState({ error: null })}>
                    <RefreshCw size={14} /> Try again
                </button>
            </div>
        );
    }
}
