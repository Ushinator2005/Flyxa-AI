import { useState } from 'react';
import type { Mascot, MascotStage } from '../../types/rivals.js';
import { getStageProgress } from '../../lib/mascotProgression.js';
import MascotCharacter from './MascotCharacter.js';

interface MascotCardProps {
  mascot: Mascot;
}

const STAGES: MascotStage[] = ['seed', 'rookie', 'veteran', 'elite', 'apex'];

const STAGE_LABELS: Record<MascotStage, string> = {
  seed: 'Seed',
  rookie: 'Rookie',
  veteran: 'Veteran',
  elite: 'Elite',
  apex: 'Apex',
};

const BAR_META = [
  { key: 'dailyJournalScore' as const, label: 'Daily Journal', color: 'var(--rv-blue)', max: 100, suffix: '/100' },
  { key: 'tradingJournalScore' as const, label: 'Trading Journal', color: 'var(--rv-amber)', max: 100, suffix: '%' },
  { key: 'backtestSessions' as const, label: 'Backtesting Sessions', color: 'var(--rv-green)', max: 50, suffix: '' },
  { key: 'processScore' as const, label: 'Process Score', color: 'var(--rv-purple)', max: 100, suffix: '/100' },
];

export default function MascotCard({ mascot }: MascotCardProps) {
  const { current, next, progressPct } = getStageProgress(mascot.stats.processScore);
  const [previewStage, setPreviewStage] = useState<MascotStage | null>(null);
  const displayedStage = previewStage ?? current;
  const currentLabel = STAGE_LABELS[current];
  const displayedLabel = STAGE_LABELS[displayedStage];
  const stageIndex = STAGES.indexOf(current);

  return (
    <div className="rv-card mascot-card">
      <div className="mascot-header">
        <div className="mascot-top-row">
          <div>
            <span className="rv-section-kicker">Process Progression</span>
            <h3 className="mascot-name">{mascot.name}</h3>
            <div className="mascot-tier">{previewStage ? `${displayedLabel} Preview` : `${currentLabel} Tier`}</div>
          </div>
          <span className="mascot-chip">{mascot.stats.processScore}/100 process score</span>
        </div>
      </div>

      <div className="mascot-visual-shell">
        <div className="mascot-stage-meta">
          <span className="mascot-stage-label">Stage</span>
          <span className="mascot-stage-value">
            {stageIndex + 1}/{STAGES.length} - {currentLabel}
          </span>
        </div>
        <div className="mascot-stage-track">
          <div className="mascot-stage-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <div className="mascot-stage-row">
          {STAGES.map(stage => (
            <button
              key={stage}
              type="button"
              className={`mascot-stage-pill ${stage === displayedStage ? 'active' : ''}`}
              onClick={() => setPreviewStage(stage === previewStage ? null : stage)}
              title={`Preview ${STAGE_LABELS[stage]} mascot`}
            >
              {STAGE_LABELS[stage]}
            </button>
          ))}
        </div>
      </div>

      <div className="mascot-visual">
        <MascotCharacter stage={displayedStage} health="healthy" size={150} />
      </div>

      <div className="mascot-bars">
        {BAR_META.map(stat => {
          const value = mascot.stats[stat.key];
          const pct = Math.max(0, Math.min(100, Math.round((value / stat.max) * 100)));
          return (
            <div key={stat.key}>
              <div className="mascot-bar-head">
                <span className="mascot-bar-label">{stat.label}</span>
                <span className="mascot-bar-value" style={{ color: stat.color }}>{value}{stat.suffix}</span>
              </div>
              <div className="mascot-track">
                <div className="mascot-fill" style={{ width: `${pct}%`, background: stat.color }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mascot-footer">
        <span className="mascot-footer-note">
          {previewStage
            ? `Previewing ${displayedLabel}; your current tier is ${currentLabel}`
            : next
              ? `${progressPct}% to ${STAGE_LABELS[next]}`
              : 'You are at max stage'}
        </span>
      </div>
    </div>
  );
}
