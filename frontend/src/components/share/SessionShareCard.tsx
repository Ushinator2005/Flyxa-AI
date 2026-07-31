import { useCallback, useEffect, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { C } from '../../utils/theme.js';

// Social share card for a finished session — Flyxa-branded, exported as PNG.
// Deliberately speaks the app's language (warm dark, mono figures, single
// amber signature line) instead of the neon "prop-firm flex card" idiom.

const PETAL_PATH = 'M52 48 C60 30 74 14 91 7 C87 25 72 41 52 48 Z';

function petalTransform(rotation: number, scale: number): string {
  const offset = 50 * (1 - scale);
  return `rotate(${rotation} 50 50) translate(${offset} ${offset}) scale(${scale})`;
}

function Mark({ size, solid }: { size: number; solid?: string }) {
  const accent = solid ?? C.acc;
  const light = solid ?? C.t0;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} fill="none" aria-hidden="true">
      <path d={PETAL_PATH} fill={accent} transform={petalTransform(0, 1)} />
      <path d={PETAL_PATH} fill={light} transform={petalTransform(-90, 0.82)} />
      <path d={PETAL_PATH} fill={light} transform={petalTransform(90, 0.88)} />
      <path d={PETAL_PATH} fill={light} transform={petalTransform(180, 0.64)} />
    </svg>
  );
}

export interface SessionShareData {
  dateLabel: string;
  netPnl: number;
  trades: number;
  winRate: number;
  grade: string | null;
  /** Third stat cell, picked by the caller for maximum social currency
      (green streak > best trade > instrument). `sensitive` marks dollar
      values so the hide-amount toggle masks them too. */
  extraStat: { label: string; value: string; color?: string; sensitive?: boolean } | null;
  username: string;
}

