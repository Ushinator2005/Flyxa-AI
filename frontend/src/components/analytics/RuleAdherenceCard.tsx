import { CSSProperties } from 'react';

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
.ra-rule { border:0; background:none; width:100%; text-align:left; cursor:pointer; padding:7px 0; border-top:1px solid rgba(255,255,255,0.05); }
.ra-rule:first-of-type { border-top:0; }
.ra-rule:focus-visible { outline:2px solid var(--amber); outline-offset:2px; border-radius:3px; }
@media (prefers-reduced-motion: reduce) {
  .ra-seg { animation:none; transform:none; }
  .ra-barfill { animation:none; transform:none; }
}
`;

const mono = 'var(--font-mono)';
// Sentence-case, sans. Numbers below wear mono; labels do not shout.
const microLabel: CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--app-text-muted)' };

function segFill(day: AdherenceDay): { bg: string; opacity: number } {
  if (!day.traded) return { bg: EMPTY, opacity: 1 };
  if (day.held) return { bg: GREEN, opacity: 0.85 };
  // Magnitude only via opacity — never width/height. 2+ breaks = full red.
  return { bg: RED, opacity: day.breaches.length >= 2 ? 1 : 0.7 };
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

  const { summary, days, rules } = data;
  const pct = Math.round(summary.adherence * 100);
  const firstDay = days[0]?.date.slice(-2).replace(/^0/, '');
  const midDay = days[Math.floor(days.length / 2)]?.date.slice(-2).replace(/^0/, '');
  const lastDay = days[days.length - 1]?.date.slice(-2).replace(/^0/, '');

  // Split ranked breach rows from the rules that were never broken — the latter
  // collapse to one muted line instead of a full green bar each.
  const breached = rules.filter(r => r.breaches > 0);
  const clean = rules.filter(r => r.breaches === 0);
  const maxBreach = Math.max(1, ...breached.map(r => r.breaches));
  // "More than the other N combined" — a note on the top row when it dominates,
  // replacing the old callout that duplicated that same first row.
  const topNote = breached[0] && breached[0].breaches > summary.breaches - breached[0].breaches && rules.length > 1
    ? `More than the other ${rules.length - 1} combined`
    : null;

  return (
    <section style={card}>
      <style>{STYLE}</style>

      {/* 1 · Header — label left; percentage + streak numbers fold in on the right */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <span style={{ ...microLabel }}>Plan adherence · {data.monthLabel}</span>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: mono, fontSize: 11, color: 'var(--app-text)', whiteSpace: 'nowrap' }}>
            {pct}% · {summary.cleanDays} of {summary.tradingDays}
          </div>
          <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--app-text-muted)', whiteSpace: 'nowrap', marginTop: 3 }}>
            streak <span style={{ color: GREEN }}>{summary.currentStreak}</span> · best <span style={{ color: GREEN }}>{summary.bestStreak}</span> · <span style={{ color: RED_TEXT }}>{summary.brokenDays}</span> broken
          </div>
        </div>
      </div>

      {/* 2 · Ribbon — thin ticks; clusters read fine at a fraction of the height */}
      <div style={{ display: 'flex', gap: 2, height: 8 }}>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--app-text-muted)' }}>{firstDay}</span>
        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--app-text-muted)' }}>{midDay}</span>
        <span style={{ fontFamily: mono, fontSize: 10, color: 'var(--app-text-muted)' }}>{lastDay}</span>
      </div>

      {/* 3 · Ranked breach rows — count on the label line, thin 3px bar */}
      <div style={{ marginTop: 16 }}>
        <p style={{ ...microLabel, marginBottom: 2 }}>Breaches by rule · {summary.breaches} total</p>
        {breached.map((rule, i) => (
          <button key={rule.id} type="button" className="ra-rule" onClick={() => onSelectRule?.(rule.id)} aria-label={`${rule.label}: ${rule.breaches} breach${rule.breaches === 1 ? '' : 'es'}`}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 34px', alignItems: 'baseline', gap: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--app-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {rule.label}
                {i === 0 && topNote && <span style={{ fontSize: 10.5, fontWeight: 400, color: 'var(--app-text-muted)', marginLeft: 8 }}>{topNote}</span>}
              </span>
              <span style={{ fontFamily: mono, fontSize: 12.5, fontVariantNumeric: 'tabular-nums', textAlign: 'right', color: RED_TEXT }}>{rule.breaches}</span>
            </div>
            <div style={{ height: 3, borderRadius: 3, background: 'rgba(255,255,255,0.06)', marginTop: 6, overflow: 'hidden' }}>
              <div className="ra-barfill" style={{ height: '100%', borderRadius: 3, width: `${(rule.breaches / maxBreach) * 100}%`, background: RED_BAR, animationDelay: `${i * 60}ms` }} />
            </div>
          </button>
        ))}
        {clean.length > 0 && (
          <p style={{ margin: '10px 0 0', fontSize: 11.5, color: 'var(--app-text-muted)', lineHeight: 1.5 }}>
            <span style={{ color: GREEN }}>{clean.length} rule{clean.length === 1 ? '' : 's'} unbroken</span>
            {' · '}{clean.map(r => r.label).join(', ')}
          </p>
        )}
      </div>
    </section>
  );
}
