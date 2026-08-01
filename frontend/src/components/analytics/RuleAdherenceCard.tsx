import { CSSProperties, useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Rule adherence — a streak ribbon + rule breakdown, computed from one data
// object so nothing in the card can contradict anything else.
//
// Fixes the old bar chart's faults: adherence is binary, so every segment is
// the SAME size and only its fill changes; green = held, red = broke; every
// calendar day is present (non-trading days tinted, no gaps); the percentage
// always shows its referent; and which rule broke is the headline, not a
// footnote.
// ─────────────────────────────────────────────────────────────────────────────

export interface AdherenceDay { date: string; traded: boolean; held: boolean; breaches: { id: string; label: string }[]; }
export interface AdherenceRule { id: string; label: string; breaches: number; }
export interface AdherenceData {
  monthLabel: string;
  days: AdherenceDay[];
  rules: AdherenceRule[];
  summary: { tradingDays: number; cleanDays: number; brokenDays: number; breaches: number; adherence: number; currentStreak: number; bestStreak: number; };
  callout: { text: string; detail: string } | null;
}

const GREEN = 'var(--green)';
const RED = '#FF453A';
const RED_TEXT = '#FF7B6E';
const RED_BAR = '#C0392B';
const EMPTY = 'rgba(255,255,255,0.055)';

const STYLE = `
@keyframes ra-seg { from { transform: scaleY(0.3); } to { transform: scaleY(1); } }
@keyframes ra-bar { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.ra-seg { transform-origin: bottom; animation: ra-seg 400ms cubic-bezier(.2,.7,.2,1) both; transition: opacity .15s ease; border:0; padding:0; cursor:pointer; }
.ra-seg:focus { outline:none; }
.ra-seg:focus-visible { outline:2px solid var(--amber); outline-offset:2px; }
.ra-seg:hover { opacity:1 !important; }
.ra-barfill { transform-origin: left; animation: ra-bar 500ms cubic-bezier(.2,.7,.2,1) both; }
.ra-rule { border:0; background:none; width:100%; text-align:left; cursor:pointer; padding:11px 0; border-top:1px solid rgba(255,255,255,0.05); }
.ra-rule:first-of-type { border-top:0; }
.ra-rule:focus-visible { outline:2px solid var(--amber); outline-offset:2px; border-radius:3px; }
@media (prefers-reduced-motion: reduce) {
  .ra-seg { animation:none; transform:none; }
  .ra-barfill { animation:none; transform:none; }
}
`;

// Count a number up over `ms`, respecting reduced motion (jumps to target).
function useCountUp(target: number, ms: number): number {
  const [v, setV] = useState(target);
  const prefersReduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (prefersReduced) { setV(target); return; }
    let raf = 0, start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, prefersReduced]);
  return v;
}

const mono = 'var(--font-mono)';
const microLabel: CSSProperties = { fontFamily: mono, fontSize: 9.5, letterSpacing: '1.6px', textTransform: 'uppercase', color: 'var(--app-text-muted)' };

function segFill(day: AdherenceDay): { bg: string; opacity: number } {
  if (!day.traded) return { bg: EMPTY, opacity: 1 };
  if (day.held) return { bg: GREEN, opacity: 0.85 };
  // Magnitude only via opacity — never width/height. 2+ breaks = full red.
  return { bg: RED, opacity: day.breaches.length >= 2 ? 1 : 0.7 };
}

function Counter({ value, label, color }: { value: number; label: string; color: string }) {
  const shown = useCountUp(value, 800);
  return (
    <div style={{ background: 'var(--app-panel)', padding: '13px 15px' }}>
      <div style={{ fontFamily: mono, fontSize: 20, letterSpacing: '-0.5px', color, lineHeight: 1 }}>{shown}</div>
      <div style={{ fontFamily: mono, fontSize: 9.5, textTransform: 'uppercase', color: 'var(--app-text-muted)', marginTop: 6 }}>{label}</div>
    </div>
  );
}

