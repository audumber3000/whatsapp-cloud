import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Right-side slide-over. There were none in the app at all, which is why a
 * contact row had nowhere to open to — the record simply didn't have a view.
 * Same accessibility contract as Modal.
 */
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function Drawer({ open, onClose, title, subtitle, children, footer, width = 460 }) {
    const panelRef = useRef(null);
    const restoreRef = useRef(null);

    const handleKey = useCallback((e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return; }
        if (e.key !== 'Tab') return;
        const nodes = panelRef.current?.querySelectorAll(FOCUSABLE);
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }, [onClose]);

    useEffect(() => {
        if (!open) return;
        restoreRef.current = document.activeElement;
        const t = setTimeout(() => {
            (panelRef.current?.querySelector(FOCUSABLE) || panelRef.current)?.focus?.();
        }, 0);
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', handleKey, true);
        return () => {
            clearTimeout(t);
            document.removeEventListener('keydown', handleKey, true);
            document.body.style.overflow = prev;
            restoreRef.current?.focus?.();
        };
    }, [open, handleKey]);

    if (!open) return null;

    return createPortal(
        <div className="drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
            <aside
                className="drawer-panel"
                style={{ width }}
                role="dialog"
                aria-modal="true"
                aria-label={typeof title === 'string' ? title : undefined}
                ref={panelRef}
                tabIndex={-1}
            >
                <div className="drawer-head">
                    <div>
                        {title && <h3>{title}</h3>}
                        {subtitle && <p>{subtitle}</p>}
                    </div>
                    <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
                </div>
                <div className="drawer-body">{children}</div>
                {footer && <div className="drawer-foot">{footer}</div>}
            </aside>
        </div>,
        document.body
    );
}
