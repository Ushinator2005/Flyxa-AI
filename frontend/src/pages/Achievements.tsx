import { useMemo } from 'react';
import { useAchievements } from '../hooks/useAchievements.js';
import type { Achievement as AchievementItem } from '../hooks/useAchievements.js';
import useFlyxaStore from '../store/flyxaStore.js';
import './Achievements.css';

const GROUPS: Array<{ value: AchievementItem['category']; label: string }> = [
  { value: 'milestone', label: 'Milestones' },
  { value: 'streak', label: 'Streaks' },
  { value: 'discipline', label: 'Discipline' },
  { value: 'session', label: 'Sessions' },
  { value: 'consistency', label: 'Consistency' },
];

function parseCondition(condition: string): { key: string; target: number } {
  const [key, , val] = condition.split(' ');
  const target = Number.parseFloat(val);
  return { key, target: Number.isFinite(target) && target > 0 ? target : 1 };
}

function statusCount(a: AchievementItem): { text: string; muted: boolean } {
  const { key, target } = parseCondition(a.condition);
  if (a.key === 'funded') return { text: 'No passed account yet', muted: true };
  if (a.progress <= 0) return { text: 'Not started', muted: true };
  const current = Math.round((a.progress / 100) * target);
  if (key === 'totalPnL') {
    return { text: `$${current.toLocaleString('en-US')} of $${target.toLocaleString('en-US')}`, muted: false };
  }
  return { text: `${current} of ${target}`, muted: false };
}

function fmtUnlockDate(unlockedAt: string | null): string {
  if (!unlockedAt) return '';
  return new Date(unlockedAt)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase();
}

const cssVars = (vars: Record<string, string>) => vars as React.CSSProperties;

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

function BadgeCard({ achievement, index }: { achievement: AchievementItem; index: number }) {
  const state = achievement.unlocked ? 'won' : achievement.progress > 0 ? 'ip' : '';
  const status = statusCount(achievement);
  const delay = `${(0.05 + index * 0.05).toFixed(2)}s`;
  const fill = achievement.unlocked ? 100 : Math.round(achievement.progress);

  return (
    <article className={`achv-bd ${state}`.trim()} style={cssVars({ '--d': delay })}>
      <span className="achv-bg" style={cssVars({ '--p': `${fill}%` })} aria-hidden="true">
        {achievement.unlocked && <span className="achv-bg-check">✓</span>}
      </span>
      <span className="achv-bt">
        <b>{achievement.label}</b>
        <span className="achv-ds">{achievement.description}</span>
        <span className="achv-st">
          {achievement.unlocked
            ? <time>UNLOCKED {fmtUnlockDate(achievement.unlockedAt)}</time>
            : <span className={`achv-pct ${status.muted ? 'z' : ''}`.trim()}>{status.text}</span>}
        </span>
      </span>
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
          <div className="achv-prog-bar"><i style={cssVars({ '--p': `${progressPct}%` })} /></div>
          <small>{progressPct}% COMPLETE</small>
        </div>
      </header>

      {/* ── Live streaks: current state, not trophies ── */}
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
            <span className="achv-lbl">Based on current progress</span>
          </div>
          {nextTargets.map((achievement, i) => {
            const pct = Math.round(achievement.progress);
            return (
              <div key={achievement.key} className="achv-ch">
                <div className="achv-ch-t">
                  <b>{achievement.label}</b>
                  <span>{achievement.description}</span>
                </div>
                <div className="achv-ch-bar"><i style={cssVars({ '--p': `${pct}%`, '--d': `${(0.4 + i * 0.1).toFixed(1)}s` })} /></div>
                <div className="achv-ch-pct">
                  {pct}%
                  <small>{100 - pct}% TO GO</small>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Grouped badge sections ── */}
      {grouped.map(group => (
        <section key={group.value} className="achv-grp">
          <div className="achv-grp-hd">
            <span className="achv-lbl strong">{group.label}</span>
            <span className={`achv-ct${group.unlocked === group.items.length ? ' full' : ''}`}>{group.unlocked} of {group.items.length}</span>
          </div>
          <div className="achv-badges">
            {group.items.map((achievement, i) => (
              <BadgeCard key={achievement.key} achievement={achievement} index={i} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
