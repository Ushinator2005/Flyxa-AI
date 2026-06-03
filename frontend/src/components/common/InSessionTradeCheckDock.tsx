import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, GripHorizontal, Minus, ShieldCheck, X } from 'lucide-react';

const STORAGE_KEY      = 'flyxa.trade-check-dock.position';
const PROMPT_KEY       = 'flyxa.session-done-prompt';
const W = 186;
const H_FULL = 210;
const H_MIN = 28;

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
    };
  }
}

type DockPosition = { x: number; y: number };

function getInitialPosition(): DockPosition {
  if (typeof window === 'undefined') return { x: 24, y: 88 };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DockPosition>;
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return {
          x: Math.min(Math.max(8, parsed.x), Math.max(8, window.innerWidth - W - 8)),
          y: Math.min(Math.max(8, parsed.y), Math.max(8, window.innerHeight - H_FULL - 8)),
        };
      }
    }
  } catch { /* ignore */ }
  return { x: Math.max(8, window.innerWidth - W - 16), y: 78 };
}

function fmtMoney(v: number) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function InSessionTradeCheckDock() {
  const navigate = useNavigate();
  const [open, setOpen]           = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition]   = useState<DockPosition>(() => getInitialPosition());
  const [logPrompt, setLogPrompt] = useState<{ tradeCount: number; pnl: number } | null>(null);
  const pipWindowRef = useRef<Window | null>(null);
  const skipFirstPersistRef = useRef(true);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  // Open dock via custom event
  useEffect(() => {
    const handler = () => {
      void openPictureInPicture().then((opened) => {
        if (opened) return;
        setOpen(true);
        setMinimized(false);
      });
    };
    window.addEventListener('flyxa:open-trade-check', handler);
    return () => window.removeEventListener('flyxa:open-trade-check', handler);
  }, []);

  // Restore any pending prompt from a previous session (survives tab switches / refresh)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROMPT_KEY);
      if (raw) setLogPrompt(JSON.parse(raw) as { tradeCount: number; pnl: number });
    } catch { /* ignore */ }
  }, []);

  // Persist prompt to localStorage whenever it changes.
  // Skip the very first run (mount) to avoid a race with the restore effect above —
  // both would otherwise fire with logPrompt=null and erase any key the popup just wrote.
  useEffect(() => {
    if (skipFirstPersistRef.current) { skipFirstPersistRef.current = false; return; }
    try {
      if (logPrompt) localStorage.setItem(PROMPT_KEY, JSON.stringify(logPrompt));
      else localStorage.removeItem(PROMPT_KEY);
    } catch { /* ignore */ }
  }, [logPrompt]);

  // Pick up localStorage writes from the popup window.
  // The Web Storage `storage` event fires in OTHER windows/tabs when localStorage changes,
  // so when TradeCheck (popup) writes PROMPT_KEY, this tab gets notified immediately.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== PROMPT_KEY || !e.newValue) return;
      try { setLogPrompt(JSON.parse(e.newValue) as { tradeCount: number; pnl: number }); } catch { /* ignore */ }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  // Listen for messages from the iframe (inline) or popup (window.opener)
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; tradeCount?: number; pnl?: number };
      if (data?.type === 'flyxa:close-dock') {
        setOpen(false);
      } else if (data?.type === 'flyxa:session-done') {
        setOpen(false);
        if ((data.tradeCount ?? 0) > 0) {
          setLogPrompt({ tradeCount: data.tradeCount!, pnl: data.pnl ?? 0 });
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Auto-dismiss after 5 min of the tab being visible — pauses while tab is hidden
  useEffect(() => {
    if (!logPrompt) return;
    let t: ReturnType<typeof setTimeout> | null = null;

    const start = () => { t = setTimeout(() => setLogPrompt(null), 5 * 60 * 1000); };
    const pause = () => { if (t !== null) { clearTimeout(t); t = null; } };

    const onVisibility = () => { document.hidden ? pause() : start(); };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) start();

    return () => {
      pause();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [logPrompt]);

  // Persist dock position
  useEffect(() => {
    if (!open) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position)); } catch { /* ignore */ }
  }, [open, position]);

  // Drag handling
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const nextX = drag.originX + event.clientX - drag.startX;
      const nextY = drag.originY + event.clientY - drag.startY;
      setPosition({
        x: Math.min(Math.max(8, nextX), Math.max(8, window.innerWidth - W - 8)),
        y: Math.min(Math.max(8, nextY), Math.max(8, window.innerHeight - (minimized ? H_MIN : H_FULL) - 8)),
      });
    };
    const onPointerUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [minimized]);

  async function openPictureInPicture(): Promise<boolean> {
    if (!window.documentPictureInPicture) return false;
    try {
      if (pipWindowRef.current && !pipWindowRef.current.closed) {
        pipWindowRef.current.focus();
        return true;
      }
      const pipWindow = await window.documentPictureInPicture.requestWindow({ width: W, height: H_FULL });
      pipWindowRef.current = pipWindow;
      pipWindow.document.title = 'Flyxa Trade Check';
      pipWindow.document.body.style.cssText = 'margin:0;background:transparent;overflow:hidden';
      const iframe = pipWindow.document.createElement('iframe');
      iframe.title = 'Flyxa Trade Check';
      iframe.src = '/trade-check';
      iframe.style.cssText = 'width:100vw;height:100vh;border:0;display:block;background:transparent';
      pipWindow.document.body.appendChild(iframe);
      pipWindow.addEventListener('pagehide', () => { pipWindowRef.current = null; }, { once: true });
      return true;
    } catch {
      pipWindowRef.current = null;
      return false;
    }
  }

  const openExternal = () => {
    const child = window.open('/trade-check', 'flyxa-trade-check', `popup=yes,width=${W},height=${H_FULL},left=80,top=80,resizable=yes`);
    child?.focus();
  };

  return (
    <>
      {/* ── Floating dock ─────────────────────────────────────────── */}
      {open && (
        <div
          style={{
            position: 'fixed',
            left: position.x,
            top: position.y,
            width: W,
            zIndex: 1600,
            border: '1px solid rgba(255,255,255,0.06)',
            background: 'rgba(4,3,3,0.03)',
            borderRadius: 8,
            overflow: 'hidden',
            boxShadow: '0 1px 10px rgba(0,0,0,0.05)',
            backdropFilter: 'blur(7px)',
            WebkitBackdropFilter: 'blur(7px)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {/* Drag handle / header */}
          <div
            role="button"
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: position.x, originY: position.y };
            }}
            style={{
              height: H_MIN,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              padding: '0 6px 0 8px',
              borderBottom: minimized ? 'none' : '1px solid rgba(255,255,255,0.04)',
              cursor: 'grab',
              userSelect: 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
              <ShieldCheck size={11} color="rgba(245,158,11,0.40)" />
              <span style={{ fontSize: 10.5, fontWeight: 600, color: 'rgba(232,227,220,0.45)', letterSpacing: '0.02em' }}>Trade Check</span>
              <GripHorizontal size={11} color="rgba(92,87,81,0.30)" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <button type="button" onClick={openExternal} title="Open as window" aria-label="Open as window" style={iconBtnStyle}>
                <ExternalLink size={10} />
              </button>
              <button type="button" onClick={() => setMinimized(v => !v)} title={minimized ? 'Expand' : 'Minimize'} aria-label={minimized ? 'Expand' : 'Minimize'} style={iconBtnStyle}>
                <Minus size={10} />
              </button>
              <button type="button" onClick={() => setOpen(false)} title="Close" aria-label="Close" style={iconBtnStyle}>
                <X size={11} />
              </button>
            </div>
          </div>

          {!minimized && (
            <iframe
              title="In-session trade check"
              src="/trade-check"
              style={{ display: 'block', width: '100%', height: H_FULL - H_MIN, border: 'none', background: 'transparent' }}
            />
          )}
        </div>
      )}

      {/* ── Post-session log prompt ────────────────────────────────── */}
      {logPrompt && (
        <div
          style={{
            position: 'fixed',
            bottom: 28,
            right: 28,
            zIndex: 1700,
            width: 276,
            // Backdrop blur layer — opaque enough that text sits on solid bg, not over blur
            background: 'rgba(18,12,4,0.97)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderTop: '2px solid rgba(245,158,11,0.65)',
            border: '1px solid rgba(245,158,11,0.18)',
            borderRadius: 10,
            fontFamily: 'var(--font-sans)',
            boxShadow: '0 16px 48px rgba(0,0,0,0.50)',
            // Force own compositing layer so text renders above the blur, not through it
            transform: 'translateZ(0)',
            WebkitFontSmoothing: 'antialiased',
            MozOsxFontSmoothing: 'grayscale',
          } as React.CSSProperties}
        >
          {/* Inner content isolated from backdrop — prevents blur bleed onto text */}
          <div style={{ padding: '15px 15px 13px', position: 'relative', zIndex: 1, isolation: 'isolate' } as React.CSSProperties}>
            {/* Dismiss */}
            <button
              type="button"
              onClick={() => setLogPrompt(null)}
              style={{ position: 'absolute', top: 0, right: 0, width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', color: 'rgba(232,227,220,0.45)', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}
            >✕</button>

            {/* Header */}
            <p style={{ margin: '0 0 5px', fontSize: 12.5, fontWeight: 700, color: 'rgba(245,158,11,0.95)', letterSpacing: '-0.01em', textRendering: 'optimizeLegibility' } as React.CSSProperties}>
              Session complete
            </p>

            {/* Stats */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 9 }}>
              <span style={{ fontSize: 10, fontWeight: 500, color: 'rgba(232,227,220,0.70)' }}>
                {logPrompt.tradeCount} trade{logPrompt.tradeCount !== 1 ? 's' : ''}
              </span>
              {logPrompt.pnl !== 0 && (
                <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', fontWeight: 800, color: logPrompt.pnl > 0 ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.95)', letterSpacing: '0.01em' }}>
                  {logPrompt.pnl > 0 ? '+' : ''}{fmtMoney(logPrompt.pnl)}
                </span>
              )}
            </div>

            {/* Sub-label */}
            <p style={{ margin: '0 0 12px', fontSize: 9.5, fontWeight: 400, color: 'rgba(232,227,220,0.50)', lineHeight: 1.5 }}>
              Log while it's fresh — your post-session review is waiting.
            </p>

            {/* CTA */}
            <button
              type="button"
              onClick={() => { navigate('/scanner'); setLogPrompt(null); }}
              style={{
                width: '100%',
                height: 34,
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 700,
                border: '1px solid rgba(245,158,11,0.32)',
                background: 'rgba(245,158,11,0.11)',
                color: 'rgba(245,158,11,0.95)',
                cursor: 'pointer',
                letterSpacing: '0.025em',
                transition: 'all 0.12s',
              }}
            >
              Review &amp; log trades →
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const iconBtnStyle = {
  width: 20,
  height: 20,
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: 'rgba(138,129,120,0.38)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  cursor: 'pointer',
} as const;
