import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Trophy, Flame, Zap, Crown, Shield, ShieldCheck, Target, Award, TrendingUp,
  CheckCircle, Star, Calendar, Ruler, DollarSign, Gem, Snowflake,
  ClipboardCheck, ListChecks, PenLine,
} from 'lucide-react';
import { useAchievements } from '../hooks/useAchievements.js';
import type { Achievement as AchievementItem } from '../hooks/useAchievements.js';
import useFlyxaStore from '../store/flyxaStore.js';
import './Achievements.css';

const ICON_MAP: Record<string, LucideIcon> = {
  Zap, Flame, Crown, Shield, ShieldCheck, Target, Award, TrendingUp,
  CheckCircle, Star, Calendar, Trophy, Ruler, DollarSign, Gem, Snowflake,
  ClipboardCheck, ListChecks, PenLine,
};

const GROUPS: Array<{ value: AchievementItem['category']; label: string }> = [
  { value: 'milestone', label: 'Milestones' },
  { value: 'streak', label: 'Streaks' },
  { value: 'discipline', label: 'Discipline' },
  { value: 'session', label: 'Sessions' },
  { value: 'consistency', label: 'Consistency' },
];

function AchievementIcon({ name, size = 15 }: { name: string; size?: number }) {
  const Icon = ICON_MAP[name] ?? Trophy;
  return <Icon size={size} strokeWidth={1.8} />;
}

function fmtUnlockDate(unlockedAt: string | null): string {
  if (!unlockedAt) return '';
  return new Date(unlockedAt)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase();
}

/** Consecutive-day journal streak: any day with trades or a post-session note. */
function journalStreaks(dates: string[]): { current: number; best: number } {
  if (dates.length === 0) return { current: 0, best: 0 };
  const sorted = [...new Set(dates)].sort();
  const DAY = 86400000;
  const toMs = (slice: string) => new Date(`${slice}T00:00:00`).getTime();

  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    run = toMs(sorted[i]) - toMs(sorted[i - 1]) === DAY ? run + 1 : 1;
    best = Math.max(best, run);
  }

  // Current streak only counts if it reaches today or yesterday.
  const todayMs = toMs(new Date().toISOString().slice(0, 10));
  const lastMs = toMs(sorted[sorted.length - 1]);
  if (todayMs - lastMs > DAY) return { current: 0, best };
  let current = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (toMs(sorted[i]) - toMs(sorted[i - 1]) === DAY) current += 1;
    else break;
  }
  return { current, best };
}

function BadgeCard({ achievement }: { achievement: AchievementItem }) {
  const unlocked = achievement.unlocked;
  return (
    <article className={`achv-bd${unlocked ? ' won' : ' lk'}`}>
      <div className="achv-bd-ic"><AchievementIcon name={achievement.icon} /></div>
      <div className="achv-bd-t">
        <b>{achievement.label}</b>
        <span>{achievement.description}</span>
        {unlocked
          ? <small>UNLOCKED {fmtUnlockDate(achievement.unlockedAt)}</small>
          : (
            <div className="achv-bd-mini" aria-hidden="true">
              <i style={{ width: `${Math.round(achievement.progress)}%` }} />
            </div>
          )}
      </div>
    </article>
  );
}

export default function Achievements() {
  const { stats, achievements, unlockedCount, totalCount } = useAchievements();
  const entries = useFlyxaStore(state => state.entries);

  const journal = useMemo(() => journalStreaks(
    entries
      .filter(entry => entry.trades.length > 0 || Boolean(entry.dailyReflection?.post?.trim()))
      .map(entry => entry.date)
  ), [entries]);

  const nextTargets = useMemo(
    () => achievements
      .filter(achievement => !achievement.unlocked && achievement.progress > 0)
      .sort((a, b) => b.progress - a.progress)
      .slice(0, 3),
    [achievements],
  );

  const grouped = useMemo(() => GROUPS
    .map(group => {
      const items = achievements.filter(achievement => achievement.category === group.value);
      const ordered = [
        ...items.filter(item => item.unlocked),
        ...items.filter(item => !item.unlocked).sort((a, b) => b.progress - a.progress),
      ];
      return { ...group, items: ordered, unlocked: items.filter(item => item.unlocked).length };
    })
    .filter(group => group.items.length > 0), [achievements]);

  const progressPct = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;

  const streakCells = [
    {
      label: 'Journal streak',
      value: journal.current,
      unit: journal.current === 1 ? 'day' : 'days',
      best: journal.best,
      stake: journal.current > 0 ? 'log today to keep it' : 'log a session to start one',
    },
    {
      label: 'Rule-clean trades',
      value: stats.currentDisciplineStreak,
      unit: 'in a row',
      best: stats.bestDisciplineStreak,
      stake: 'plan-tagged entries',
    },
    {
      label: 'Green sessions',
      value: stats.currentGreenDayStreak,
      unit: 'in a row',
      best: stats.bestGreenDayStreak,
      stake: 'net-positive days',
    },
    {
      label: 'Win streak',
      value: stats.currentWinStreak,
      unit: stats.currentWinStreak === 1 ? 'trade' : 'trades',
      best: stats.bestWinStreak,
      stake: 'consecutive winners',
    },
  ];

  return (
    <div className="achv-page animate-fade-in">

      {/* ── Header ── */}
      <header className="achv-hd">
        <div>
          <h1>Streaks &amp; achievements</h1>
          <p>Process streaks, execution milestones, and earned consistency markers from your trading history.</p>
        </div>
        <div className="achv-prog">
          <b>{unlockedCount}<span> / {totalCount}</span></b>
          <div className="achv-prog-bar"><i style={{ width: `${progressPct}%` }} /></div>
          <small>{progressPct}% COMPLETE</small>
        </div>
      </header>

      {/* ── Live streaks: a data strip, not trophies ── */}
      <div className="achv-streaks">
        {streakCells.map(cell => (
          <div key={cell.label} className={`achv-stk${cell.value > 0 ? ' live' : ''}`}>
            <span className="achv-lbl">{cell.label}</span>
            <div className="achv-stk-v"><b>{cell.value}</b><span>{cell.unit}</span></div>
            <small>Best <b>{cell.best}</b> · {cell.stake}</small>
          </div>
        ))}
      </div>

      {/* ── Closest to unlock ── */}
      {nextTargets.length > 0 && (
        <div className="achv-chase">
          <div className="achv-chase-hd">
            <b>Closest to unlock</b>
            <span>BASED ON CURRENT PROGRESS</span>
          </div>
          {nextTargets.map(achievement => (
            <div key={achievement.key} className="achv-ch">
              <div className="achv-ch-t">
                <b>{achievement.label}</b>
                <span>{achievement.description}</span>
              </div>
              <div className="achv-ch-bar"><i style={{ width: `${Math.round(achievement.progress)}%` }} /></div>
              <div className="achv-ch-pct">
                {Math.round(achievement.progress)}%
                <small>{100 - Math.round(achievement.progress)}% TO GO</small>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Grouped badge sections ── */}
      {grouped.map(group => (
        <section key={group.value} className="achv-grp">
          <div className="achv-grp-hd">
            <span className="achv-lbl strong">{group.label}</span>
            <span>{group.unlocked} of {group.items.length}</span>
          </div>
          <div className="achv-badges">
            {group.items.map(achievement => (
              <BadgeCard key={achievement.key} achievement={achievement} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
