import { useState } from 'react';
import type { Rival } from '../../types/rivals.js';
import { getRivalMetricValue } from '../../lib/mascotProgression.js';
import type { LeaderboardMetric } from '../../types/rivals.js';

interface LeaderboardProps {
  rivals: Rival[];
  currentUserId: string;
  defaultMetric?: LeaderboardMetric;
}

type CompMetric = 'processScore' | 'dailyJournal' | 'tradingJournal' | 'backtest';
type SortDir = 'desc' | 'asc';

const COLS: { key: CompMetric; label: string; unit: string }[] = [
  { key: 'processScore',   label: 'Process',  unit: 'pts' },
  { key: 'dailyJournal',   label: 'Daily J',  unit: 'pts' },
  { key: 'tradingJournal', label: 'Trade J',  unit: '%'   },
  { key: 'backtest',       label: 'Tests',    unit: ''    },
];

const STAGE_LABELS: Record<string, string> = {
  seed: 'Seed', rookie: 'Rookie', veteran: 'Veteran', elite: 'Elite', apex: 'Apex',
};

function rankClass(rank: number): string {
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3) return 'bronze';
  return 'regular';
}

function metricColor(key: CompMetric, value: number): string {
  if (key === 'processScore') {
    if (value >= 75) return 'var(--rv-green)';
    if (value >= 50) return 'var(--rv-amber)';
    return 'var(--rv-text-2)';
  }
  if (key === 'tradingJournal') {
    if (value >= 80) return 'var(--rv-green)';
    if (value >= 50) return 'var(--rv-amber)';
    return 'var(--rv-text-2)';
  }
  if (key === 'dailyJournal') {
    if (value >= 70) return 'var(--rv-blue)';
    if (value >= 40) return 'var(--rv-text-2)';
    return 'var(--rv-text-3)';
  }
  // backtest — just neutral
  return value > 0 ? 'var(--rv-text-2)' : 'var(--rv-text-3)';
}

export default function Leaderboard({ rivals, currentUserId, defaultMetric }: LeaderboardProps) {
  const initSort: CompMetric =
    (defaultMetric === 'dailyJournal' || defaultMetric === 'tradingJournal' ||
     defaultMetric === 'backtest'     || defaultMetric === 'processScore')
      ? defaultMetric
      : 'processScore';

  const [sortBy,  setSortBy]  = useState<CompMetric>(initSort);
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const me = rivals.find(r => r.isMe || r.id === currentUserId);
  const myWinRate = me?.mascot.stats.winRate ?? null;
  const myAvgR    = me?.mascot.stats.avgR    ?? null;
  const hasMyStats = myWinRate != null || myAvgR != null;

  const sorted = [...rivals].sort((a, b) => {
    const av = getRivalMetricValue(a, sortBy);
    const bv = getRivalMetricValue(b, sortBy);
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  function handleColClick(col: CompMetric) {
    if (sortBy === col) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  }

  return (
    <div className="rv-card">
      {/* Header */}
      <div className="rv-section-head" style={{ borderBottom: 'none' }}>
        <div>
          <div className="rv-section-kicker">Competitive Board</div>
          <div className="rv-section-title">Friend leaderboard</div>
        </div>
      </div>

      {/* Column headers */}
      <div className="rv-comp-head">
        <span />
        <span />
        <span className="rv-comp-col-label" style={{ textAlign: 'left' }}>Trader</span>
        {COLS.map(col => (
          <button
            key={col.key}
            type="button"
            className={`rv-comp-col-btn ${sortBy === col.key ? 'active' : ''}`}
            onClick={() => handleColClick(col.key)}
          >
            {col.label}
            {sortBy === col.key && (
              <span className="rv-sort-arrow">{sortDir === 'desc' ? ' ↓' : ' ↑'}</span>
            )}
          </button>
        ))}
      </div>

      {/* Rows */}
      {sorted.map((rival, idx) => {
        const isMe = rival.isMe || rival.id === currentUserId;
        const rank = idx + 1;

        return (
          <div key={rival.id} className={`rv-comp-row rank-${rank} ${isMe ? 'me' : ''}`}>
            <span className={`rv-rank ${rankClass(rank)}`}>
              {String(rank).padStart(2, '0')}
            </span>
            <span
              className="rv-avatar"
              style={{
                width: 28, height: 28, borderRadius: 8,
                fontSize: 9,
                background: `${rival.avatarColor}14`,
                border: `1px solid ${rival.avatarColor}38`,
                color: rival.avatarColor,
              }}
            >
              {rival.avatarUrl ? <img src={rival.avatarUrl} alt="" /> : rival.avatarInitials}
            </span>
            <span className="rv-name">
              <h4 className={isMe ? 'is-me' : undefined}>{rival.displayName}</h4>
              <p>{STAGE_LABELS[rival.mascot.stage] ?? rival.mascot.stage}</p>
            </span>
            {COLS.map(col => {
              const value = getRivalMetricValue(rival, col.key);
              const isSort = sortBy === col.key;
              return (
                <span
                  key={col.key}
                  className={`rv-comp-cell ${isSort ? 'sorted' : ''}`}
                  style={{ color: isMe ? 'var(--rv-blue)' : metricColor(col.key, value) }}
                >
                  <strong>{value}{col.unit === '%' ? '%' : ''}</strong>
                  {col.unit && col.unit !== '%' && <small>{col.unit}</small>}
                </span>
              );
            })}
          </div>
        );
      })}

      {/* My Trading Stats — private footer */}
      {hasMyStats && (
        <div className="rv-my-stats">
          <span className="rv-my-stats-kicker">Your trading stats · private</span>
          <div className="rv-my-stats-row">
            {myWinRate != null && (
              <div className="rv-my-stat">
                <span>Win Rate</span>
                <strong style={{ color: myWinRate >= 50 ? 'var(--rv-green)' : 'var(--rv-red)' }}>
                  {myWinRate}%
                </strong>
              </div>
            )}
            {myAvgR != null && (
              <div className="rv-my-stat">
                <span>Avg R</span>
                <strong style={{ color: myAvgR >= 0 ? 'var(--rv-green)' : 'var(--rv-red)' }}>
                  {myAvgR >= 0 ? '+' : ''}{myAvgR.toFixed(2)}R
                </strong>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
