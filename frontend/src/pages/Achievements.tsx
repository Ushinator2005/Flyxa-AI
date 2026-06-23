import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Trophy,
  Flame,
  Zap,
  Crown,
  Shield,
  ShieldCheck,
  Target,
  Award,
  TrendingUp,
  CheckCircle,
  Star,
  Calendar,
  ArrowUpRight,
  Ruler,
  DollarSign,
  Gem,
  Snowflake,
  ClipboardCheck,
  ListChecks,
  PenLine,
} from 'lucide-react';
import { useAchievements } from '../hooks/useAchievements.js';
import type { Achievement as AchievementItem } from '../hooks/useAchievements.js';
import type { AchievementCategory, AchievementRarity } from '../utils/streaks.js';
import './Achievements.css';

const ICON_MAP: Record<string, LucideIcon> = {
  Zap,
  Flame,
  Crown,
  Shield,
  ShieldCheck,
  Target,
  Award,
  TrendingUp,
  CheckCircle,
  Star,
  Calendar,
  Trophy,
  Ruler,
  DollarSign,
  Gem,
  Snowflake,
  ClipboardCheck,
  ListChecks,
  PenLine,
};

const CATEGORIES: Array<{ value: AchievementCategory | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'milestone', label: 'Milestone' },
  { value: 'streak', label: 'Streak' },
  { value: 'discipline', label: 'Discipline' },
  { value: 'session', label: 'Session' },
  { value: 'consistency', label: 'Consistency' },
];

type Tone = 'green' | 'blue' | 'purple' | 'amber';
type RarityClass = 'common' | 'rare' | 'epic' | 'legendary';

function AchievementIcon({ name, size = 20 }: { name: string; size?: number }) {
  const Icon = ICON_MAP[name] ?? Trophy;
  return <Icon size={size} strokeWidth={1.9} />;
}

