import { useState, useCallback, createContext, useContext } from 'react';
import { AlertTriangle } from 'lucide-react';
import Modal from './Modal';

/**
 * Replaces window.confirm, used in 4 places, and gives destructive actions a
 * consistent shape. The old native dialogs also couldn't say WHAT was being
 * deleted — "Delete automation?" named nothing.
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: 'Delete Priya Sharma?', danger: true })) …
 */
const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
    const [state, setState] = useState(null);

    const confirm = useCallback((opts) => new Promise((resolve) => {
        setState({ ...opts, resolve });
    }), []);

    const close = (answer) => {
        state?.resolve(answer);
        setState(null);
    };

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <Modal
                open={!!state}
                onClose={() => close(false)}
                size="sm"
                title={state?.title || 'Are you sure?'}
                footer={
                    <>
                        <button className="btn-outline" onClick={() => close(false)}>
                            {state?.cancelLabel || 'Cancel'}
                        </button>
                        <button
                            className={state?.danger ? 'btn-danger' : 'btn-primary'}
                            onClick={() => close(true)}
                        >
                            {state?.confirmLabel || 'Confirm'}
                        </button>
                    </>
                }
            >
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    {state?.danger && (
                        <span style={{ color: 'var(--danger)', flex: 'none', marginTop: 1 }}>
                            <AlertTriangle size={20} />
                        </span>
                    )}
                    <p style={{ margin: 0, fontSize: 14, color: 'var(--text-muted)' }}>
                        {state?.body || 'This cannot be undone.'}
                    </p>
                </div>
            </Modal>
        </ConfirmContext.Provider>
    );
}

export function useConfirm() {
    const ctx = useContext(ConfirmContext);
    if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
    return ctx;
}
