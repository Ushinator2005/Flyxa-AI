import { Flame } from 'lucide-react';

// The Daily Journal fire-streak visual — a tier-coloured flame inside a
// progress ring that fills toward the next milestone. Shared so the Journal
// and Rules pages show the exact same streak.
export default function StreakFlame({ streak, size = 46 }: { streak: number; size?: number }) {
  const flameStroke = streak >= 30 ? '#a855f7'
    : streak >= 14 ? '#ef4444'
    : streak >= 7 ? '#f97316'
    : streak >= 3 ? '#fb923c'
    : streak >= 1 ? '#f59e0b'
    : '#6b7280';
  const flameFill = streak >= 30 ? '#c084fc'
    : streak >= 14 ? '#f87171'
    : streak >= 7 ? '#fdba74'
    : streak >= 3 ? '#fed7aa'
    : streak >= 1 ? '#fde68a'
    : '#374151';
  const tierName = streak >= 30 ? 'Legend'
    : streak >= 14 ? 'Inferno'
    : streak >= 7 ? 'Blazing'
    : streak >= 3 ? 'On Fire'
    : streak >= 1 ? 'Warming Up'
    : 'Start Today';

  const prevMilestone = streak >= 30 ? 30 : streak >= 14 ? 14 : streak >= 7 ? 7 : streak >= 3 ? 3 : 0;
  const nextMilestone = streak >= 30 ? null : streak >= 14 ? 30 : streak >= 7 ? 14 : streak >= 3 ? 7 : 3;
  const arcProgress = nextMilestone === null ? 1 : (streak - prevMilestone) / (nextMilestone - prevMilestone);
  const R = (size - 8) / 2;
  const circ = 2 * Math.PI * R;
  const tooltip = nextMilestone
    ? `${tierName} · ${nextMilestone - streak} day${nextMilestone - streak === 1 ? '' : 's'} to next tier`
    : `${tierName} · Max streak reached`;

  return (
    <div title={tooltip} style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
      <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
        <svg width={size} height={size} style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}>
          <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--color-border)" strokeWidth={2.5} />
          {arcProgress > 0 && (
            <circle
              cx={size / 2} cy={size / 2} r={R}
              fill="none" stroke={flameStroke} strokeWidth={2.5} strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={circ * (1 - arcProgress)}
            />
          )}
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Flame size={Math.round(size * 0.48)} color={flameStroke} fill={flameFill} fillOpacity={0.9} strokeWidth={1.6} />
        </div>
      </div>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: flameStroke, opacity: streak > 0 ? 0.85 : 0.4, lineHeight: 1 }}>{tierName}</span>
        <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--app-text)', lineHeight: 1, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
          {streak}{' '}
          <span style={{ fontWeight: 500, fontSize: 13, color: 'var(--app-text-muted)', letterSpacing: 0 }}>{streak === 1 ? 'Day' : 'Days'}</span>
        </span>
      </span>
    </div>
  );
}
