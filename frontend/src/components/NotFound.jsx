import { Compass } from 'lucide-react';

/**
 * There was no 404: main.jsx routed path="/*" straight to the app, so /typo
 * rendered the dashboard as though nothing were wrong.
 */
export default function NotFound({ onHome }) {
    return (
        <div className="empty-state" style={{ minHeight: '55vh' }}>
            <div className="empty-art"><Compass size={30} strokeWidth={1.5} /></div>
            <h4>That page doesn't exist</h4>
            <p>The link may be out of date, or the address mistyped.</p>
            <button className="btn-primary btn-sm" onClick={onHome}>Back to dashboard</button>
        </div>
    );
}
