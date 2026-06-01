import { useState } from 'react';
import type { LeaderboardMetric, Rival } from '../../types/rivals.js';
import { getRivalMetricValue, rivalHasMetricData } from '../../lib/mascotProgression.js';

interface LeaderboardProps {
  rivals: Rival[];
  currentUserId: string;
  defaultMetric?: LeaderboardMetric;
}

const STAGE_LABELS: Record<string, string> = {
  seed: 'Seed',
  rookie: 'Rookie',
  veteran: 'Veteran',
  elite: 'Elite',
  apex: 'Apex',
};

const TABS: { key: LeaderboardMetric; label: string; unit: string; performanceOnly?: boolean }[] = [
  { key: 'processScore', label: 'Process', unit: 'pts' },
  { key: 'dailyJournal', label: 'Daily Journal', unit: 'pts' },
  { key: 'tradingJournal', label: 'Trade Journal', unit: '%' },
  { key: 'backtest', label: 'Backtesting', unit: 'sess' },
  { key: 'winRate', label: 'Win Rate', unit: '%', performanceOnly: true },
  { key: 'avgR', label: 'Avg R', unit: 'R', performanceOnly: true },
];

const PERFORMANCE_METRICS = new Set<LeaderboardMetric>(['winRate', 'avgR']);

function rankClass(rank: number) {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return 'regular';
}

function barColor(rank: number, isMe: boolean, avatarColor: string) {
  if (isMe) return 'var(--rv-blue)';
  if (rank === 1) return 'var(--rv-gold)';
  if (rank === 2) return 'var(--rv-silver)';
  if (rank === 3) return 'var(--rv-bronze)';
  return avatarColor;
}

function formatValue(value: number, metric: LeaderboardMetric): string {
  if (metric === 'avgR') return value.toFixed(2);
  return String(value);
}

export default function Leaderboard({ rivals, currentUserId, defaultMetric = 'processScore' }: LeaderboardProps) {
  const [metric, setMetric] = useState<LeaderboardMetric>(defaultMetric);
  const activeTab = TABS.find(tab => tab.key === metric) ?? TABS[0];
  const isPerformanceMetric = PERFORMANCE_METRICS.has(metric);

  // For performance metrics, sort: rivals with data first (by value), then no-data rivals.
  const sorted = [...rivals].sort((a, b) => {
    const aHas = rivalHasMetricData(a, metric);
    const bHas = rivalHasMetricData(b, metric);
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    return getRivalMetricValue(b, metric) - getRivalMetricValue(a, metric);
  });

  const maxVal = Math.max(
    ...sorted.filter(r => rivalHasMetricData(r, metric)).map(r => Math.max(0, getRivalMetricValue(r, metric))),
    1,
  );

  return (
    <div className="rv-card">
      <div className="rv-section-head" style={{ borderBottom: 'none' }}>
        <div>
          <div className="rv-section-kicker">Competitive Board</div>
          <div className="rv-section-title">Friend leaderboard</div>
        </div>
      </div>

      <div className="rv-tabs">
        {TABS.map(tab => (
          <button
            key={tab.key}
            type="button"
            className={`rv-tab ${metric === tab.key ? 'active' : ''}`}
            onClick={() => setMetric(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isPerformanceMetric && (
        <p style={{ fontSize: 10, color: 'var(--rv-text-3)', padding: '0 12px 8px', margin: 0, fontStyle: 'italic' }}>
          Trading data is private — only your stats are shown for rivals.
        </p>
      )}

      {sorted.map((rival, index) => {
        const isMe = rival.id === currentUserId || rival.isMe;
        const hasData = rivalHasMetricData(rival, metric);
        const value = getRivalMetricValue(rival, metric);
        const barPct = hasData ? Math.max(2, Math.round((Math.max(0, value) / maxVal) * 100)) : 0;
        const rank = index + 1;

        return (
          <div key={rival.id} className={`rv-lb-row ${isMe ? 'me' : ''}`}>
            <span className={`rv-rank ${rankClass(rank)}`}>{String(rank).padStart(2, '0')}</span>
            <span
              className="rv-avatar"
              style={{
                width: 30,
                height: 30,
                borderRadius: 9,
                background: `${rival.avatarColor}14`,
                border: `1px solid ${rival.avatarColor}38`,
                color: rival.avatarColor,
              }}
            >
              {rival.avatarInitials}
            </span>
            <span className="rv-name">
              <h4 className={isMe ? 'is-me' : undefined}>{rival.displayName}</h4>
              <p>{STAGE_LABELS[rival.mascot.stage]}</p>
            </span>
            <span className="rv-progress">
              {hasData
                ? <span style={{ width: `${barPct}%`, background: barColor(rank, Boolean(isMe), rival.avatarColor) }} />
                : <span style={{ width: '100%', background: 'rgba(255,255,255,0.04)', borderRadius: 2 }} />
              }
            </span>
            <span className="rv-value">
              {hasData ? (
                <>
                  <strong className={isMe ? 'is-me' : undefined}>{formatValue(value, metric)}</strong>
                  <small>{activeTab.unit}</small>
                </>
              ) : (
                <strong style={{ color: 'var(--rv-text-3)', fontSize: 11 }}>—</strong>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