function fmtMoney(value: number): string {
  const abs = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value >= 0 ? '+' : '−'}$${abs}`;
}

function gradeTone(grade: string | null): string {
  if (!grade) return C.t2;
  if (grade.startsWith('A')) return C.grn;
  if (grade === 'B') return '#60a5fa';
  if (grade === 'C') return C.acc;
  return C.red;
}

export default function SessionShareCard({ open, onClose, data }: {
  open: boolean;
  onClose: () => void;
  data: SessionShareData;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [maskAmount, setMaskAmount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const capture = useCallback(async (): Promise<{ dataUrl: string; blob: Blob } | null> => {
    const el = cardRef.current;
    if (!el) return null;
    try {
      const dataUrl = await toPng(el, { cacheBust: true, pixelRatio: 3, backgroundColor: '#0b0a0a' });
      const blob = await (await fetch(dataUrl)).blob();
      return { dataUrl, blob };
    } catch {
      return null;
    }
  }, []);

  const downloadDataUrl = useCallback((dataUrl: string) => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `flyxa-session-${data.dateLabel.replace(/[^\w]+/g, '-').toLowerCase()}.png`;
    a.click();
  }, [data.dateLabel]);

  const download = useCallback(async () => {
    setBusy(true);
    const captured = await capture();
    setBusy(false);
    if (captured) downloadDataUrl(captured.dataUrl);
  }, [capture, downloadDataUrl]);

  const copyBlob = useCallback(async (blob: Blob): Promise<boolean> => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
      return true;
    } catch {
      return false;
    }
  }, []);

  const copy = useCallback(async () => {
    setBusy(true);
    const captured = await capture();
    setBusy(false);
    if (captured) void copyBlob(captured.blob);
  }, [capture, copyBlob]);

  // One tap per platform. On mobile the native share sheet reaches Instagram,
  // TikTok, Snapchat, etc. directly. Desktop has no web endpoint that accepts
  // an image for IG/TikTok/Snap, so: X/Discord get the image on the clipboard
  // (their composers accept paste), the rest get the PNG + their upload page.
  const shareTo = useCallback(async (platform: 'instagram' | 'tiktok' | 'snapchat' | 'x' | 'discord') => {
    setBusy(true);
    const captured = await capture();
    setBusy(false);
    if (!captured) return;
    const file = new File([captured.blob], 'flyxa-session.png', { type: 'image/png' });
    const text = `Session recap · ${maskAmount ? '' : `${fmtMoney(data.netPnl)} · `}${data.winRate}% win rate — journaled with Flyxa`;

    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Flyxa session recap', text });
        return;
      } catch { /* sheet dismissed — fall through to desktop behavior */ }
    }

    if (platform === 'x') {
      await copyBlob(captured.blob);
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank');
    } else if (platform === 'discord') {
      const ok = await copyBlob(captured.blob);
      if (!ok) downloadDataUrl(captured.dataUrl);
      window.open('https://discord.com/channels/@me', '_blank');
    } else {
      downloadDataUrl(captured.dataUrl);
      const uploadPages = {
        instagram: 'https://www.instagram.com/',
        tiktok: 'https://www.tiktok.com/upload',
        snapchat: 'https://web.snapchat.com/',
      } as const;
      window.open(uploadPages[platform], '_blank');
    }
  }, [capture, copyBlob, data.netPnl, data.winRate, downloadDataUrl, maskAmount]);

  if (!open) return null;

  const pnlColor = data.netPnl >= 0 ? C.grn : C.red;
  const stats: Array<{ label: string; value: string; color?: string }> = [
    { label: 'Trades', value: String(data.trades) },
    { label: 'Win rate', value: `${data.winRate}%` },
    ...(data.extraStat ? [{
      label: data.extraStat.label,
      value: data.extraStat.sensitive && maskAmount ? '✱✱✱' : data.extraStat.value,
      color: data.extraStat.sensitive && maskAmount ? undefined : data.extraStat.color,
    }] : []),
    ...(data.grade ? [{ label: 'Grade', value: data.grade, color: gradeTone(data.grade) }] : []),
  ];

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        backgroundColor: 'rgba(0,0,0,0.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={onClose}
    >
      <div onClick={e => e.stopPropagation()} style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: '100%' }}>

        {/* Exit — outside the card DOM so it never appears in the export */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close share card"
          style={{
            position: 'absolute', top: -14, right: -14, zIndex: 2,
            width: 30, height: 30, borderRadius: '50%',
            border: `1px solid ${C.b1}`, backgroundColor: C.d1, color: C.t1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, lineHeight: 1, cursor: 'pointer',
          }}
        >
          ✕
        </button>

        {/* ── The card (this exact DOM gets exported at 3×) ──
             Fixed dark + amber palette so the export looks identical whatever
             theme the app is in. */}
        <div
          ref={cardRef}
          style={{
            width: 780, maxWidth: '100%', boxSizing: 'border-box', aspectRatio: '16 / 9',
            display: 'flex', borderRadius: 16, overflow: 'hidden', backgroundColor: '#0b0a0a',
          }}
        >
          {/* Left — amber brand panel */}
          <div style={{
            width: '33%', backgroundColor: '#f59e0b', color: '#0e0d0d',
            padding: '30px 26px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              <Mark size={30} solid="#0e0d0d" />
              <span style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700, letterSpacing: '0.01em' }}>FLYXA</span>
            </div>
            <div>
              <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, letterSpacing: '0.2em', textTransform: 'uppercase', opacity: 0.72 }}>
                Session recap
              </p>
              <p style={{ margin: '8px 0 0', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 500 }}>{data.dateLabel}</p>
            </div>
          </div>

          {/* Right — dark result panel */}
          <div style={{ flex: 1, minWidth: 0, backgroundColor: '#0b0a0a', color: '#e8e3dc', padding: '30px 34px', display: 'flex', flexDirection: 'column' }}>
            {/* P&L centered in the space above the footer, not pinned to the top */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#6f695f' }}>
                Net P&L
              </p>
              <p style={{
                margin: '12px 0 0', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700,
                fontSize: 'clamp(44px, 8vw, 72px)', lineHeight: 1, letterSpacing: '-0.02em',
                color: maskAmount ? '#8a8178' : pnlColor,
              }}>
                {maskAmount ? '✱✱✱✱' : fmtMoney(data.netPnl)}
              </p>
            </div>

            <div>
              <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.09)', marginBottom: 18 }} />
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 18 }}>
                <div style={{ display: 'flex', gap: 34 }}>
                  {stats.slice(0, 3).map(stat => (
                    <div key={stat.label}>
                      <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#6f695f' }}>
                        {stat.label}
                      </p>
                      <p style={{ margin: '8px 0 0', fontFamily: 'var(--font-mono)', fontSize: 19, fontWeight: 500, color: stat.color ?? '#e8e3dc' }}>
                        {stat.value}
                      </p>
                    </div>
                  ))}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500, color: '#e8e3dc' }}>@{data.username}</p>
                  <p style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#6f695f' }}>
                    Journals with Flyxa
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Share destinations ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.t2, marginRight: 2 }}>
            Share to
          </span>
          {([
            { id: 'instagram', label: 'Instagram' },
            { id: 'tiktok', label: 'TikTok' },
            { id: 'snapchat', label: 'Snapchat' },
            { id: 'x', label: 'X' },
            { id: 'discord', label: 'Discord' },
          ] as const).map(platform => (
            <button
              key={platform.id}
              type="button"
              onClick={() => shareTo(platform.id)}
              disabled={busy}
              style={{
                padding: '8px 14px', borderRadius: 999,
                border: `1px solid ${C.b1}`, background: C.d1,
                color: C.t0, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              {platform.label}
            </button>
          ))}
        </div>
        <p style={{ margin: '-4px 0 0', fontSize: 10.5, color: C.t2, lineHeight: 1.5 }}>
          On your phone this opens the share sheet straight into the app. On desktop, X and Discord get the image on your clipboard — the others download it and open their upload page.
        </p>

        {/* ── Controls ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: C.t1, cursor: 'pointer', marginRight: 'auto' }}>
            <input type="checkbox" checked={maskAmount} onChange={e => setMaskAmount(e.target.checked)} style={{ accentColor: C.acc }} />
            Hide amount
          </label>
          <button type="button" onClick={copy} disabled={busy}
            style={{ padding: '9px 16px', borderRadius: 7, border: `1px solid ${C.b1}`, background: C.d1, color: copied ? C.grn : C.t0, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            {copied ? 'Copied ✓' : 'Copy image'}
          </button>
          <button type="button" onClick={download} disabled={busy}
            style={{ padding: '9px 18px', borderRadius: 7, border: 'none', background: C.acc, color: '#000', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            {busy ? 'Rendering…' : 'Download PNG'}
          </button>
          <button type="button" onClick={onClose}
            style={{ padding: '9px 10px', background: 'none', border: 'none', color: C.t2, fontSize: 12, cursor: 'pointer' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
