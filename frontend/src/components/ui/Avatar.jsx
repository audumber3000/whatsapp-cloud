/**
 * `.avatar` has been styled in index.css since the rebrand and used by exactly
 * nothing — the header showed the literal string "User".
 */
const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];

function initials(name = '') {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable per name, so a person keeps the same colour between sessions.
function tint(name = '') {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
}

export default function Avatar({ name, src, size = 34, title }) {
    const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
    if (src) {
        return <img className="avatar" src={src} alt={name || ''} title={title || name} style={style} />;
    }
    return (
        <span className="avatar" style={{ ...style, background: tint(name || ''), color: '#fff' }} title={title || name}>
            {initials(name)}
        </span>
    );
}
