import { useState } from 'react';
import type { LeaderboardMetric, Rival } from '../../types/rivals.js';
import { getRivalMetricValue } from '../../lib/mascotProgression.js';

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

const TABS: { key: LeaderboardMetric; label: string; unit: string }[] = [
  { key: 'processScore', label: 'Process Score', unit: 'pts' },
  { key: 'dailyJournal', label: 'Daily Journal', unit: 'days' },
  { key: 'tradingJournal', label: 'Trading Journal', unit: '%' },
  { key: 'backtest', label: 'Backtesting', unit: 'sessions' },
];

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

export default function Leaderboard({ rivals, currentUserId, defaultMetric = 'processScore' }: LeaderboardProps) {
  const [metric, setMetric] = useState<LeaderboardMetric>(defaultMetric);
  const activeTab = TABS.find(tab => tab.key === metric) ?? TABS[0];

  const sorted = [...rivals].sort((a, b) => getRivalMetricValue(b, metric) - getRivalMetricValue(a, metric));
  const maxVal = Math.max(...sorted.map(rival => getRivalMetricValue(rival, metric)), 1);

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

      {sorted.map((rival, index) => {
        const rank = index + 1;
        const value = getRivalMetricValue(rival, metric);
        const pct = Math.max(2, Math.round((value / maxVal) * 100));
        const isMe = rival.id === currentUserId || rival.isMe;
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
              <span style={{ width: `${pct}%`, background: barColor(rank, Boolean(isMe), rival.avatarColor) }} />
            </span>
            <span className="rv-value">
              <strong className={isMe ? 'is-me' : undefined}>{value}</strong>
              <small>{activeTab.unit}</small>
            </span>
          </div>
        );
      })}
    </div>
  );
}