function formatUnlockedDate(unlockedAt?: string | null): string | null {
  if (!unlockedAt) return null;
  return new Date(unlockedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getRarityClass(rarity?: AchievementRarity): RarityClass {
  if (rarity === 'rare' || rarity === 'epic' || rarity === 'legendary') return rarity;
  return 'common';
}

function StreakCard({
  label,
  value,
  best,
  icon,
  tone,
  note,
}: {
  label: string;
  value: number;
  best: number;
  icon: ReactNode;
  tone: Tone;
  note: string;
}) {
  const progress = best > 0 ? Math.min(100, Math.round((value / best) * 100)) : value > 0 ? 100 : 0;

  return (
    <article className={`achv-streak-card achv-tone-${tone}`}>
      <header className="achv-streak-head">
        <span className="achv-streak-icon">{icon}</span>
        <span className="achv-streak-label">{label}</span>
      </header>
      <div className="achv-streak-main">
        <p className="achv-streak-value">{value}</p>
        <span className="achv-streak-unit">current</span>
      </div>
      <div className="achv-mini-track" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>
      <p className="achv-streak-meta">
        {note} <span>Best {best}</span>
      </p>
    </article>
  );
}

function NextTargetCard({ achievement }: { achievement: AchievementItem }) {
  const rarityClass = getRarityClass(achievement.rarity as AchievementRarity);
  return (
    <article className={`achv-target-card achv-rarity-${rarityClass}`}>
      <div className="achv-target-icon">
        <AchievementIcon name={achievement.icon} size={18} />
      </div>
      <div className="achv-target-body">
        <div className="achv-target-topline">
          <span>{achievement.category}</span>
          <strong>{Math.round(achievement.progress)}%</strong>
        </div>
        <h3>{achievement.label}</h3>
        <p>{achievement.description}</p>
        <div className="achv-target-track">
          <span style={{ width: `${achievement.progress}%` }} />
        </div>
      </div>
    </article>
  );
}

function AchievementBadge({ achievement }: { achievement: AchievementItem }) {
  const rarityClass = getRarityClass(achievement.rarity as AchievementRarity);
  const unlockedDate = formatUnlockedDate(achievement.unlockedAt);

  return (
    <article className={`achv-badge achv-rarity-${rarityClass} ${achievement.unlocked ? 'is-unlocked' : 'is-locked'}`}>
      <div className="achv-badge-top">
        <div className="achv-badge-icon-wrap">
          <AchievementIcon name={achievement.icon} />
        </div>
        <span className="achv-rarity-pill">{rarityClass}</span>
      </div>
      <h3 className="achv-badge-title">{achievement.label}</h3>
      <p className="achv-badge-desc">{achievement.description}</p>
      <footer className="achv-badge-foot">
        <div className="achv-badge-progress">
          <span style={{ width: `${achievement.progress}%` }} />
        </div>
        <span className="achv-unlocked-date">
          {achievement.unlocked && unlockedDate ? `Unlocked ${unlockedDate}` : `${Math.round(achievement.progress)}% complete`}
        </span>
      </footer>
    </article>
  );
}

export default function Achievements() {
  const { stats, achievements, unlockedCount, totalCount, loading } = useAchievements();
  const [category, setCategory] = useState<AchievementCategory | 'all'>('all');
  const [showLocked, setShowLocked] = useState(true);

  const visibleAchievements = useMemo(() => {
    const filtered = achievements.filter(achievement => {
      if (category !== 'all' && achievement.category !== category) return false;
      if (!showLocked && !achievement.unlocked) return false;
      return true;
    });

    return [
      ...filtered.filter(achievement => achievement.unlocked),
      ...filtered.filter(achievement => !achievement.unlocked),
    ];
  }, [achievements, category, showLocked]);

  const nextTargets = useMemo(
    () => achievements
      .filter(achievement => !achievement.unlocked)
      .sort((a, b) => b.progress - a.progress)
      .slice(0, 3),
    [achievements],
  );

  const progress = totalCount > 0 ? (unlockedCount / totalCount) * 100 : 0;
  const progressLabel = `${Math.round(progress)}%`;

  const focusContent = useMemo(() => {
    const { currentWinStreak, currentDisciplineStreak, currentGreenDayStreak } = stats;
    const d = currentDisciplineStreak;
    const w = currentWinStreak;
    const g = currentGreenDayStreak;

    if (d > 0 && d >= w && d >= g) {
      return {
        heading: `${d} disciplined ${d === 1 ? 'entry' : 'entries'} in a row`,
        body: 'Process is your edge right now. One more clean session extends it — focus on plan adherence, not the P&L.',
        icon: <ShieldCheck size={26} />,
      };
    }
    if (w > 0 && w >= g) {
      return {
        heading: `${w} win run`,
        body: "Execution is clicking. Stay size-appropriate and let the edge play out — don't force entries to keep the streak alive.",
        icon: <Flame size={26} />,
      };
    }
    if (g > 0) {
      return {
        heading: `${g} green ${g === 1 ? 'day' : 'days'} running`,
        body: 'Daily consistency is building. Protect it by sticking to your risk limits — a clean loss beats a blown day.',
        icon: <TrendingUp size={26} />,
      };
    }
    return {
      heading: 'Build the first run',
      body: 'Start with process, not outcome. One session with full plan adherence and a completed journal is the first brick.',
      icon: <Trophy size={26} />,
    };
  }, [stats]);

  void focusContent;

  return (
    <div className="achv-page animate-fade-in">
      <header className="achv-hero">
        <div className="achv-hero-copy">
          <span className="achv-kicker">Performance record</span>
          <h1>Streaks &amp; Achievements</h1>
          <p>
            Process streaks, execution milestones, and earned consistency markers from your trading history.
          </p>
        </div>
        <div className="achv-hero-score">
          <span>Unlocked</span>
          <strong>{unlockedCount}<small>/{totalCount}</small></strong>
          <div className="achv-hero-track">
            <span style={{ width: `${progress}%` }} />
          </div>
          <p>{progressLabel} complete</p>
        </div>
      </header>

      <section className="achv-targets" aria-label="Next achievements">
        <div className="achv-section-row">
          <h2 className="achv-section-title">Closest Targets</h2>
          <ArrowUpRight size={14} />
        </div>
        {nextTargets.length > 0 ? (
          nextTargets.map(achievement => <NextTargetCard key={achievement.key} achievement={achievement} />)
        ) : (
          <div className="achv-target-empty">All visible targets are complete.</div>
        )}
      </section>

      <section className="achv-section">
        <div className="achv-section-row">
          <h2 className="achv-section-title">Live Streaks</h2>
        </div>
        {loading ? (
          <div className="achv-streak-grid achv-streak-grid-loading">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="achv-skeleton" />
            ))}
          </div>
        ) : (
          <div className="achv-streak-grid">
            <StreakCard
              label="Win streak"
              value={stats.currentWinStreak}
              best={stats.bestWinStreak}
              icon={<Flame size={15} />}
              tone="green"
              note="Outcome momentum"
            />
            <StreakCard
              label="Best run"
              value={stats.bestWinStreak}
              best={stats.bestWinStreak}
              icon={<Zap size={15} />}
              tone="blue"
              note="Peak execution"
            />
            <StreakCard
              label="Discipline"
              value={stats.currentDisciplineStreak}
              best={stats.bestDisciplineStreak}
              icon={<ShieldCheck size={15} />}
              tone="purple"
              note="Plan compliance"
            />
            <StreakCard
              label="Green days"
              value={stats.currentGreenDayStreak}
              best={stats.bestGreenDayStreak}
              icon={<TrendingUp size={15} />}
              tone="amber"
              note="Daily net positive"
            />
          </div>
        )}
      </section>

      <section className="achv-section">
        <div className="achv-toolbar">
          <div>
            <h2 className="achv-section-title">Achievement Board</h2>
            <p className="achv-section-sub">Earned items are listed first. Locked items show current progress.</p>
          </div>
          <button
            type="button"
            className="achv-chip achv-chip-toggle"
            onClick={() => setShowLocked(value => !value)}
          >
            {showLocked ? 'Hide locked' : 'Show locked'}
          </button>
        </div>

        <div className="achv-filters">
          {CATEGORIES.map(option => (
            <button
              key={option.value}
              type="button"
              className={`achv-chip ${category === option.value ? 'is-active' : ''}`}
              onClick={() => setCategory(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="achv-grid">
            {Array.from({ length: 10 }).map((_, index) => (
              <div key={index} className="achv-skeleton achv-skeleton-badge" />
            ))}
          </div>
        ) : visibleAchievements.length === 0 ? (
          <div className="achv-empty">
            <Trophy size={28} />
            <p>No achievements in this category yet.</p>
          </div>
        ) : (
          <div className="achv-grid">
            {visibleAchievements.map(achievement => (
              <AchievementBadge key={achievement.key} achievement={achievement} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
