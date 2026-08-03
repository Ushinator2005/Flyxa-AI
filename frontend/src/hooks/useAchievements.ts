import { useMemo } from 'react';
import { useAchievementsWithProgress, useAllTrades } from '../store/selectors.js';
import type { Achievement as StoreAchievement, Trade } from '../store/types.js';

export interface Achievement {
  key: string;
  label: string;
  description: string;
  icon: string;
  condition: string;
  category: 'milestone' | 'streak' | 'discipline' | 'session' | 'consistency';
  rarity: 'common' | 'rare' | 'epic' | 'legendary';
  progress: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

function computeStreakStats(trades: Trade[]) {
  const ordered = [...trades].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  let currentWinStreak = 0;
  let bestWinStreak = 0;
  let currentDisciplineStreak = 0;
  let bestDisciplineStreak = 0;

  for (const trade of ordered) {
    if (trade.result === 'win') {
      currentWinStreak += 1;
      bestWinStreak = Math.max(bestWinStreak, currentWinStreak);
    } else if (trade.result === 'loss') {
      currentWinStreak = 0;
    }

    if (trade.reflection?.followedPlan === true) {
      currentDisciplineStreak += 1;
      bestDisciplineStreak = Math.max(bestDisciplineStreak, currentDisciplineStreak);
    } else {
      currentDisciplineStreak = 0;
    }
  }

  const byDay = new Map<string, number>();
  ordered.forEach((trade) => {
    byDay.set(trade.date, (byDay.get(trade.date) ?? 0) + trade.pnl);
  });
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  let currentGreenDayStreak = 0;
  let bestGreenDayStreak = 0;
  let run = 0;

  days.forEach(([, pnl]) => {
    if (pnl > 0) {
      run += 1;
      bestGreenDayStreak = Math.max(bestGreenDayStreak, run);
    } else {
      run = 0;
    }
  });

  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i][1] > 0) currentGreenDayStreak += 1;
    else break;
  }

  return {
    currentWinStreak,
    bestWinStreak,
    currentDisciplineStreak,
    bestDisciplineStreak,
    currentGreenDayStreak,
    bestGreenDayStreak,
  };
}

function mapCategory(id: string): Achievement['category'] {
  if (id.includes('psych') || id.includes('discipline') || id.includes('plan') || id.includes('rules') || id.includes('revenge')) {
    return 'discipline';
  }
  if (id.includes('streak')) return 'streak';
  if (id.includes('journal')) return 'consistency';
  if (id.includes('funded') || id.includes('green_days') || id.includes('a_grade')) return 'session';
  return 'milestone';
}

function mapIcon(icon: string): string {
  switch (icon) {
    case 'target': return 'Target';
    case 'check': return 'CheckCircle';
    case 'flame': return 'Flame';
    case 'bolt': return 'Zap';
    case 'journal': return 'Calendar';
    case 'ruler': return 'Ruler';
    case 'cash': return 'DollarSign';
    case 'gem': return 'Gem';
    case 'snow': return 'Snowflake';
    case 'clipboard': return 'ClipboardCheck';
    case 'checklist': return 'ListChecks';
    case 'star': return 'Star';
    case 'trophy': return 'Trophy';
    case 'pen': return 'PenLine';
    case 'crown': return 'Crown';
    case 'shield': return 'ShieldCheck';
    default: return 'Trophy';
  }
}

function mapRarity(progress: number): Achievement['rarity'] {
  if (progress >= 100) return 'legendary';
  if (progress >= 75) return 'epic';
  if (progress >= 40) return 'rare';
  return 'common';
}

function mapAchievement(item: StoreAchievement): Achievement {
  return {
    key: item.id,
    label: item.title,
    description: item.description,
    icon: mapIcon(item.icon),
    condition: item.condition,
    category: mapCategory(item.id),
    rarity: mapRarity(item.progress),
    progress: Math.max(0, Math.min(100, item.progress)),
    unlocked: Boolean(item.unlockedAt),
    unlockedAt: item.unlockedAt,
  };
}

export function useAchievements() {
  const achievements = useAchievementsWithProgress();
  const loading = false;
  const trades = useAllTrades();

  const stats = useMemo(() => computeStreakStats(trades), [trades]);

  const mapped = useMemo(() => achievements.map(mapAchievement), [achievements]);
  const unlockedCount = mapped.filter((item) => item.unlocked).length;
  const totalCount = mapped.length;

  return {
    stats,
    achievements: mapped,
    unlockedCount,
    totalCount,
    loading,
  };
}
