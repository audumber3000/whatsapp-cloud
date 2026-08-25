import { useState, useEffect } from 'react';

/**
 * The three design tiers, readable from JS.
 *
 * CSS handles layout, but some decisions cannot be made with CSS alone — a
 * phone toolbar of six buttons should become two buttons and an overflow menu,
 * which is a different tree, not a different style. These match the
 * breakpoints in index.css exactly; change them in both places or neither.
 */
export default function useMediaQuery(query) {
    const [matches, setMatches] = useState(
        () => typeof window !== 'undefined' && window.matchMedia(query).matches);

    useEffect(() => {
        const mq = window.matchMedia(query);
        const on = () => setMatches(mq.matches);
        on();
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, [query]);

    return matches;
}

export const useIsMobile = () => useMediaQuery('(max-width: 639px)');
export const useIsTablet = () => useMediaQuery('(min-width: 640px) and (max-width: 1023px)');
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');
