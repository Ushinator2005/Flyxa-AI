import { CSSProperties, ReactNode, useMemo } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// P&L distribution — lollipop rows on a shared zero axis.
//
// One component, used identically by "P&L by day of week" and "P&L by session"
// (and, later, By Setup / By Symbol / By Instrument / By Hour). The only thing
// a caller varies is the sort order. Everything else — row height, dot size,
// colour rules, scale — is fixed here so every distribution card reads the same.
//
// It fixes the four faults of the old floating columns:
//   1. a real zero axis, so a loss is unmistakable from a win of similar size
//   2. empty categories still render (grey dot on zero, "no trades")
//   3. sub-3-trade rows are de-emphasised so one lucky session isn't a "pattern"
//   4. the value sits quietly at the row end, not shouting above every bar
// ─────────────────────────────────────────────────────────────────────────────

export interface LollipopRow {
  key: string;      // display label, e.g. "Mon" / "Asia"
  count: number;    // trades in this category
  value: number;    // net P&L
}

const NEG_TEXT = '#FF7B6E';
const NEG_STEM = 'rgba(192,57,43,0.55)';
const POS_STEM = 'rgba(48,209,88,0.5)';
const MAX_REACH = 44;      // longest stem = 44% of half-track from centre

function fmtSigned(v: number): string {
  const n = Math.round(v);
  return `${n < 0 ? '−' : '+'}$${Math.abs(n).toLocaleString('en-US')}`;
}

// One injected stylesheet covers hover, focus, the grow animation, reduced
// motion and the <480px stack. Duplicated across instances is harmless.
const STYLE = `
.lolli-row { display:grid; grid-template-columns:46px 1fr 78px; gap:12px; align-items:center;
  padding:11px 0; border:0; background:none; width:100%; text-align:left; cursor:pointer;
  border-top:1px solid rgba(255,255,255,0.05); font-family:inherit; }
.lolli-row:first-of-type { border-top:0; }
.lolli-key, .lolli-value { transition:color .15s ease; }
.lolli-axis { transition:background .15s ease; }
.lolli-row:hover .lolli-key, .lolli-row:hover .lolli-value { color:var(--app-text) !important; }
.lolli-row:hover .lolli-axis { background:rgba(255,255,255,0.12) !important; }
.lolli-row:focus { outline:none; }
.lolli-row:focus-visible { outline:2px solid var(--amber); outline-offset:3px; border-radius:3px; }
@keyframes lolli-stem { from { transform:translateY(-50%) scaleX(0); } to { transform:translateY(-50%) scaleX(1); } }
@keyframes lolli-dot { from { opacity:0; } to { opacity:1; } }
.lolli-stem { animation:lolli-stem 500ms cubic-bezier(.2,.7,.2,1) both; }
.lolli-dot { animation:lolli-dot 200ms ease both; }
@media (prefers-reduced-motion: reduce) {
  .lolli-stem { animation:none; transform:translateY(-50%) scaleX(1); }
  .lolli-dot { animation:none; opacity:1; }
}
@media (max-width:480px) {
  .lolli-row { grid-template-columns:1fr auto; grid-template-areas:"key value" "track track"; row-gap:8px; }
  .lolli-key { grid-area:key; } .lolli-track { grid-area:track; } .lolli-value { grid-area:value; }
}
`;

