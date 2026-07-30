import { X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
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
  const navigate = useNavigate();

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
        // Emphasized alerts (breaking news, imminent high-impact events) get a
        // wider stack so they read as a warning banner, not a passing notice.
        width: toasts.some((toast) => toast.emphasis) ? 440 : 360,
        maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {/* Pulse for emphasized (breaking-news) toasts. */}
      <style>{`@keyframes flyxa-toast-pulse {
        0%, 100% { box-shadow: 0 10px 30px rgba(0,0,0,0.35), 0 0 0 0 rgba(248,113,113,0.45); }
        50% { box-shadow: 0 10px 30px rgba(0,0,0,0.35), 0 0 0 7px rgba(248,113,113,0); }
      }`}</style>
      {toasts.map((toast) => {
        const tone = toneStyles[toast.tone];
        const clickable = Boolean(toast.href);
        const open = () => {
          dismissToast(toast.id);
          if (toast.href) navigate(toast.href);
        };
        return (
          <div
            key={toast.id}
            role={toast.emphasis ? 'alert' : undefined}
            aria-live={toast.emphasis ? 'assertive' : undefined}
            onClick={clickable ? open : undefined}
            style={{
              border: toast.emphasis ? `2px solid var(--red, #f87171)` : `1px solid ${tone.border}`,
              background: toast.emphasis ? 'rgba(80, 14, 14, 0.97)' : 'var(--surface-1)',
              borderRadius: toast.emphasis ? 8 : 6,
              padding: toast.emphasis ? '18px 20px' : '12px 16px',
              color: 'var(--txt)',
              fontSize: toast.emphasis ? 15 : 13,
              fontFamily: 'var(--font-sans)',
              display: 'flex',
              alignItems: toast.emphasis ? 'flex-start' : 'center',
              gap: 10,
              cursor: clickable ? 'pointer' : 'default',
              transform: 'translateX(0)',
              opacity: 1,
              transition: 'transform 160ms ease, opacity 160ms ease',
              boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
              animation: toast.emphasis ? 'flyxa-toast-pulse 1.6s ease-in-out infinite' : undefined,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: toast.emphasis ? '50%' : 2,
                background: toast.emphasis ? 'var(--red, #f87171)' : tone.bg,
                border: `1px solid ${toast.emphasis ? 'var(--red, #f87171)' : tone.border}`,
                boxShadow: toast.emphasis ? '0 0 8px var(--red, #f87171)' : undefined,
                flexShrink: 0,
                marginTop: toast.emphasis ? 5 : 0,
              }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>
              {toast.kicker && (
                <span style={{
                  display: 'block',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--red, #f87171)',
                  marginBottom: 4,
                }}>
                  {toast.kicker}
                </span>
              )}
              <span style={{
                color: toast.emphasis ? '#fff' : tone.text,
                fontWeight: toast.emphasis ? 600 : 400,
                lineHeight: 1.45,
              }}>
                {toast.message}
              </span>
            </span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={(event) => {
                event.stopPropagation();
                dismissToast(toast.id);
              }}
              style={{
                border: 'none',
                background: 'transparent',
                color: toast.emphasis ? 'rgba(255,255,255,0.7)' : 'var(--txt-3)',
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
