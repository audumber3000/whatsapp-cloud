import { useRef, useCallback, useEffect } from 'react';

/**
 * A callback whose identity never changes, but which always calls the latest
 * version passed in.
 *
 * This exists because of a real bug. `onToast` was in the dependency array of
 * the inbox's fetch callback, and one parent passed it as an inline arrow —
 * a new function on every render. Any failed request then showed a toast,
 * which re-rendered the parent, which produced a new `onToast`, which changed
 * the fetch callback's identity, which re-ran the effect, which fetched, which
 * failed. 1,098 requests and 675 stacked toasts in six seconds.
 *
 * A notification sink is not data: nothing should re-fetch because the way to
 * report an error changed. Wrapping it here means a caller passing an inline
 * arrow is harmless, rather than a trap for whoever writes the next screen.
 */
export default function useEvent(fn) {
    const ref = useRef(fn);
    useEffect(() => { ref.current = fn; });
    return useCallback((...args) => ref.current?.(...args), []);
}
