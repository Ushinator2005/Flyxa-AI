import type { Rival } from '../../types/rivals.js';
import { compareMetric, getMascotLabel } from '../../lib/mascotProgression.js';

interface RivalCardProps {
  rival: Rival;
  currentUser: Rival;
  isLast?: boolean;
}

const COMPARE_COLOR = {
  winning: '#4ade80',
  losing: '#f87171',
  tied: '#fbbf24',
};

interface Metric {
  label: string;
  myVal: number;
  theirVal: number;
}

export default function RivalCard({ rival, currentUser, isLast }: RivalCardProps) {
  const metrics: Metric[] = [
    { label: 'Daily', myVal: currentUser.mascot.stats.dailyJournalScore, theirVal: rival.mascot.stats.dailyJournalScore },
    { label: 'Trading', myVal: currentUser.mascot.stats.tradingJournalScore, theirVal: rival.mascot.stats.tradingJournalScore },
    { label: 'Backtests', myVal: currentUser.mascot.stats.backtestSessions, theirVal: rival.mascot.stats.backtestSessions },
    { label: 'Process', myVal: currentUser.mascot.stats.processScore, theirVal: rival.mascot.stats.processScore },
  ];

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 18px',
        borderBottom: isLast ? 'none' : '1px solid rgba(255,255,255,0.05)',
      }}
    >
      {/* Avatar */}
      <div
        style={{
          flexShrink: 0,
          width: 38,
          height: 38,
          borderRadius: '50%',
          background: `${rival.avatarColor}18`,
          border: `1.5px solid ${rival.avatarColor}55`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'DM Mono', monospace",
          fontSize: 11,
          fontWeight: 500,
          color: rival.avatarColor,
          letterSpacing: '0.04em',
          overflow: 'hidden',
        }}
      >
        {rival.avatarUrl ? (
          <img src={rival.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : rival.avatarInitials}
      </div>

      {/* Info */}
      <div style={{ flex: '0 0 auto', minWidth: 100 }}>
        <div
          style={{
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 13,
            fontWeight: 600,
            color: rival.isMe ? '#4d8ef7' : '#e2e8f0',
            marginBottom: 2,
          }}
        >
          {rival.displayName}
        </div>
        <div
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 10,
            color: 'rgba(148,163,184,0.55)',
            letterSpacing: '0.04em',
          }}
        >
          @{rival.username} · {getMascotLabel(rival.mascot.stage)}
        </div>
      </div>

      {/* Metrics */}
      <div style={{ display: 'flex', gap: 18, flex: 1, justifyContent: 'flex-end' }}>
        {metrics.map(m => {
          const result = rival.isMe ? 'tied' : compareMetric(m.myVal, m.theirVal);
          const color = rival.isMe ? 'rgba(148,163,184,0.7)' : COMPARE_COLOR[result];
          return (
            <div key={m.label} style={{ textAlign: 'center' }}>
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 13,
                  fontWeight: 500,
                  color,
                  lineHeight: 1.1,
                  marginBottom: 2,
                }}
              >
                {m.theirVal}
              </div>
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: 'rgba(148,163,184,0.40)',
                }}
              >
                {m.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* VS badge */}
      <div
        style={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: rival.isMe ? 'rgba(29,110,245,0.12)' : 'rgba(255,255,255,0.04)',
          border: rival.isMe ? '1px solid rgba(29,110,245,0.30)' : '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'DM Mono', monospace",
          fontSize: 8,
          fontWeight: 500,
          color: rival.isMe ? '#4d8ef7' : 'rgba(148,163,184,0.45)',
          letterSpacing: '0.05em',
        }}
      >
        {rival.isMe ? 'YOU' : 'VS'}
      </div>
    </div>
  );
}
