import { useEffect, useRef, useState } from 'react';
import { ExternalLink, GripHorizontal, Minus, ShieldCheck, X } from 'lucide-react';

const STORAGE_KEY = 'flyxa.trade-check-dock.position';
const W = 186;
const H_FULL = 210; // header + iframe
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

export default function InSessionTradeCheckDock() {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState<DockPosition>(() => getInitialPosition());
  const pipWindowRef = useRef<Window | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

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

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'flyxa:close-dock') setOpen(false);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position)); } catch { /* ignore */ }
  }, [open, position]);

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

  if (!open) return null;

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
