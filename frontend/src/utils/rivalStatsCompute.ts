import type { BacktestSession, JournalEntry as TradingJournalEntry, RivalXpEvent, Trade } from '../store/types.js';
import type { JournalEntry as DailyJournalEntry } from '../types/index.js';
import type { LeaderboardPeriod, RivalPeriodStats } from '../types/rivals.js';
import type { RiskRule } from '../store/types.js';
import { getEntriesRuleAdherence, getEntryRuleAdherence } from './tradingRules.js';
import { averageRR } from './riskReward.js';

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function daysAgo(days: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return isoDate(date);
}

export function isMeaningfulDailyJournalEntry(entry: DailyJournalEntry): boolean {
  return Boolean(entry.content?.trim() || (entry.screenshots ?? []).length > 0);
}

export function isMeaningfulTradingJournalEntry(entry: TradingJournalEntry): boolean {
  const hasReflection = Boolean(
    entry.reflection.pre.trim() ||
    entry.reflection.post.trim() ||
    entry.reflection.lessons.trim() ||
    entry.dailyReflection?.pre?.trim() ||
    entry.dailyReflection?.post?.trim() ||
    entry.dailyReflection?.lessons?.trim()
  );
  const hasPsychology = entry.psychology.setupQuality > 0 || entry.psychology.discipline > 0 || entry.psychology.execution > 0;
  return hasReflection || hasPsychology || entry.rules.length > 0 || entry.trades.length > 0;
}

export function computeDailyJournalStreak(entries: DailyJournalEntry[]): number {
  const journalDates = new Set(
    entries.filter(isMeaningfulDailyJournalEntry).map(e => e.date)
  );
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (!journalDates.has(isoDate(start))) start.setDate(start.getDate() - 1);

  let streak = 0;
  for (let i = 0; i < 366; i += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() - i);
    if (!journalDates.has(isoDate(date))) break;
    streak += 1;
  }
  return streak;
}

export function computeDailyJournalCoverage(entries: DailyJournalEntry[]): number {
  const journalDates = new Set(
    entries
      .filter(e => e.date >= daysAgo(29) && isMeaningfulDailyJournalEntry(e))
      .map(e => e.date)
  );
  return clampScore((journalDates.size / 30) * 100);
}

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

