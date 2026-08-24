/**
 * Brand marks.
 *
 * Two deliberately different things:
 *
 *  - WhatsAppGlyph  the genuine WhatsApp mark. Used ONLY to indicate the
 *                   integration ("connect your WhatsApp", connection status),
 *                   which is accepted referential use. Never as our app icon.
 *  - WaReachMark    WA Reach's own logo — a chat bubble carrying a send/reach
 *                   arrow. This is what identifies the product.
 */

/**
 * The WhatsApp logo as people actually recognise it: the brand-green tile with
 * the white handset-in-a-bubble. `mono` renders the bare glyph in currentColor
 * for places that need a single-colour mark (status rows, buttons).
 *
 * The glyph path is WhatsApp's own and is never recoloured or distorted.
 */
const WA_GLYPH = "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z";

export function WhatsAppGlyph({
    size = 24,
    className = '',
    title = 'WhatsApp',
    color = '#25D366',
    tile = false,
    mono = false,
}) {
    // Single-colour, inherits currentColor. For status rows and buttons.
    if (mono) {
        return (
            <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
                 className={className} role="img" aria-label={title}>
                <title>{title}</title>
                <path d={WA_GLYPH} />
            </svg>
        );
    }

    // White glyph on a green tile — the app-icon lockup.
    if (tile) {
        return (
            <svg width={size} height={size} viewBox="0 0 48 48" className={className}
                 role="img" aria-label={title}>
                <title>{title}</title>
                <rect width="48" height="48" rx="11" fill={color} />
                <g transform="translate(10 10) scale(1.1667)">
                    <path d={WA_GLYPH} fill="#FFFFFF" />
                </g>
            </svg>
        );
    }

    // Default: the logo as it is normally shown — green mark on a transparent
    // ground, ringed bubble with a solid handset. Path is WhatsApp's own and is
    // never redrawn or distorted.
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" className={className}
             role="img" aria-label={title}>
            <title>{title}</title>
            <path d={WA_GLYPH} fill={color} />
        </svg>
    );
}

/**
 * WA Reach's own mark: a speech bubble with a paper-plane/reach arrow inside.
 * Reads as messaging without borrowing anyone's identity.
 */
export function WaReachMark({ size = 24, className = '', title = 'WA Reach' }) {
    return (
        <svg
            width={size} height={size} viewBox="0 0 32 32"
            fill="none" className={className}
            role="img" aria-label={title}
        >
            <title>{title}</title>
            {/* bubble */}
            <path
                d="M16 3C8.82 3 3 8.3 3 14.84c0 3.53 1.7 6.7 4.4 8.86l-.98 4.7a.8.8 0 0 0 1.16.88l4.5-2.4c1.24.33 2.56.5 3.92.5 7.18 0 13-5.3 13-11.84S23.18 3 16 3Z"
                fill="currentColor"
            />
            {/* reach arrow */}
            <path
                d="m22.1 11.2-9.9 3.63c-.5.19-.5.9.01 1.07l3.83 1.26 1.3 3.86c.17.51.88.5 1.05-.02l3.7-9.8a.55.55 0 0 0-.7-.7l.71.7Z"
                fill="var(--brand-deep, #075E54)"
            />
            <path d="m16.05 17.17 3.4-3.42" stroke="var(--brand, #25D366)" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    );
}

/** Logo lockup: mark in a rounded tile + wordmark. */
export function Logo({ size = 24, showText = true, textClass = '' }) {
    return (
        <>
            <span
                style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--brand)', color: 'var(--brand-deep)',
                    borderRadius: 'var(--r-md)', padding: 6,
                    boxShadow: '0 2px 8px rgba(37,211,102,.30)',
                }}
            >
                <WaReachMark size={size} />
            </span>
            {showText && <span className={textClass}>WA Reach</span>}
        </>
    );
}

export default { WhatsAppGlyph, WaReachMark, Logo };