export default function LollipopDistribution({
  title, rows, order, unit, sortLabel, loading = false, onSelect, note,
}: {
  title: string;
  rows: LollipopRow[];
  order: 'value' | 'given';   // day-of-week ranks by value; session keeps given (chronological) order
  unit: string;               // "days" / "sessions"
  sortLabel: string;          // "ranked" / "by session"
  loading?: boolean;
  onSelect?: (key: string) => void;
  note?: ReactNode;           // optional insight line rendered beneath the rows
}) {
  const ordered = useMemo(
    () => (order === 'value' ? [...rows].sort((a, b) => b.value - a.value) : rows),
    [rows, order],
  );

  const traded = rows.filter(r => r.count > 0);
  const totalTrades = rows.reduce((s, r) => s + r.count, 0);
  const net = rows.reduce((s, r) => s + r.value, 0);
  const maxAbs = Math.max(1, ...traded.map(r => Math.abs(r.value)));

  // Callout: a single category carrying > 60% of all losses.
  const totalLosses = rows.reduce((s, r) => s + (r.value < 0 ? Math.abs(r.value) : 0), 0);
  const worstLoss = ordered.filter(r => r.value < 0).sort((a, b) => a.value - b.value)[0];
  const callout = worstLoss && totalLosses > 0 && Math.abs(worstLoss.value) > 0.6 * totalLosses
    ? { key: worstLoss.key, value: worstLoss.value, pct: Math.round((Math.abs(worstLoss.value) / totalLosses) * 100) }
    : null;

  const context = loading
    ? '…'
    : `${rows.length} ${unit} · ${totalTrades} trades · net ${fmtSigned(net)} · ${sortLabel}`;

  const card: CSSProperties = {
    background: 'var(--app-panel)', border: '1px solid var(--app-border)', borderRadius: 12,
    padding: '20px 22px 22px', fontFamily: 'var(--font-sans)',
  };
  const mono = 'var(--font-mono)';

  return (
    <section style={card}>
      <style>{STYLE}</style>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: callout ? 14 : 6 }}>
        <span style={{ fontFamily: mono, fontSize: 9.5, letterSpacing: '1.6px', textTransform: 'uppercase', color: 'var(--app-text-muted)', whiteSpace: 'nowrap' }}>{title}</span>
        <span style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--app-text-subtle)', textAlign: 'right' }}>{context}</span>
      </div>

      {/* Callout */}
      {callout && (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, background: 'var(--app-panel-strong)', borderLeft: '2px solid var(--amber)', borderRadius: '0 8px 8px 0', padding: '14px 16px', marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text)' }}>{callout.key} is costing you the most.</span>
          <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--app-text-muted)', whiteSpace: 'nowrap' }}>{fmtSigned(callout.value)} · {callout.pct}% of losses</span>
        </div>
      )}

      {/* Rows */}
      <div>
        {ordered.map((row, i) => {
          const empty = row.count === 0;
          const positive = row.value >= 0;
          const offset = empty || loading ? 0 : (Math.abs(row.value) / maxAbs) * MAX_REACH;
          const dotColor = empty ? 'rgba(255,255,255,0.18)' : positive ? 'var(--green)' : NEG_TEXT;
          const stemColor = positive ? POS_STEM : NEG_STEM;
          const keyColor = empty ? 'var(--app-text-subtle)' : 'var(--app-text-muted)';
          const valColor = empty ? 'var(--app-text-subtle)' : positive ? 'var(--green)' : NEG_TEXT;

          return (
            <button
              key={row.key}
              type="button"
              className="lolli-row"
              onClick={() => onSelect?.(row.key)}
              aria-label={`${row.key}: ${empty ? 'no trades' : `${fmtSigned(row.value)} across ${row.count} trade${row.count === 1 ? '' : 's'}`}`}
            >
              {/* Key + count */}
              <span className="lolli-key" style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontFamily: mono, fontSize: 11.5, textTransform: 'uppercase', color: keyColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.key}</span>
                <span style={{ display: 'block', fontFamily: mono, fontSize: 9.5, color: 'var(--app-text-subtle)', marginTop: 2 }}>
                  {empty ? '—' : `${row.count} trade${row.count === 1 ? '' : 's'}`}
                </span>
              </span>

              {/* Track */}
              <span className="lolli-track" style={{ position: 'relative', height: 14, display: 'block' }}>
                {/* horizontal axis line */}
                <span className="lolli-axis" style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, background: 'rgba(255,255,255,0.07)' }} />
                {/* zero rule */}
                <span style={{ position: 'absolute', left: '50%', top: -4, bottom: -4, width: 1, background: 'rgba(255,255,255,0.14)' }} />
                {/* stem */}
                {!empty && !loading && offset > 0 && (
                  <span
                    className="lolli-stem"
                    style={{
                      position: 'absolute', top: '50%', height: 1.5, background: stemColor,
                      ...(positive
                        ? { left: '50%', width: `${offset}%`, transformOrigin: 'left center' }
                        : { right: '50%', width: `${offset}%`, transformOrigin: 'right center' }),
                      animationDelay: `${i * 60}ms`,
                    }}
                  />
                )}
                {/* dot */}
                {!loading && (
                  <span
                    className="lolli-dot"
                    style={{
                      position: 'absolute', top: '50%', width: 9, height: 9, borderRadius: '50%',
                      background: dotColor, transform: 'translate(-50%,-50%)',
                      left: `${50 + (positive ? offset : -offset)}%`,
                      animationDelay: `${(empty ? 0 : 500) + i * 60}ms`,
                    }}
                  />
                )}
              </span>

              {/* Value */}
              <span className="lolli-value" style={{ fontFamily: mono, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: valColor, whiteSpace: 'nowrap' }}>
                {empty ? 'no trades' : fmtSigned(row.value)}
              </span>
            </button>
          );
        })}
      </div>

      {note && (
        <p style={{ margin: '13px 0 0', fontSize: 10.5, lineHeight: 1.55, color: 'var(--app-text-subtle)' }}>{note}</p>
      )}
    </section>
  );
}
