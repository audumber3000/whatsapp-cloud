import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * The modal the app never had.
 *
 * The three hand-rolled ones shared two CSS classes and nothing else: none
 * rendered through a portal (so they stacked under the sticky header), none
 * trapped focus, none closed on Escape, and one had no backdrop click at all —
 * its only exit was the Cancel button.
 */
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export default function Modal({
    open,
    onClose,
    title,
    description,
    children,
    footer,
    size = 'md',            // sm | md | lg
    closeOnBackdrop = true,
}) {
    const panelRef = useRef(null);
    const restoreRef = useRef(null);

    const handleKey = useCallback((e) => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return; }
        if (e.key !== 'Tab') return;

        // Keep Tab inside the dialog; otherwise focus wanders onto the page
        // behind, which is still scrollable and clickable without this.
        const nodes = panelRef.current?.querySelectorAll(FOCUSABLE);
        if (!nodes?.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }, [onClose]);

    useEffect(() => {
        if (!open) return;
        restoreRef.current = document.activeElement;

        // Focus the first control, or the panel, so a keyboard user starts inside.
        const t = setTimeout(() => {
            const node = panelRef.current?.querySelector(FOCUSABLE) || panelRef.current;
            node?.focus?.();
        }, 0);

        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', handleKey, true);

        return () => {
            clearTimeout(t);
            document.removeEventListener('keydown', handleKey, true);
            document.body.style.overflow = prevOverflow;
            restoreRef.current?.focus?.();   // return focus to whatever opened it
        };
    }, [open, handleKey]);

    if (!open) return null;

    const width = { sm: 420, md: 560, lg: 760 }[size] || 560;

    return createPortal(
        <div
            className="modal-overlay"
            onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget) onClose?.(); }}
        >
            <div
                className="modal-content"
                style={{ maxWidth: width }}
                role="dialog"
                aria-modal="true"
                aria-label={typeof title === 'string' ? title : undefined}
                ref={panelRef}
                tabIndex={-1}
            >
                {(title || onClose) && (
                    <div className="modal-head">
                        <div>
                            {title && <h3>{title}</h3>}
                            {description && <p>{description}</p>}
                        </div>
                        {onClose && (
                            <button className="icon-btn" onClick={onClose} aria-label="Close">
                                <X size={18} />
                            </button>
                        )}
                    </div>
                )}
                <div className="modal-body">{children}</div>
                {footer && <div className="modal-foot">{footer}</div>}
            </div>
        </div>,
        document.body
    );
}
