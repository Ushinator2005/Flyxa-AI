import { MessageSquare } from 'lucide-react';
import type { Rival } from '../../types/rivals.js';
import { compareMetric, getMascotLabel } from '../../lib/mascotProgression.js';

interface RivalsListProps {
  rivals: Rival[];
  currentUser: Rival;
  onOpenChat?: (rival: Rival) => void;
}

const STAGE_LABELS: Record<string, string> = {
  seed: 'Seed',
  rookie: 'Rookie',
  veteran: 'Veteran',
  elite: 'Elite',
  apex: 'Apex',
};

function getMetricVal(rival: Rival, key: 'dailyJournal' | 'tradingJournal' | 'backtest' | 'processScore'): number {
  switch (key) {
    case 'dailyJournal':
      return rival.mascot.stats.dailyJournalScore;
    case 'tradingJournal':
      return rival.mascot.stats.tradingJournalScore;
    case 'backtest':
      return rival.mascot.stats.backtestSessions;
    case 'processScore':
      return rival.mascot.stats.processScore;
  }
}

function valueClass(mine: number, theirs: number): 'delta-win' | 'delta-lose' | 'delta-even' {
  const result = compareMetric(mine, theirs);
  if (result === 'winning') return 'delta-win';
  if (result === 'losing') return 'delta-lose';
  return 'delta-even';
}

export default function RivalsList({ rivals, currentUser, onOpenChat }: RivalsListProps) {
  const ordered = [...rivals].sort((a, b) => {
    if (a.isMe) return -1;
    if (b.isMe) return 1;
    return b.mascot.stats.processScore - a.mascot.stats.processScore;
  });

  return (
    <div className="rv-card">
      <div className="rv-section-head">
        <div>
          <div className="rv-section-kicker">Head-to-Head</div>
          <div className="rv-section-title">Your rivals</div>
        </div>
      </div>

      <div className="rv-table-head">
        <span>Rival</span>
        <span className="align-r">Daily</span>
        <span className="align-r">Trading</span>
        <span className="align-r">Backtests</span>
        <span className="align-r">Process</span>
        <span className="align-r">Action</span>
      </div>

      {ordered.map(rival => {
        const isMe = Boolean(rival.isMe);
        const dailyJournal = getMetricVal(rival, 'dailyJournal');
        const tradingJournal = getMetricVal(rival, 'tradingJournal');
        const backtest = getMetricVal(rival, 'backtest');
        const processScore = getMetricVal(rival, 'processScore');

        return (
          <div key={rival.id} className={`rv-row ${isMe ? 'me' : ''}`}>
            <div className="rv-rival">
              <div
                className="rv-avatar"
                style={{
                  background: `${rival.avatarColor}14`,
                  border: `1px solid ${rival.avatarColor}38`,
                  color: rival.avatarColor,
                }}
              >
                {rival.avatarUrl ? <img src={rival.avatarUrl} alt="" /> : rival.avatarInitials}
              </div>
              <div className="rv-name">
                <h4 className={isMe ? 'is-me' : undefined}>{rival.displayName}</h4>
                <p>
                  @{rival.username} | {STAGE_LABELS[rival.mascot.stage] ?? getMascotLabel(rival.mascot.stage)}
                </p>
              </div>
            </div>

            <div className="rv-cell delta-even">{dailyJournal}</div>
            <div className="rv-cell delta-even">{tradingJournal}%</div>
            <div className="rv-cell delta-even">{backtest}</div>
            <div className="rv-cell delta-even">{processScore}</div>

            <div className="rv-action">
              {!isMe && rival.userId && onOpenChat && (
                <button
                  className="rv-chat-btn"
                  onClick={() => onOpenChat(rival)}
                  title={`Message ${rival.displayName}`}
                >
                  <MessageSquare size={13} />
                </button>
              )}
              <span className={`rv-badge ${isMe ? 'me' : ''}`}>{isMe ? 'YOU' : 'VS'}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}



