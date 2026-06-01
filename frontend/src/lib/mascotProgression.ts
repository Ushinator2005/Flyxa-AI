import type { LeaderboardMetric, MascotStage, MascotStats, Rival } from '../types/rivals.js';

const STAGE_THRESHOLDS: Record<MascotStage, number> = {
  seed: 0,
  rookie: 25,
  veteran: 50,
  elite: 75,
  apex: 90,
};

const STAGE_ORDER: MascotStage[] = ['seed', 'rookie', 'veteran', 'elite', 'apex'];

export function getMascotStage(processScore: number): MascotStage {
  if (processScore >= 90) return 'apex';
  if (processScore >= 75) return 'elite';
  if (processScore >= 50) return 'veteran';
  if (processScore >= 25) return 'rookie';
  return 'seed';
}

export function getMascotXP(streakDays: number, stats: MascotStats): number {
  return (
    streakDays * 2 +
    stats.dailyJournalScore +
    stats.tradingJournalScore +
    stats.processScore +
    stats.backtestSessions * 2
  );
}

export function getMascotLabel(stage: MascotStage): string {
  switch (stage) {
    case 'seed': return '🥚 Seed';
    case 'rookie': return '🐣 Rookie';
    case 'veteran': return '🐂 Veteran';
    case 'elite': return '⚡ Elite';
    case 'apex': return '👑 Apex';
  }
}

export function getStageProgress(processScore: number): {
  current: MascotStage;
  next: MascotStage | null;
  progressPct: number;
} {
  const current = getMascotStage(processScore);
  const currentIdx = STAGE_ORDER.indexOf(current);
  const next = currentIdx < STAGE_ORDER.length - 1 ? STAGE_ORDER[currentIdx + 1] : null;

  if (!next) return { current, next: null, progressPct: 100 };

  const currentThreshold = STAGE_THRESHOLDS[current];
  const nextThreshold = STAGE_THRESHOLDS[next];
  const progressPct = Math.round(
    ((processScore - currentThreshold) / (nextThreshold - currentThreshold)) * 100,
  );
  return { current, next, progressPct: Math.min(100, Math.max(0, progressPct)) };
}

export function compareMetric(mine: number, theirs: number): 'winning' | 'losing' | 'tied' {
  if (Math.abs(mine - theirs) <= 2) return 'tied';
  return mine > theirs ? 'winning' : 'losing';
}

export function getMascotHealth(
  streakDays: number,
  lastJournalDate: string,
): 'healthy' | 'tired' | 'sick' | 'critical' {
  if (streakDays === 0) return 'critical';
  const last = new Date(`${lastJournalDate}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor((today.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 1) return 'healthy';
  if (diffDays === 2) return 'tired';
  if (diffDays === 3) return 'sick';
  return 'critical';
}

export function getRivalMetricValue(rival: Rival, metric: LeaderboardMetric): number {
  switch (metric) {
    case 'dailyJournal': return rival.mascot.stats.dailyJournalScore;
    case 'tradingJournal': return rival.mascot.stats.tradingJournalScore;
    case 'backtest': return rival.mascot.stats.backtestSessions;
    case 'processScore': return rival.mascot.stats.processScore;
    case 'winRate': return rival.mascot.stats.winRate ?? 0;
    case 'avgR': return rival.mascot.stats.avgR ?? 0;
  }
}

/** Returns true when a rival has actual data for a trading-performance metric. */
export function rivalHasMetricData(rival: Rival, metric: LeaderboardMetric): boolean {
  if (metric === 'winRate') return rival.mascot.stats.winRate != null;
  if (metric === 'avgR') return rival.mascot.stats.avgR != null;
  return true;
}
