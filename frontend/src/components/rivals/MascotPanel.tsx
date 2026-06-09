import type { Mascot, MascotStage } from '../../types/rivals.js';
import { getMascotHealth, getMascotLabel, getStageProgress } from '../../lib/mascotProgression.js';
import MascotCharacter from './MascotCharacter.js';

interface MascotPanelProps {
  mascot: Mascot;
  lastJournalDate?: string;
}

const STAGE_ORDER: MascotStage[] = ['seed', 'rookie', 'veteran', 'elite', 'apex'];

const STAGE_SYMBOL: Record<MascotStage, string> = {
  seed: 'S',
  rookie: 'R',
  veteran: 'V',
  elite: 'E',
  apex: 'A',
};

const STAT_BARS = [
  { key: 'dailyJournalScore' as const, label: 'Daily Journal', color: '#1E6FFF', max: 100, suffix: '/100' },
  { key: 'tradingJournalScore' as const, label: 'Trading Journal', color: '#f59e0b', max: 100, suffix: '%' },
  { key: 'backtestSessions' as const, label: 'Backtesting Sessions', color: '#14b8a6', max: 50, suffix: '' },
  { key: 'processScore' as const, label: 'Process Score', color: '#a78bfa', max: 100, suffix: '/100' },
];

const HEALTH_BADGE: Record<string, { dot: string; label: string }> = {
  healthy: { dot: '#22c55e', label: 'Healthy' },
  tired: { dot: '#f59e0b', label: 'Needs journal today' },
  sick: { dot: '#f97316', label: 'Momentum fading' },
  critical: { dot: '#ef4444', label: 'Streak broken' },
};

const S1 = 'var(--app-panel)';
const BORDER = 'var(--app-border)';
const BSUB = 'rgba(255,255,255,0.04)';
const T1 = 'var(--app-text)';
const T2 = 'var(--app-text-muted)';
const T3 = 'var(--app-text-subtle)';
const MONO = 'var(--font-mono)';
const SANS = 'var(--font-sans)';

const labelStyle = {
  fontFamily: SANS,
  fontSize: 11,
  fontWeight: 500,
  color: T3,
};

export default function MascotPanel({ mascot, lastJournalDate }: MascotPanelProps) {
  const today = new Date().toISOString().split('T')[0];
  const journalDate = lastJournalDate ?? today;
  const health = getMascotHealth(mascot.streakDays, journalDate);
  const { current, next, progressPct } = getStageProgress(mascot.stats.processScore);
  const healthBadge = HEALTH_BADGE[health];

  return (
    <div
      style={{
        background: S1,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${BSUB}` }}>
        <div style={{ ...labelStyle, marginBottom: 5 }}>Your Mascot</div>
        <div style={{ fontSize: 16, color: T1, fontWeight: 600, marginBottom: 4, fontFamily: SANS }}>
          {mascot.name}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: '#6ea8fe', letterSpacing: '0.08em', marginBottom: 10 }}>
          {getMascotLabel(mascot.stage)}
        </div>

        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 9px',
            borderRadius: 999,
            background: `${healthBadge.dot}14`,
            border: `1px solid ${healthBadge.dot}35`,
          }}
        >
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: healthBadge.dot, flexShrink: 0 }} />
          <span style={{ fontFamily: MONO, fontSize: 10, color: healthBadge.dot }}>{healthBadge.label}</span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '18px 16px 14px',
          borderBottom: `1px solid ${BSUB}`,
        }}
      >
        <MascotCharacter stage={mascot.stage} health={health} size={150} />

        <div
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 12px',
            borderRadius: 999,
            background: 'rgba(245,158,11,0.10)',
            border: '1px solid rgba(245,158,11,0.22)',
          }}
        >
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 600, color: '#fbbf24', fontVariantNumeric: 'tabular-nums' }}>
            {mascot.streakDays}
          </span>
          <span style={{ fontSize: 11, color: T2 }}>day daily journal run</span>
        </div>
      </div>

      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${BSUB}` }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {STAT_BARS.map(bar => {
            const raw = mascot.stats[bar.key];
            const pct = Math.max(0, Math.min(100, Math.round((raw / bar.max) * 100)));
            return (
              <div key={bar.key}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                  <span style={labelStyle}>{bar.label}</span>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: 11,
                      color: bar.color,
                      fontWeight: 500,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {raw}{bar.suffix}
                  </span>
                </div>
                <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${pct}%`,
                      background: bar.color,
                      borderRadius: 999,
                      transition: 'width 0.35s ease',
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ padding: '14px 16px' }}>
        <div style={{ ...labelStyle, marginBottom: 10 }}>Stage Progression</div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              top: 13,
              left: 14,
              right: 14,
              height: 1,
              background: 'rgba(255,255,255,0.08)',
            }}
          />
          {STAGE_ORDER.map((stage, idx) => {
            const currentIdx = STAGE_ORDER.indexOf(current);
            const isPast = idx < currentIdx;
            const isCurrent = idx === currentIdx;
            const bg = isPast ? 'rgba(34,197,94,0.12)' : isCurrent ? 'rgba(30,111,255,0.12)' : 'rgba(255,255,255,0.03)';
            const border = isPast ? 'rgba(34,197,94,0.32)' : isCurrent ? 'rgba(30,111,255,0.42)' : 'rgba(255,255,255,0.08)';
            const textColor = isPast ? '#86efac' : isCurrent ? '#6ea8fe' : T3;

            return (
              <div key={stage} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, position: 'relative', zIndex: 1 }}>
                <div
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    background: bg,
                    border: `1px solid ${border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    color: textColor,
                    fontFamily: MONO,
                    fontWeight: 600,
                  }}
                >
                  {STAGE_SYMBOL[stage]}
                </div>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    color: textColor,
                    textAlign: 'center',
                  }}
                >
                  {stage}
                </span>
              </div>
            );
          })}
        </div>

        {next && (
          <div style={{ marginTop: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ ...labelStyle, fontSize: 9 }}>Progress to {next}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: '#6ea8fe', fontVariantNumeric: 'tabular-nums' }}>
                {progressPct}%
              </span>
            </div>
            <div style={{ height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${progressPct}%`,
                  background: '#1E6FFF',
                  borderRadius: 999,
                  transition: 'width 0.35s ease',
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