export default function RuleAdherenceCard({ data, onSelectDay, onSelectRule }: {
  data: AdherenceData | null;
  onSelectDay?: (date: string) => void;
  onSelectRule?: (ruleId: string) => void;
}) {
  const card: CSSProperties = { background: 'var(--app-panel)', border: '1px solid var(--app-border)', borderRadius: 12, padding: '18px 18px 18px' };

  if (!data || data.summary.tradingDays === 0) {
    return (
      <section style={card}>
        <p style={microLabel}>Plan adherence</p>
        <p style={{ margin: '14px 0 2px', fontSize: 12, color: 'var(--app-text-subtle)' }}>No day-level rule checks yet, set rules in the Rules page.</p>
      </section>
    );
  }

  const { summary, days, rules, callout } = data;
  const pct = Math.round(summary.adherence * 100);
  const firstDay = days[0]?.date.slice(-2).replace(/^0/, '');
  const midDay = days[Math.floor(days.length / 2)]?.date.slice(-2).replace(/^0/, '');
  const lastDay = days[days.length - 1]?.date.slice(-2).replace(/^0/, '');
  const maxBreach = Math.max(1, ...rules.map(r => r.breaches));

  return (
    <section style={card}>
      <style>{STYLE}</style>

      {/* 1 · Header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: callout ? 13 : 15 }}>
        <span style={{ ...microLabel }}>Plan adherence · {data.monthLabel}</span>
        <span style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--app-text-subtle)', whiteSpace: 'nowrap' }}>
          {pct}% · {summary.cleanDays} of {summary.tradingDays}
        </span>
      </div>

      {/* 5 · Callout (only when a real pattern exists) */}
      {callout && (
        <div style={{ background: 'var(--app-panel-strong)', borderLeft: '2px solid var(--amber)', borderRadius: '0 8px 8px 0', padding: '14px 16px', marginBottom: 15 }}>
          <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--app-text)' }}>{callout.text}</p>
          <p style={{ margin: '5px 0 0', fontSize: 12.5, color: 'var(--app-text-muted)', lineHeight: 1.5 }}>{callout.detail}</p>
        </div>
      )}

      {/* 2 · Ribbon */}
      <div style={{ display: 'flex', gap: 2, height: 34 }}>
        {days.map((day, i) => {
          const { bg, opacity } = segFill(day);
          const label = `${day.date} · ${!day.traded ? 'no trades' : day.held ? 'all rules held' : `broke ${day.breaches.map(b => b.label).join(', ')}`}`;
          return (
            <button
              key={day.date}
              type="button"
              className="ra-seg"
              title={label}
              aria-label={label}
              onClick={() => day.traded && onSelectDay?.(day.date)}
              style={{ flex: 1, borderRadius: 2, background: bg, opacity, animationDelay: `${i * 12}ms` }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ fontFamily: mono, fontSize: 9.5, color: 'var(--app-text-subtle)' }}>{firstDay}</span>
        <span style={{ fontFamily: mono, fontSize: 9.5, color: 'var(--app-text-subtle)' }}>{midDay}</span>
        <span style={{ fontFamily: mono, fontSize: 9.5, color: 'var(--app-text-subtle)' }}>{lastDay}</span>
      </div>

      {/* 3 · Streak counters */}
      <div style={{ display: 'flex', gap: 1, background: 'var(--app-border)', border: '1px solid var(--app-border)', borderRadius: 9, overflow: 'hidden', marginTop: 16 }}>
        <div style={{ flex: 1 }}><Counter value={summary.currentStreak} label="Current streak" color={GREEN} /></div>
        <div style={{ flex: 1 }}><Counter value={summary.bestStreak} label="Best streak" color={GREEN} /></div>
        <div style={{ flex: 1 }}><Counter value={summary.brokenDays} label="Broken days" color={RED_TEXT} /></div>
      </div>

      {/* 4 · Rule breakdown */}
      <div style={{ marginTop: 18 }}>
        <p style={{ ...microLabel, marginBottom: 4 }}>Breaches by rule · {summary.breaches} total</p>
        {rules.map((rule, i) => {
          const zero = rule.breaches === 0;
          return (
            <button key={rule.id} type="button" className="ra-rule" onClick={() => onSelectRule?.(rule.id)} aria-label={`${rule.label}: ${rule.breaches} breach${rule.breaches === 1 ? '' : 'es'}`}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 46px', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--app-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rule.label}</span>
                <span style={{ fontFamily: mono, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: zero ? GREEN : RED_TEXT }}>{rule.breaches}</span>
              </div>
              <div style={{ height: 3, borderRadius: 3, background: 'rgba(255,255,255,0.06)', marginTop: 8, overflow: 'hidden' }}>
                <div className="ra-barfill" style={{ height: '100%', borderRadius: 3, width: `${zero ? 100 : (rule.breaches / maxBreach) * 100}%`, background: zero ? GREEN : RED_BAR, animationDelay: `${i * 60}ms` }} />
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
