import { useState, useRef, useEffect } from 'react';

/**
 * Small anchored menu. Closes on outside click and Escape, and returns focus to
 * its trigger — the header previously had no menu at all, just a bare logout
 * icon with no confirmation and nothing else on it.
 */
export default function Dropdown({ trigger, children, align = 'right', width = 220 }) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);
    const triggerRef = useRef(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div className="dropdown" ref={wrapRef}>
            <button
                ref={triggerRef}
                className="dropdown-trigger"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
            >
                {trigger}
            </button>
            {open && (
                <div
                    className="dropdown-menu"
                    role="menu"
                    style={{ width, [align === 'right' ? 'right' : 'left']: 0 }}
                    onClick={() => setOpen(false)}
                >
                    {children}
                </div>
            )}
        </div>
    );
}

export function DropdownItem({ icon, children, onClick, danger }) {
    return (
        <button className={`dropdown-item${danger ? ' danger' : ''}`} onClick={onClick} role="menuitem">
            {icon}
            <span>{children}</span>
        </button>
    );
}

export function DropdownDivider() { return <div className="dropdown-divider" />; }
