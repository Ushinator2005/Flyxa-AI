import { X } from 'lucide-react';
import { useToastStore } from '../../store/toastStore.js';

const toneStyles = {
  amber: {
    border: 'var(--amber-border)',
    text: 'var(--amber)',
    bg: 'var(--amber-dim)',
  },
  red: {
    border: 'var(--red-border)',
    text: 'var(--red)',
    bg: 'var(--red-dim)',
  },
  green: {
    border: 'var(--green-border)',
    text: 'var(--green)',
    bg: 'var(--green-dim)',
  },
} as const;

export default function ToastStack() {
  const toasts = useToastStore((state) => state.toasts);
  const dismissToast = useToastStore((state) => state.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 360,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {toasts.map((toast) => {
        const tone = toneStyles[toast.tone];
        return (
          <div
            key={toast.id}
            style={{
              border: `1px solid ${tone.border}`,
              background: 'var(--surface-1)',
              borderRadius: 6,
              padding: '12px 16px',
              color: 'var(--txt)',
              fontSize: 13,
              fontFamily: 'var(--font-sans)',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              transform: 'translateX(0)',
              opacity: 1,
              transition: 'transform 160ms ease, opacity 160ms ease',
              boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: tone.bg,
                border: `1px solid ${tone.border}`,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, color: tone.text }}>{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismissToast(toast.id)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--txt-3)',
                cursor: 'pointer',
                lineHeight: 0,
                padding: 0,
              }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