export function recentWeekdayDates(count: number): string[] {
  const dates: string[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  while (dates.length < count) {
    if (isWeekday(cursor)) dates.push(isoDate(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return dates;
}

export function computeTradingJournalScore(entries: TradingJournalEntry[]): number {
  const entryDates = new Set(
    entries
      .filter(isMeaningfulTradingJournalEntry)
      .map(e => e.date)
  );
  const weekdays = recentWeekdayDates(20);
  const covered = weekdays.filter(d => entryDates.has(d)).length;
  return clampScore((covered / weekdays.length) * 100);
}

export function computeRuleFollowingScore(entries: TradingJournalEntry[], trades: Trade[], rules: RiskRule[]): number {
  const last30 = entries.filter(e => e.date >= daysAgo(29));
  const recentTrades = trades.filter(t => t.date >= daysAgo(29));

  const planLogged = recentTrades.filter(t => typeof t.reflection?.followedPlan === 'boolean');
  const planAdherence = planLogged.length > 0
    ? (planLogged.filter(t => t.reflection.followedPlan === true).length / planLogged.length) * 100
    : null;
  const planCoverage = recentTrades.length > 0 ? (planLogged.length / recentTrades.length) * 100 : null;
  const followedPlanScore = planAdherence === null
    ? null
    : (planAdherence * 0.75) + ((planCoverage ?? 0) * 0.25);

  // Legacy daily journal rule checks are still accepted for older journal data.
  const evaluatedRules = last30.flatMap(e => e.rules.filter(r => r.state !== 'unchecked'));
  const legacyRuleScore = evaluatedRules.length > 0
    ? (evaluatedRules.filter(r => r.state === 'ok').length / evaluatedRules.length) * 100
    : null;

  // Saved Trading Plan rules are the important part: automatic rules are verified
  // against trade data, manual rules use the journal pass/fail confirmation.
  const configuredSummary = getEntriesRuleAdherence(last30, rules);
  const configuredRuleScore = configuredSummary.pct ?? legacyRuleScore;

  const behavioralDisciplineScore = recentTrades.length > 0
    ? (recentTrades.filter(t =>
        (t.behavioralFlags?.length ?? 0) === 0 &&
        (t.performanceViolations?.length ?? 0) === 0
      ).length / recentTrades.length) * 100
    : null;

  const weightedScores = [
    { score: configuredRuleScore, weight: 0.45 },
    { score: followedPlanScore, weight: 0.35 },
    { score: behavioralDisciplineScore, weight: 0.20 },
  ].filter((item): item is { score: number; weight: number } => typeof item.score === 'number' && Number.isFinite(item.score));

  if (weightedScores.length === 0) return 0;
  const totalWeight = weightedScores.reduce((sum, item) => sum + item.weight, 0);
  return clampScore(weightedScores.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight);
}

export function computeDailyJournalScore(entries: DailyJournalEntry[], dailyJournalStreak: number): number {
  const coverageScore = computeDailyJournalCoverage(entries);
  const streakBonusScore = clampScore((dailyJournalStreak / 14) * 100);
  return clampScore((coverageScore * 0.7) + (streakBonusScore * 0.3));
}

export function computeProcessScore(
  entries: DailyJournalEntry[],
  dailyJournalStreak: number,
  tradingJournalScore: number,
  ruleFollowingScore: number
): number {
  const dailyJournalScore = computeDailyJournalScore(entries, dailyJournalStreak);
  return clampScore(
    (dailyJournalScore * 0.25) +
    (tradingJournalScore * 0.25) +
    (ruleFollowingScore * 0.5)
  );
}

export function buildLifetimeXpEvents(
  dailyEntries: DailyJournalEntry[],
  tradingEntries: TradingJournalEntry[],
  backtests: BacktestSession[],
  dailyJournalStreak: number,
  riskRules: RiskRule[] = [],
): RivalXpEvent[] {
  const events: RivalXpEvent[] = [];
  for (const entry of dailyEntries.filter(isMeaningfulDailyJournalEntry)) {
    events.push({ id: `daily-journal:${entry.id}`, points: 10, label: 'Completed daily journal', earnedAt: entry.created_at || entry.date });
  }
  for (const trade of tradingEntries.flatMap(e => e.trades)) {
    events.push({ id: `documented-trade:${trade.id}`, points: 5, label: 'Documented trade', earnedAt: trade.createdAt || trade.date });
    const reflection = trade.reflection;
    if (reflection && Boolean(reflection.thesis?.trim() || reflection.execution?.trim() || reflection.adjustment?.trim())) {
      events.push({ id: `trade-reflection:${trade.id}`, points: 5, label: 'Completed trade reflection', earnedAt: trade.createdAt || trade.date });
    }
    if (reflection?.followedPlan === true) {
      events.push({ id: `followed-plan:${trade.id}`, points: 5, label: 'Followed trading plan', earnedAt: trade.createdAt || trade.date });
    }
  }
  for (const entry of tradingEntries) {
    const adherence = getEntryRuleAdherence(entry, riskRules);
    if (adherence.checked <= 0 || adherence.pct === null) continue;
    if (adherence.pct === 100) {
      events.push({ id: `perfect-rule-day:${entry.id}`, points: 10, label: 'Perfect Trading Plan day', earnedAt: entry.date });
    } else if (adherence.pct >= 80) {
      events.push({ id: `strong-rule-day:${entry.id}`, points: 5, label: 'Strong Trading Plan adherence', earnedAt: entry.date });
    }
  }
  for (const session of backtests) {
    events.push({ id: `backtest:${session.id}`, points: 20, label: 'Completed backtest session', earnedAt: session.openedAt });
  }
  for (const reward of [{ days: 3, points: 15 }, { days: 7, points: 35 }, { days: 14, points: 75 }, { days: 30, points: 150 }]) {
    if (dailyJournalStreak >= reward.days) {
      events.push({ id: `journal-streak:${reward.days}`, points: reward.points, label: `${reward.days}-day journal streak`, earnedAt: new Date().toISOString() });
    }
  }
  return events;
}

export function periodBounds(period: Exclude<LeaderboardPeriod, 'allTime'>, previous = false): [string, string] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  let start = new Date(now);
  let end = new Date(now);
  if (period === 'week') {
    const mondayOffset = (now.getDay() + 6) % 7;
    start.setDate(now.getDate() - mondayOffset - (previous ? 7 : 0));
    end = new Date(start);
    end.setDate(start.getDate() + 6);
  } else if (period === 'month') {
    start.setDate(now.getDate() - (previous ? 59 : 29));
    end.setDate(now.getDate() - (previous ? 30 : 0));
  } else {
    start = new Date(now.getFullYear(), now.getMonth() - (previous ? 1 : 0), 1);
    end = new Date(now.getFullYear(), now.getMonth() - (previous ? 0 : -1), 0);
  }
  return [isoDate(start), isoDate(end)];
}

export function computePeriodStats(trades: Trade[], bounds?: [string, string]): RivalPeriodStats {
  const filtered = trades
    .filter(t => !bounds || (t.date >= bounds[0] && t.date <= bounds[1]))
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const daily = new Map<string, number>();
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve = filtered.map(t => {
    const value = t.pnl - (t.commission ?? 0);
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    daily.set(t.date, (daily.get(t.date) ?? 0) + value);
    return Math.round(cumulative * 100) / 100;
  });
  const winLoss = filtered.filter(t => t.result === 'win' || t.result === 'loss');
  const wins = filtered.filter(t => t.pnl - (t.commission ?? 0) > 0).length;
  const avgR = averageRR(winLoss);
  const evaluated = filtered.filter(t => t.reflection?.followedPlan != null);
  const greenDays = [...daily.values()].filter(v => v > 0).length;
  const netPnl = Math.round(cumulative * 100) / 100;
  const positiveShare = daily.size ? greenDays / daily.size : 0;
  const drawdownPenalty = Math.min(1, maxDrawdown / Math.max(Math.abs(netPnl), 1));
  const consistency = Math.round(Math.max(0, Math.min(100, positiveShare * 75 + (1 - drawdownPenalty) * 25)));
  return {
    netPnl,
    winRate: filtered.length ? Math.round((wins / filtered.length) * 100) : 0,
    avgR,
    tradeCount: filtered.length,
    tradingDays: daily.size,
    greenDays,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    consistency,
    ruleAdherence: evaluated.length ? Math.round((evaluated.filter(t => t.reflection.followedPlan).length / evaluated.length) * 100) : 0,
    riskAdjusted: Math.round((netPnl / Math.max(maxDrawdown, 1)) * 100) / 100,
    equityCurve,
    dailyPnl: [...daily.entries()]
      .map(([date, pnl]) => ({ date, pnl: Math.round(pnl * 100) / 100 }))
      .slice(-30),
  };
}

export function periodRuleAdherence(
  entries: TradingJournalEntry[],
  rules: RiskRule[],
  bounds?: [string, string]
): number {
  const checks = entries
    .filter(e => !bounds || (e.date >= bounds[0] && e.date <= bounds[1]));
  return getEntriesRuleAdherence(checks, rules).pct ?? 0;
}
