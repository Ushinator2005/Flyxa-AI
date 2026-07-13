import { Trade } from '../types/index.js';
import type { JournalEntry as StoreJournalEntry, RiskRule } from '../store/types.js';
import { normalizeConfluenceKey, normalizeConfluenceTags } from './confluenceTags.js';
import { buildPlanAdherenceReport, type PlanAdherenceReport } from './planAdherence.js';

export type InsightType = 'risk' | 'pattern' | 'psychology' | 'edge';
export type TagTone = 'positive' | 'negative' | 'neutral';

export type WeeklyStat = {
  label: string;
  value: string;
  subLabel: string;
  tone: 'positive' | 'negative' | 'neutral' | 'info';
};

export type WeeklyInsight = {
  type: InsightType;
  badge: string;
  frequency: string;
  title: string;
  body: string;
  keyPhrases: string[];
  tags: Array<{ label: string; tone: TagTone }>;
  actionLabel: string;
};

export type ProcessBreakdownItem = { label: string; value: number; noData?: boolean; note?: string };
export type ConfluenceHighlight = { label: string; trades: number; winRate: number; netPnl: number; avgPnl: number };

export type WeeklyDebriefData = {
  weekRange: string;
  sessionCount: number;
  tradeCount: number;
  instruments: string[];
  stats: {
    netR: WeeklyStat;
    winRate: WeeklyStat;
    avgWinner: WeeklyStat;
    avgLoser: WeeklyStat;
    processScore: WeeklyStat;
  };
  question: string;
  insights: WeeklyInsight[];
  processBreakdown: ProcessBreakdownItem[];
  confluences: ConfluenceHighlight[];
  focusItems: string[];
  nextDebrief: { generatedOn: string; sessionsLogged: number; sessionsTarget: number };
};

export function avg(values: number[]) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

export function pct(part: number, whole: number) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

/** Returns midnight on the Monday of the current calendar week. */
export function thisWeekMonday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun,1=Mon,...,6=Sat
  const daysToMon = dow === 0 ? 6 : dow - 1;
  today.setDate(today.getDate() - daysToMon);
  return today;
}

export type TimeFrame = '1W' | '1M' | '3M' | 'All';

export function getPeriodWindow(tf: TimeFrame, weekOffset = 0) {
  const now = new Date(); now.setHours(23, 59, 59, 999);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (tf === '1W') {
    const baseMon = thisWeekMonday();
    const mon = addDays(baseMon, -weekOffset * 7);
    const fri = addDays(mon, 4);
    const periodEnd = weekOffset === 0 ? now : (() => { const e = new Date(fri); e.setHours(23, 59, 59, 999); return e; })();
    const periodLabel = weekOffset === 0 ? 'this week' : `week of ${mon.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    return {
      periodStart: mon, periodEnd,
      displayStart: mon, displayEnd: fri,
      prevStart: addDays(mon, -7), prevEnd: addDays(mon, -1),
      periodLabel, prevLabel: 'prev week', headerLabel: 'Weekly debrief',
    };
  }
  if (tf === '1M') {
    const monthStart = new Date(today.getFullYear(), today.getMonth() - weekOffset, 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() - weekOffset + 1, 0);
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - weekOffset - 1, 1);
    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth() - weekOffset, 0);
    const periodEnd = weekOffset === 0 ? now : (() => { const e = new Date(monthEnd); e.setHours(23, 59, 59, 999); return e; })();
    const periodLabel = weekOffset === 0 ? 'this month' : monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return {
      periodStart: monthStart, periodEnd,
      displayStart: monthStart, displayEnd: monthEnd,
      prevStart: prevMonthStart, prevEnd: prevMonthEnd,
      periodLabel, prevLabel: 'prev month', headerLabel: 'Monthly debrief',
    };
  }
  if (tf === '3M') {
    const start = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    const displayEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const prevStart = new Date(today.getFullYear(), today.getMonth() - 5, 1);
    const prevEnd = new Date(today.getFullYear(), today.getMonth() - 2, 0);
    return {
      periodStart: start, periodEnd: now,
      displayStart: start, displayEnd,
      prevStart, prevEnd,
      periodLabel: 'last 3 months', prevLabel: 'prev 3 months', headerLabel: '3-Month review',
    };
  }
  // All time
  return {
    periodStart: new Date(0), periodEnd: now,
    displayStart: new Date(0), displayEnd: today,
    prevStart: new Date(0), prevEnd: new Date(0),
    periodLabel: 'all time', prevLabel: '', headerLabel: 'All-time review',
  };
}

export function formatPeriodRange(start: Date, end: Date): string {
  if (start.getTime() <= 1000) return `All time · through ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (start.getFullYear() !== end.getFullYear()) {
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`;
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseTradeDate(trade?: Partial<Trade> | null): Date | null {
  if (!trade) return null;
  // ApiTrade uses trade_date; StoreTrade uses date
  const dateStr = trade.trade_date || (trade as unknown as { date?: string }).date;
  if (dateStr) {
    const parsed = new Date(`${dateStr}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (trade.created_at) {
    const parsed = new Date(trade.created_at);
    if (!Number.isNaN(parsed.getTime())) {
      parsed.setHours(0, 0, 0, 0);
      return parsed;
    }
  }
  return null;
}

export function parseTradeDateTime(trade?: Partial<Trade> | null): Date | null {
  if (!trade) return null;
  // ApiTrade uses trade_date/trade_time; StoreTrade uses date/time
  const dateStr = trade.trade_date || (trade as unknown as { date?: string }).date;
  const timeStr = trade.trade_time || (trade as unknown as { time?: string }).time;
  if (dateStr) {
    const t = timeStr?.length === 5 ? `${timeStr}:00` : (timeStr || '00:00:00');
    const parsed = new Date(`${dateStr}T${t}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (trade.created_at) {
    const parsed = new Date(trade.created_at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export function tradeMinutes(trade?: Partial<Trade> | null): number | null {
  if (!trade) return null;
  // ApiTrade uses trade_time; StoreTrade uses time
  const timeStr = trade.trade_time || (trade as unknown as { time?: string }).time;
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h * 60) + m;
}

export function tradeSessionKey(trade?: Partial<Trade> | null) {
  const date = parseTradeDate(trade);
  return date ? date.toISOString().slice(0, 10) : '';
}

export function formatCurrency(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatSignedCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}

export function formatSignedCompactCurrency(value: number) {
  const compact = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(value)).replace('K', 'k');
  return `${value >= 0 ? '+' : '-'}${compact}`;
}

export function normalizeConfluences(value: unknown): string[] {
  return normalizeConfluenceTags(value);
}

export function tradeR(trade?: Partial<Trade> | null): number {
  if (!trade) return 0;
  const entryPrice = Number(trade.entry_price ?? 0);
  const stopPrice = Number(trade.sl_price ?? 0);
  const pnl = Number(trade.pnl ?? 0);
  const riskPoints = Math.abs(entryPrice - stopPrice);
  if (riskPoints > 0) {
    const contractSize = Number(trade.contract_size ?? 0);
    const pointVal = Number(trade.point_value ?? 0);
    const size = contractSize > 0 ? contractSize : 1;
    const pointValue = pointVal > 0 ? pointVal : 1;
    const riskCash = riskPoints * size * pointValue;
    if (riskCash > 0) return pnl / riskCash;
  }
  if (pnl > 0) return 1;
  if (pnl < 0) return -1;
  return 0;
}

export function summarize(trades: Trade[]) {
  const rs = trades.map(tradeR);
  const ep = (t: Trade) => Number(t.pnl ?? 0) - Number(t.commission ?? 0);
  const winners = trades.filter(t => ep(t) > 0);
  const losers = trades.filter(t => ep(t) < 0);
  const winnerRs = winners.map(tradeR);
  const loserRs = losers.map(tradeR);
  const pnls = trades.map(ep);
  const winnerPnls = winners.map(ep);
  const loserPnls = losers.map(ep);
  return {
    netR: rs.reduce((s, r) => s + r, 0),
    netPnl: trades.reduce((sum, trade) => sum + ep(trade), 0),
    avgPnl: avg(pnls),
    avgR: avg(rs),
    winRate: pct(winners.length, winners.length + losers.length),
    wins: winners.length,
    losses: losers.length,
    avgWinnerR: avg(winnerRs),
    avgLoserR: avg(loserRs),
    avgWinnerPnl: avg(winnerPnls),
    avgLoserPnl: avg(loserPnls),
    bestR: winnerRs.length ? Math.max(...winnerRs) : 0,
    worstR: loserRs.length ? Math.min(...loserRs) : 0,
    bestPnl: winnerPnls.length ? Math.max(...winnerPnls) : 0,
    worstPnl: loserPnls.length ? Math.min(...loserPnls) : 0,
  };
}

export function processBreakdown(trades: Trade[], ruleReport?: PlanAdherenceReport) {
  if (!trades.length) {
    return {
      items: [
        { label: 'Plan adherence', value: 0 },
        { label: 'Size discipline', value: 0 },
        { label: 'Entry patience', value: 0 },
        { label: 'Post-loss mgmt', value: 0, noData: true, note: 'No trades logged' },
      ] as ProcessBreakdownItem[],
      score: 0,
    };
  }

  // ── Plan Adherence ─────────────────────────────────────────────────────────
  // Raw score = % of logged trades that followed the plan.
  // Coverage multiplier = fraction of trades that actually have the field logged.
  // A trader who only logs 30% of trades can score at most 30 — selective logging
  // cannot be gamed into a high score.
  const tradesWithPlanLogged = trades.filter(t => typeof t.followed_plan === 'boolean');
  const coverage = tradesWithPlanLogged.length / trades.length;
  const rawPlan = tradesWithPlanLogged.length > 0
    ? pct(tradesWithPlanLogged.filter(t => t.followed_plan === true).length, tradesWithPlanLogged.length)
    : 0;
  const structuredPlan = ruleReport && ruleReport.checked > 0 ? ruleReport.pct ?? 0 : null;
  const plan = structuredPlan !== null ? structuredPlan : Math.round(rawPlan * coverage);
  const planNote = structuredPlan !== null
    ? `${ruleReport!.passed}/${ruleReport!.checked} rule checks`
    : coverage < 1
      ? `${Math.round(coverage * 100)}% of trades logged`
      : undefined;

  // ── Size Discipline ────────────────────────────────────────────────────────
  // Mean Absolute Deviation from the median size, normalised by the median.
  // 0% deviation → 100 score. 100% average deviation → 0 score.
  const sizes = trades.map(t => Math.max(1, t.contract_size));
  const sortedSizes = [...sizes].sort((a, b) => a - b);
  const mid = Math.floor(sortedSizes.length / 2);
  const median = sortedSizes.length % 2 === 0
    ? (sortedSizes[mid - 1] + sortedSizes[mid]) / 2
    : sortedSizes[mid];
  const deviation = avg(sizes.map(s => Math.abs(s - median) / Math.max(1, median)));
  const size = Math.round(Math.max(0, Math.min(100, 100 - deviation * 100)));

  // ── Entry Patience ─────────────────────────────────────────────────────────
  // Penalises entries in the first 15 min of the US session open (9:30–9:45).
  // The original 5-min window (9:30–9:35) almost never triggered — essentially
  // a free 25 points. 15 minutes matches the standard "wait for opening range"
  // advice and will actually differentiate behaviour.
  const rushed = trades.filter(t => {
    const minutes = tradeMinutes(t);
    return minutes !== null && minutes >= 570 && minutes < 585; // 9:30–9:45
  }).length;
  const patience = Math.round(Math.max(0, Math.min(100, 100 - pct(rushed, trades.length))));

  // ── Post-loss Management ───────────────────────────────────────────────────
  // Evaluates the trade immediately after each intra-day loss:
  //   sizeOk  — didn't increase size (revenge sizing flag)
  //   waitOk  — waited at least 15 min before re-entering
  //   planOk  — followed plan on re-entry (0.5 neutral when not logged,
  //              so the score doesn't depend on whether that field was filled in)
  // Cross-session pairs (e.g. last trade Mon → first trade Tue) are excluded —
  // a 16-hour gap is not a meaningful "post-loss cooldown" signal.
  // When there are zero intra-day losses, the metric is N/A and excluded
  // from the composite rather than defaulting to an arbitrary 70.
  const ordered = [...trades].sort(
    (a, b) => (parseTradeDateTime(a)?.getTime() ?? 0) - (parseTradeDateTime(b)?.getTime() ?? 0)
  );
  let opportunities = 0;
  let postLossTotal = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (prev.pnl >= 0) continue;
    const prevDt = parseTradeDateTime(prev);
    const currDt = parseTradeDateTime(curr);
    // Skip cross-day pairs
    if (!prevDt || !currDt || prevDt.toDateString() !== currDt.toDateString()) continue;
    opportunities += 1;
    const minsBetween = (currDt.getTime() - prevDt.getTime()) / 60_000;
    const sizeOk  = curr.contract_size <= prev.contract_size ? 1 : 0;
    const waitOk  = minsBetween >= 15 ? 1 : 0;
    // Always 3 checks — plan gets 0.5 (neutral) when unlogged
    const planOk  = typeof curr.followed_plan === 'boolean' ? (curr.followed_plan ? 1 : 0) : 0.5;
    postLossTotal += ((sizeOk + waitOk + planOk) / 3) * 100;
  }
  const postLossRaw  = opportunities > 0 ? Math.round(postLossTotal / opportunities) : null;
  const hasPostLoss  = postLossRaw !== null;

  // ── Composite Score ────────────────────────────────────────────────────────
  // When post-loss has no data, its 20% weight is redistributed proportionally
  // across the other three dimensions so the score still sums to 100.
  // Weights without post-loss: plan 35/80, size 20/80, patience 25/80.
  let score: number;
  if (hasPostLoss) {
    score = Math.round(plan * 0.35 + size * 0.20 + patience * 0.25 + postLossRaw! * 0.20);
  } else {
    score = Math.round(plan * (35 / 80) + size * (20 / 80) + patience * (25 / 80));
  }

  return {
    items: [
      { label: 'Plan adherence', value: plan, note: planNote },
      { label: 'Size discipline', value: size },
      { label: 'Entry patience', value: patience },
      {
        label: 'Post-loss mgmt',
        value: hasPostLoss ? postLossRaw! : 0,
        noData: !hasPostLoss,
        note: !hasPostLoss ? 'No intra-day losses' : undefined,
      },
    ] as ProcessBreakdownItem[],
    score,
  };
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatMins(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface TimeBucket {
  start: number;
  end: number;
  label: string;
  trades: Trade[];
}

/** Splits timed trades into the smallest uniform buckets that yield ≥ 2 non-empty groups. */
export function buildAdaptiveTimeBuckets(timedTrades: Trade[]): {
  buckets: TimeBucket[];
  bucketSize: number;
  minTime: number;
  maxTime: number;
  spread: number;
} | null {
  if (!timedTrades.length) return null;
  const allMins = timedTrades
    .map(t => tradeMinutes(t))
    .filter((m): m is number => m !== null);
  if (!allMins.length) return null;

  const minTime = Math.min(...allMins);
  const maxTime = Math.max(...allMins);
  const spread = maxTime - minTime;

  // Smallest granularity that produces >= 2 distinct non-empty buckets
  const candidateSizes = [5, 10, 15, 30];
  let bucketSize = 30;
  for (const size of candidateSizes) {
    const keys = new Set(allMins.map(m => Math.floor(m / size) * size));
    if (keys.size >= 2) { bucketSize = size; break; }
  }

  const bucketStart = Math.floor(minTime / bucketSize) * bucketSize;
  const bucketEnd = (Math.floor(maxTime / bucketSize) + 1) * bucketSize;
  const buckets: TimeBucket[] = [];

  for (let t = bucketStart; t < bucketEnd; t += bucketSize) {
    const inBucket = timedTrades.filter(tr => {
      const m = tradeMinutes(tr);
      return m !== null && m >= t && m < t + bucketSize;
    });
    buckets.push({
      start: t,
      end: t + bucketSize,
      label: `${formatMins(t)}–${formatMins(t + bucketSize)}`,
      trades: inBucket,
    });
  }

  return { buckets, bucketSize, minTime, maxTime, spread };
}

export function buildData(
  trades: Trade[],
  tf: TimeFrame = '1W',
  weekOffset = 0,
  entries: StoreJournalEntry[] = [],
  riskRules: RiskRule[] = [],
  accountId?: string | null,
): WeeklyDebriefData {
  const pw = getPeriodWindow(tf, weekOffset);
  const { periodLabel, prevLabel } = pw;

  if (!trades.length) {
    return {
      weekRange: formatPeriodRange(pw.displayStart, pw.displayEnd),
      sessionCount: 0,
      tradeCount: 0,
      instruments: [],
      stats: {
        netR: { label: 'Net PL', value: '$0.00', subLabel: `No trades logged ${periodLabel}`, tone: 'neutral' },
        winRate: { label: 'Win Rate', value: '0%', subLabel: '0W / 0L', tone: 'neutral' },
        avgWinner: { label: 'Avg Winner', value: '$0.00', subLabel: 'Need trade samples', tone: 'neutral' },
        avgLoser: { label: 'Avg Loser', value: '$0.00', subLabel: 'Need trade samples', tone: 'neutral' },
        processScore: { label: 'Process Score', value: '0/100', subLabel: 'Builds from journal behavior', tone: 'info' },
      },
      question: `What single plan will you execute with discipline ${periodLabel}?`,
      insights: [{
        type: 'risk',
        badge: 'Risk Flag',
        frequency: 'Waiting for trade data',
        title: `No ${pw.headerLabel.toLowerCase()} signal yet`,
        body: 'Add trades in the journal and Flyxa will generate this debrief from your execution data.',
        keyPhrases: ['journal', 'execution data'],
        tags: [{ label: `No trades ${periodLabel}`, tone: 'neutral' }],
        actionLabel: 'Add your first trade ->',
      }],
      processBreakdown: [
        { label: 'Plan adherence', value: 0 },
        { label: 'Size discipline', value: 0 },
        { label: 'Entry patience', value: 0 },
        { label: 'Post-loss mgmt', value: 0 },
      ],
      confluences: [],
      focusItems: [
        'Log every trade with thesis, emotional state, and followed_plan status.',
        'Use consistent position sizing so process scoring can stabilize.',
        'Capture post-loss behavior with notes for deeper AI feedback.',
      ],
      nextDebrief: {
        generatedOn: addDays(new Date(), 1).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }),
        sessionsLogged: 0,
        sessionsTarget: 5,
      },
    };
  }

  const ordered = [...trades].sort((a, b) => (parseTradeDateTime(a)?.getTime() ?? 0) - (parseTradeDateTime(b)?.getTime() ?? 0));
  const { periodStart, periodEnd, prevStart, prevEnd } = pw;
  // For All-time, set displayStart to the earliest trade date.
  const allTimeDisplayStart = tf === 'All'
    ? (() => {
        const dates = ordered.map(t => parseTradeDate(t)).filter(Boolean) as Date[];
        return dates.length ? new Date(Math.min(...dates.map(d => d.getTime()))) : pw.displayEnd;
      })()
    : pw.displayStart;
  const displayStart = tf === 'All' ? allTimeDisplayStart : pw.displayStart;
  const displayEnd = pw.displayEnd;
  const rollingStart = addDays(periodEnd, -89);

  const inRange = (trade: Trade, start: Date, end: Date) => {
    const date = parseTradeDate(trade);
    return Boolean(date && date.getTime() >= start.getTime() && date.getTime() <= end.getTime());
  };

  const periodTrades = ordered.filter(t => inRange(t, periodStart, periodEnd));
  const previous = tf !== 'All' ? ordered.filter(t => inRange(t, prevStart, prevEnd)) : [];
  const rolling = ordered.filter(t => inRange(t, rollingStart, periodEnd));
  const periodRuleReport = buildPlanAdherenceReport(entries, riskRules, { bounds: [dateKey(periodStart), dateKey(periodEnd)], accountId });
  const rollingRuleReport = buildPlanAdherenceReport(entries, riskRules, { bounds: [dateKey(rollingStart), dateKey(periodEnd)], accountId });
  const periodSummary = summarize(periodTrades);
  const previousSummary = summarize(previous);
  const periodProcess = processBreakdown(periodTrades, periodRuleReport);
  const rollingProcess = processBreakdown(rolling, rollingRuleReport);
  const processDiff = periodProcess.score - rollingProcess.score;
  const sessionCount = new Set(periodTrades.map(tradeSessionKey).filter(Boolean)).size;

  const instruments = Array.from(periodTrades.reduce((map, trade) => {
    const symbol = trade.symbol?.trim() || 'N/A';
    map.set(symbol, (map.get(symbol) ?? 0) + 1);
    return map;
  }, new Map<string, number>()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([symbol]) => symbol);

  // Adaptive time-window analysis — no fixed 10:00 boundary
  const timedTrades = periodTrades.filter(t => tradeMinutes(t) !== null);
  const timeWindow = buildAdaptiveTimeBuckets(timedTrades);

  const symbolGroups = new Map<string, Trade[]>();
  periodTrades.forEach(trade => {
    const symbol = trade.symbol?.trim() || 'Unknown';
    symbolGroups.set(symbol, [...(symbolGroups.get(symbol) ?? []), trade]);
  });
  const topSymbol = Array.from(symbolGroups.entries()).sort((a, b) => b[1].length - a[1].length)[0];
  const topSymbolName = topSymbol?.[0] ?? 'N/A';
  const topSymbolSummary = topSymbol ? summarize(topSymbol[1]) : summarize([]);

  const stateGroups = new Map<string, Trade[]>();
  periodTrades.forEach(trade => {
    const state = trade.emotional_state || 'Unspecified';
    stateGroups.set(state, [...(stateGroups.get(state) ?? []), trade]);
  });
  const rankedStates = Array.from(stateGroups.entries())
    .map(([state, entries]) => ({ state, summary: summarize(entries) }))
    .sort((a, b) => a.summary.netPnl - b.summary.netPnl);
  // Require a minimum per-state sample before including in comparison.
  // One "Anxious" trade that lost $300 does not establish a pattern.
  const PSYCH_MIN = tf === '1W' ? 2 : tf === '1M' ? 3 : 5;
  const meaningfulStates = rankedStates.filter(s =>
    (s.state as string) !== 'Unspecified' &&
    (stateGroups.get(s.state as string)?.length ?? 0) >= PSYCH_MIN
  );
  const hasEnoughPsychData = meaningfulStates.length >= 2;
  const psychWeakest = meaningfulStates[0];
  const psychStrongest = meaningfulStates[meaningfulStates.length - 1];

  const sessionGroups = new Map<string, Trade[]>();
  periodTrades.forEach(trade => {
    const session = trade.session || 'Other';
    sessionGroups.set(session, [...(sessionGroups.get(session) ?? []), trade]);
  });
  const bestSession = Array.from(sessionGroups.entries())
    .map(([session, entries]) => ({ session, entries, summary: summarize(entries) }))
    .sort((a, b) => b.summary.netPnl - a.summary.netPnl)[0];

  const confluenceGroups = new Map<string, {
    label: string;
    trades: number;
    wins: number;
    netPnl: number;
  }>();
  periodTrades.forEach(trade => {
    const tradeConfluences = normalizeConfluences(trade.confluences);
    if (!tradeConfluences.length) return;
    const tradeConfluenceSet = new Set(tradeConfluences.map(normalizeConfluenceKey));
    const currentPnl = Number(trade.pnl ?? 0) - Number(trade.commission ?? 0);

    tradeConfluenceSet.forEach(confluenceKey => {
      const label = tradeConfluences.find(confluence => normalizeConfluenceKey(confluence) === confluenceKey) ?? confluenceKey;
      const current = confluenceGroups.get(confluenceKey) ?? {
        label,
        trades: 0,
        wins: 0,
        netPnl: 0,
      };
      current.trades += 1;
      current.netPnl += currentPnl;
      if (currentPnl > 0) current.wins += 1;
      confluenceGroups.set(confluenceKey, current);
    });
  });
  const confluenceLeaders: ConfluenceHighlight[] = Array.from(confluenceGroups.values())
    .map(item => ({
      ...item,
      winRate: item.trades > 0 ? pct(item.wins, item.trades) : 0,
      avgPnl: item.trades > 0 ? item.netPnl / item.trades : 0,
    }))
    .sort((a, b) => b.netPnl - a.netPnl);
  const topConfluence = confluenceLeaders[0];
  const weakestConfluence = [...confluenceLeaders]
    .filter(item => item.netPnl < 0)
    .sort((a, b) => a.netPnl - b.netPnl)[0];

  // Exclude noData items — a post-loss score of 0 from "no losses" is not a real weakness.
  const weakestProcess = [...periodProcess.items]
    .filter(item => !item.noData)
    .sort((a, b) => a.value - b.value)[0];
  const question = weakestProcess?.label === 'Entry patience'
    ? `Which entries ${periodLabel} were taken too early, and what confirmation were you still waiting for?`
    : weakestProcess?.label === 'Post-loss mgmt'
      ? 'After your losing trades, where did you reset well and where did you press too quickly?'
      : weakestProcess?.label === 'Size discipline'
        ? 'Where did your size deviate from plan, and what triggered it?'
        : weakestConfluence && weakestConfluence.trades >= (tf === '1W' ? 3 : tf === '1M' ? 5 : tf === '3M' ? 8 : 10)
          ? `How can you tighten or avoid "${weakestConfluence.label}" when it has cost ${formatSignedCurrency(weakestConfluence.netPnl)} ${periodLabel}?`
          : 'Which losing trades came from plan drift, and what rule would have prevented them?';

  // ── Adaptive time-window insight ────────────────────────────────────────────
  // Derives the actual trading window from data and compares sub-periods within it,
  // instead of using a fixed 10:00 boundary that is meaningless for open traders.
  const timeInsight: WeeklyInsight = (() => {
    const noData: WeeklyInsight = {
      type: 'pattern',
      badge: 'Session Note',
      frequency: 'No entry times logged',
      title: 'Log entry times to unlock time-of-day analysis',
      body: 'Add a trade time to your entries to see which windows of the session are helping or hurting your P&L.',
      keyPhrases: ['entry times', 'time-of-day'],
      tags: [{ label: 'No time data', tone: 'neutral' }],
      actionLabel: 'Add to trade template ->',
    };

    // Truly no time data: trades exist but none have times logged
    if (!timeWindow) return noData;

    // Too few trades for sub-window comparison — but DO NOT say "no entry times logged"
    if (timedTrades.length < 3) {
      const summary = summarize(timedTrades);
      const needed = 3 - timedTrades.length;
      return {
        type: 'pattern',
        badge: 'Session Note',
        frequency: `${timedTrades.length} trade${timedTrades.length !== 1 ? 's' : ''} with time data this period`,
        title: `${needed} more trade${needed !== 1 ? 's' : ''} needed to unlock time-of-day analysis`,
        body: timedTrades.length === 0
          ? 'Add a trade time to your entries to see which windows of the session are helping or hurting your P&L.'
          : `You have ${timedTrades.length} timed trade${timedTrades.length !== 1 ? 's' : ''} this period — net ${formatSignedCurrency(summary.netPnl)}. Log ${needed} more with entry times to enable sub-window comparison.`,
        keyPhrases: ['entry times', 'time-of-day'],
        tags: [
          { label: `${timedTrades.length}/3 trades`, tone: 'neutral' },
          ...(timedTrades.length > 0 ? [{ label: `${formatSignedCurrency(summary.netPnl)} so far`, tone: (summary.netPnl >= 0 ? 'positive' : 'negative') as TagTone }] : []),
        ],
        actionLabel: 'Keep logging ->',
      };
    }

    const { buckets, minTime, maxTime, spread } = timeWindow;
    const windowLabel = `${formatMins(minTime)}–${formatMins(maxTime)}`;
    const tradingSessions = new Set(timedTrades.map(tradeSessionKey).filter(Boolean)).size;
    const significantBuckets = buckets.filter(b => b.trades.length >= 2);

    // All trades cluster in one narrow window — not enough variance for comparison
    if (significantBuckets.length < 2) {
      const summary = summarize(timedTrades);
      const windowDesc = spread <= 5 ? 'single-candle' : `${spread}-minute`;
      return {
        type: summary.netPnl >= 0 ? 'edge' as const : 'pattern' as const,
        badge: 'Session Note',
        frequency: `${timedTrades.length} trades · ${windowLabel} · ${tradingSessions} sessions`,
        title: `Entries tightly clustered in the ${windowLabel} window`,
        body: `All ${timedTrades.length} timed trades landed in a ${windowDesc} window around ${windowLabel} across ${tradingSessions} session${tradingSessions !== 1 ? 's' : ''} — net ${formatSignedCurrency(summary.netPnl)}, avg ${formatSignedCurrency(summary.avgPnl)}/trade. Consistent entry timing shows discipline. Log more sessions across varying times to unlock sub-window comparison.`,
        keyPhrases: [windowLabel, formatSignedCurrency(summary.netPnl)],
        tags: [
          { label: windowLabel, tone: 'neutral' },
          { label: `${formatSignedCurrency(summary.netPnl)} total`, tone: summary.netPnl >= 0 ? 'positive' : 'negative' },
          { label: `${formatSignedCurrency(summary.avgPnl)} avg/trade`, tone: summary.avgPnl >= 0 ? 'positive' : 'negative' },
        ],
        actionLabel: 'Add to pre-session rules ->',
      };
    }

    // Multiple windows — rank by avg P&L to find worst and best sub-period
    const bucketStats = significantBuckets.map(b => ({ ...b, stats: summarize(b.trades) }));
    const ranked = [...bucketStats].sort((a, b) => a.stats.avgPnl - b.stats.avgPnl);
    const worst = ranked[0];
    const best = ranked[ranked.length - 1];
    const avgGap = best.stats.avgPnl - worst.stats.avgPnl;
    const worstIsNegative = worst.stats.netPnl < 0;
    const isSignificant = Math.abs(worst.stats.netPnl) > 50 || avgGap > 75;

    if (worstIsNegative && isSignificant) {
      return {
        type: 'risk' as const,
        badge: 'Risk Flag',
        frequency: `${worst.trades.length} trades in ${worst.label} · ${tradingSessions} sessions`,
        title: `Your ${worst.label} entries are your weakest window — cut them`,
        body: `${worst.trades.length} trade${worst.trades.length !== 1 ? 's' : ''} in the ${worst.label} window averaged ${formatSignedCurrency(worst.stats.avgPnl)}/trade (${formatSignedCurrency(worst.stats.netPnl)} total, ${Math.round(worst.stats.winRate)}% win rate). Your ${best.label} window averaged ${formatSignedCurrency(best.stats.avgPnl)}/trade — a ${formatSignedCurrency(avgGap)} gap per trade. Skipping ${worst.label} entries is your highest-leverage rule right now.`,
        keyPhrases: [worst.label, best.label, formatSignedCurrency(worst.stats.netPnl)],
        tags: [
          { label: `${formatSignedCurrency(worst.stats.netPnl)} in ${worst.label}`, tone: 'negative' },
          { label: `${worst.trades.length} flagged trades`, tone: 'neutral' },
          { label: `${formatSignedCurrency(best.stats.avgPnl)} avg in ${best.label}`, tone: best.stats.avgPnl >= 0 ? 'positive' : 'neutral' },
        ],
        actionLabel: 'Add to pre-session rules ->',
      };
    }

    // No clearly negative window — show the distribution
    const overallSummary = summarize(timedTrades);
    return {
      type: 'pattern' as const,
      badge: 'Session Note',
      frequency: `${timedTrades.length} timed trades · ${windowLabel} · ${tradingSessions} sessions`,
      title: `Best window: ${best.label} — no major drag detected in ${windowLabel}`,
      body: `Across ${timedTrades.length} timed trades in the ${windowLabel} range, your strongest window is ${best.label} at ${formatSignedCurrency(best.stats.avgPnl)}/trade avg${worstIsNegative ? `, with ${worst.label} your softest spot at ${formatSignedCurrency(worst.stats.avgPnl)}/trade. Keep monitoring — patterns sharpen as sample size grows.` : `. Overall avg ${formatSignedCurrency(overallSummary.avgPnl)}/trade — consistent performance across your session.`}`,
      keyPhrases: [best.label, windowLabel, formatSignedCurrency(overallSummary.avgPnl)],
      tags: [
        { label: `${formatSignedCurrency(overallSummary.netPnl)} net`, tone: overallSummary.netPnl >= 0 ? 'positive' : 'negative' },
        { label: `Best: ${best.label}`, tone: 'positive' },
        ...(worstIsNegative ? [{ label: `Watch: ${worst.label}`, tone: 'negative' as const }] : []),
      ],
      actionLabel: 'Add to pre-session rules ->',
    };
  })();

  const insights: WeeklyInsight[] = ([
    timeInsight,
    (() => {
      if (!topSymbol) {
        return {
          type: 'pattern' as const,
          badge: 'Instrument Review',
          frequency: 'Not enough symbol data',
          title: 'No recurring symbol pattern detected',
          body: 'Log more symbol-tagged trades to activate instrument performance tracking.',
          keyPhrases: ['symbol-tagged trades', 'pattern detection'],
          tags: [{ label: 'Need more samples', tone: 'neutral' as TagTone }],
          actionLabel: 'Promote to pattern library ->',
        };
      }

      const uniqueSymbols = symbolGroups.size;
      const count = topSymbol[1].length;
      const wr = Math.round(topSymbolSummary.winRate);
      const netPnl = topSymbolSummary.netPnl;
      const avgPnl = netPnl / Math.max(1, count);
      const isBreakeven = Math.abs(netPnl) < 25 && count >= 2;

      const pnlPhrase = isBreakeven
        ? `breakeven at ${formatSignedCurrency(netPnl)} across ${count} trade${count !== 1 ? 's' : ''}`
        : `${formatSignedCurrency(netPnl)} net across ${count} trade${count !== 1 ? 's' : ''} (${formatSignedCurrency(avgPnl)}/trade avg)`;

      // Minimum sample before drawing conclusions — scales with the timeframe
      const MIN_SAMPLE = tf === '1W' ? 3 : tf === '1M' ? 5 : tf === '3M' ? 8 : 10;

      // Single-instrument trader — "dominant" is meaningless, give a pure edge review instead
      if (uniqueSymbols <= 1) {
        // Not enough data — don't fire strong conclusions from a handful of trades
        if (count < MIN_SAMPLE) {
          const needed = MIN_SAMPLE - count;
          return {
            type: 'pattern' as InsightType,
            badge: 'Instrument Review',
            frequency: `${count} ${topSymbolName} trade${count !== 1 ? 's' : ''} this period`,
            title: `${needed} more trade${needed !== 1 ? 's' : ''} needed to assess ${topSymbolName} edge`,
            body: `${count} trade${count !== 1 ? 's' : ''} isn't enough to draw conclusions. Log at least ${MIN_SAMPLE} ${topSymbolName} trades in this period before reading into win rate or P&L.`,
            keyPhrases: [topSymbolName, `${MIN_SAMPLE} trades`],
            tags: [
              { label: `${count}/${MIN_SAMPLE} trades`, tone: 'neutral' as TagTone },
              { label: `${formatSignedCurrency(netPnl)} so far`, tone: (netPnl >= 0 ? 'positive' : 'negative') as TagTone },
            ],
            actionLabel: 'Keep logging ->',
          };
        }
        const edgeStatus = wr >= 55 && netPnl > 0
          ? `Edge is confirming on ${topSymbolName}. Keep conditions tight and risk consistent.`
          : wr < 45 && netPnl < 0
            ? `Win rate and P&L are both pointing the wrong way. Review your ${topSymbolName} entries — either the edge has shifted or execution is breaking down.`
            : isBreakeven
              ? `No clear edge showing yet on ${topSymbolName}. Focus on trade quality over trade frequency.`
              : `Mixed signals on ${topSymbolName} — monitor over the next ${Math.max(5, count)} trades before drawing conclusions.`;
        return {
          type: (wr < 45 && netPnl < 0 ? 'risk' : netPnl > 0 ? 'edge' : 'pattern') as InsightType,
          badge: 'Instrument Review',
          frequency: `${count} ${topSymbolName} trade${count !== 1 ? 's' : ''} · ${wr}% win rate`,
          title: `${topSymbolName} edge check — ${wr >= 55 && netPnl > 0 ? 'holding up' : wr < 45 && netPnl < 0 ? 'needs review' : 'mixed signals'}`,
          body: `${topSymbolName}: ${wr}% win rate, ${pnlPhrase}. ${edgeStatus}`,
          keyPhrases: [topSymbolName, formatSignedCurrency(netPnl), `${wr}%`],
          tags: [
            { label: `${formatSignedCurrency(netPnl)} net`, tone: (netPnl >= 0 ? 'positive' : 'negative') as TagTone },
            { label: `${wr}% win rate`, tone: (wr >= 50 ? 'positive' : 'negative') as TagTone },
            { label: `${count} trades`, tone: 'neutral' as TagTone },
          ],
          actionLabel: 'Review entries ->',
        };
      }

      // Multiple instruments — surface the worst underperformer if it's clearly negative,
      // otherwise show the leader with distribution context
      const symbolStats = Array.from(symbolGroups.entries()).map(([sym, symTrades]) => ({
        sym, symTrades, stats: summarize(symTrades),
      }));
      const worstSymbol = [...symbolStats].sort((a, b) => a.stats.netPnl - b.stats.netPnl)[0];
      const worstWr = Math.round(worstSymbol.stats.winRate);
      const worstIsDragging = worstSymbol.stats.netPnl < -50 && worstWr < 45 && worstSymbol.symTrades.length >= MIN_SAMPLE;

      if (worstIsDragging && worstSymbol.sym !== topSymbolName) {
        const worstAvg = worstSymbol.stats.netPnl / Math.max(1, worstSymbol.symTrades.length);
        return {
          type: 'risk' as const,
          badge: 'Instrument Drag',
          frequency: `${worstSymbol.sym} · ${worstSymbol.symTrades.length} trades · ${worstWr}% win rate`,
          title: `${worstSymbol.sym} is your worst-performing instrument — consider a pause`,
          body: `${worstSymbol.sym}: ${worstWr}% win rate, ${formatSignedCurrency(worstSymbol.stats.netPnl)} net across ${worstSymbol.symTrades.length} trade${worstSymbol.symTrades.length !== 1 ? 's' : ''} (${formatSignedCurrency(worstAvg)}/trade avg). Your other instruments are performing better. Pausing ${worstSymbol.sym} until the edge is validated is your highest-leverage move.`,
          keyPhrases: [worstSymbol.sym, formatSignedCurrency(worstSymbol.stats.netPnl), `${worstWr}%`],
          tags: [
            { label: `${formatSignedCurrency(worstSymbol.stats.netPnl)} on ${worstSymbol.sym}`, tone: 'negative' as TagTone },
            { label: `${worstSymbol.symTrades.length} flagged trades`, tone: 'neutral' as TagTone },
            { label: `${uniqueSymbols} instruments traded`, tone: 'neutral' as TagTone },
          ],
          actionLabel: 'Pause this instrument ->',
        };
      }

      // Top performer is worth highlighting
      const addendum = wr >= 60 && netPnl > 50
        ? ` Edge is confirming on ${topSymbolName}. Keep conditions tight and risk consistent.`
        : wr < 45 && netPnl < 0
          ? ` Despite being your most-traded instrument, ${topSymbolName} is underperforming. Review entries before sizing up.`
          : '';
      return {
        type: (netPnl >= 0 ? 'edge' : 'pattern') as InsightType,
        badge: 'Recurring Pattern',
        frequency: `${topSymbolName} · ${count} of ${periodTrades.length} trades · ${uniqueSymbols} instruments`,
        title: `${topSymbolName} leads your ${periodLabel} trade distribution`,
        body: `${topSymbolName}: ${wr}% win rate, ${pnlPhrase}.${addendum}`,
        keyPhrases: [topSymbolName, formatSignedCurrency(netPnl), `${wr}%`],
        tags: [
          { label: `${formatSignedCurrency(netPnl)} on ${topSymbolName}`, tone: (netPnl >= 0 ? 'positive' : 'negative') as TagTone },
          { label: `${wr}% win rate`, tone: (wr >= 50 ? 'positive' : 'negative') as TagTone },
          { label: `${uniqueSymbols} instruments`, tone: 'neutral' as TagTone },
        ],
        actionLabel: 'Promote to pattern library ->',
      };
    })(),
    ...(hasEnoughPsychData && psychWeakest && psychStrongest ? [{
      type: 'psychology' as const,
      badge: 'Psychology',
      frequency: `${meaningfulStates.length} emotional states logged`,
      title: `"${psychWeakest.state}" is your biggest performance liability ${periodLabel}`,
      body: (() => {
        const gap = Math.abs(psychStrongest.summary.avgPnl - psychWeakest.summary.avgPnl);
        const hardStop = gap > 30
          ? ` That ${formatSignedCurrency(gap)} gap per trade is not noise — you should not be entering trades when you feel "${psychWeakest.state}".`
          : ` Track this across more sessions — if the gap holds, this emotional state warrants a pre-session gate, not just a note.`;
        return `"${psychWeakest.state}" averaged ${formatSignedCurrency(psychWeakest.summary.avgPnl)} vs "${psychStrongest.state}" at ${formatSignedCurrency(psychStrongest.summary.avgPnl)} ${periodLabel}.${hardStop}`;
      })(),
      keyPhrases: [`"${psychWeakest.state}"`, formatSignedCurrency(psychWeakest.summary.avgPnl), `"${psychStrongest.state}"`, formatSignedCurrency(psychStrongest.summary.avgPnl)],
      tags: [
        { label: `${psychWeakest.state}: ${formatSignedCurrency(psychWeakest.summary.netPnl)}`, tone: psychWeakest.summary.netPnl >= 0 ? 'positive' as const : 'negative' as const },
        { label: `${psychStrongest.state}: ${formatSignedCurrency(psychStrongest.summary.netPnl)}`, tone: psychStrongest.summary.netPnl >= 0 ? 'positive' as const : 'negative' as const },
      ],
      actionLabel: 'Create emotional reset rule ->',
    }] : []),
    (() => {
      if (!bestSession) {
        return {
          type: 'pattern' as const,
          badge: 'Session Review',
          frequency: `No clear session edge ${periodLabel}`,
          title: 'Session edge needs more data',
          body: 'Keep logging session tags to reveal your strongest time-window edge.',
          keyPhrases: ['session tags', 'time-window edge'],
          tags: [{ label: 'Need session samples', tone: 'neutral' as TagTone }],
          actionLabel: 'Add to pre-session brief ->',
        };
      }

      const uniqueSessions = sessionGroups.size;
      const { session, entries, summary } = bestSession;
      const wr = Math.round(summary.winRate);
      const count = entries.length;

      const SESSION_MIN = tf === '1W' ? 3 : tf === '1M' ? 5 : tf === '3M' ? 8 : 10;

      // Single-session trader — session comparison is meaningless.
      // Instead show a day-of-week breakdown, which is genuinely non-redundant.
      if (uniqueSessions <= 1) {
        const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayGroups = new Map<string, Trade[]>();
        periodTrades.forEach(trade => {
          const date = parseTradeDate(trade);
          if (!date) return;
          const day = DAYS[date.getDay()];
          dayGroups.set(day, [...(dayGroups.get(day) ?? []), trade]);
        });
        const dayStats = Array.from(dayGroups.entries())
          .map(([day, ts]) => ({ day, stats: summarize(ts), count: ts.length }))
          .filter(d => d.count >= 2) // need at least 2 trades per day to be meaningful
          .sort((a, b) => b.stats.avgPnl - a.stats.avgPnl);

        // Need at least 2 days with 2+ trades to say anything useful
        if (dayStats.length >= 2) {
          const best = dayStats[0];
          const worst = dayStats[dayStats.length - 1];
          const gap = best.stats.avgPnl - worst.stats.avgPnl;
          const worstIsNegative = worst.stats.netPnl < 0;
          const isSignificant = Math.abs(gap) > 50 || (worstIsNegative && Math.abs(worst.stats.netPnl) > 100);
          if (isSignificant) {
            return {
              type: (worstIsNegative ? 'risk' : 'edge') as InsightType,
              badge: worstIsNegative ? 'Day Pattern' : 'Day Pattern',
              frequency: `${periodTrades.length} trades across ${dayStats.length} days`,
              title: worstIsNegative
                ? `${worst.day} is your weakest trading day — consider sitting it out`
                : `${best.day} is your strongest day — lean into it`,
              body: `${best.day}: ${Math.round(best.stats.winRate)}% win rate, ${formatSignedCurrency(best.stats.avgPnl)}/trade avg (${best.count} trades). ${worst.day}: ${Math.round(worst.stats.winRate)}% win rate, ${formatSignedCurrency(worst.stats.avgPnl)}/trade avg (${worst.count} trades). ${formatSignedCurrency(gap)} avg gap between your best and worst day.${worstIsNegative ? ` Skipping ${worst.day} entirely is a simple rule with immediate P&L impact.` : ''}`,
              keyPhrases: [best.day, worst.day, formatSignedCurrency(gap)],
              tags: [
                { label: `${best.day}: ${formatSignedCurrency(best.stats.avgPnl)} avg`, tone: (best.stats.avgPnl >= 0 ? 'positive' : 'negative') as TagTone },
                { label: `${worst.day}: ${formatSignedCurrency(worst.stats.avgPnl)} avg`, tone: (worst.stats.avgPnl >= 0 ? 'positive' : 'negative') as TagTone },
              ],
              actionLabel: 'Add to pre-session rules ->',
            };
          }
        }

        // Not enough day-of-week data — suppress this insight entirely
        // (stats card already shows the P&L; repeating it here adds nothing)
        return null;
      }

      // Multiple sessions — actual comparison is meaningful
      const sessionRanked = Array.from(sessionGroups.entries())
        .map(([s, ts]) => ({ session: s, entries: ts, summary: summarize(ts) }))
        .sort((a, b) => a.summary.netPnl - b.summary.netPnl);
      const worstSess = sessionRanked[0];
      const worstWr = Math.round(worstSess.summary.winRate);
      const worstIsDragging = worstSess.summary.netPnl < -50 && worstWr < 45 && worstSess.entries.length >= SESSION_MIN;

      // If worst session is clearly dragging, surface that instead of the best
      if (worstIsDragging && worstSess.session !== session) {
        return {
          type: 'risk' as const,
          badge: 'Session Drag',
          frequency: `${worstSess.session} · ${worstSess.entries.length} trades · ${worstWr}% win rate`,
          title: `${worstSess.session} session is your weakest window — consider skipping it`,
          body: `${worstSess.session}: ${worstWr}% win rate, ${formatSignedCurrency(worstSess.summary.netPnl)} net across ${worstSess.entries.length} trade${worstSess.entries.length !== 1 ? 's' : ''}. Your ${session} session is significantly stronger at ${wr}% win rate. Cutting ${worstSess.session} trades is your highest-leverage rule right now.`,
          keyPhrases: [worstSess.session, session, formatSignedCurrency(worstSess.summary.netPnl)],
          tags: [
            { label: `${formatSignedCurrency(worstSess.summary.netPnl)} in ${worstSess.session}`, tone: 'negative' as TagTone },
            { label: `${formatSignedCurrency(summary.netPnl)} in ${session}`, tone: (summary.netPnl >= 0 ? 'positive' : 'neutral') as TagTone },
            { label: `${uniqueSessions} sessions`, tone: 'neutral' as TagTone },
          ],
          actionLabel: 'Add session filter rule ->',
        };
      }

      // Best session is meaningful — only call it "Edge Confirmed" if it's actually positive
      const isConfirmed = summary.netPnl > 0 && wr >= 50;
      return {
        type: (isConfirmed ? 'edge' : 'pattern') as InsightType,
        badge: isConfirmed ? 'Edge Confirmed' : 'Session Review',
        frequency: `${session} led ${periodLabel} · ${uniqueSessions} sessions traded`,
        title: isConfirmed
          ? `${session} is your strongest edge window ${periodLabel}`
          : `${session} leads by volume but edge isn't confirmed yet`,
        body: `${session}: ${wr}% win rate, ${formatSignedCurrency(summary.netPnl)} net across ${count} trade${count !== 1 ? 's' : ''} (${formatSignedCurrency(summary.netPnl / Math.max(1, count))}/trade avg). ${isConfirmed ? `Clear session edge — prioritise ${session} entries and let the other sessions come to you.` : `Win rate and/or P&L needs to improve before this qualifies as a confirmed edge.`}`,
        keyPhrases: [session, formatSignedCurrency(summary.netPnl), `${wr}%`],
        tags: [
          { label: `${formatSignedCurrency(summary.netPnl)} net`, tone: (summary.netPnl >= 0 ? 'positive' : 'negative') as TagTone },
          { label: `${wr}% win rate`, tone: (wr >= 50 ? 'positive' : 'negative') as TagTone },
          { label: `${uniqueSessions} sessions`, tone: 'neutral' as TagTone },
        ],
        actionLabel: 'Add to pre-session brief ->',
      };
    })(),
  ] as (WeeklyInsight | null)[]).filter((x): x is WeeklyInsight => x !== null);

  if (topConfluence) {
    // Minimum trades needed before a confluence result is statistically meaningful.
    // With too few observations, win rate and net P&L are dominated by single-trade noise.
    const MIN_CONFLUENCE = tf === '1W' ? 3 : tf === '1M' ? 5 : tf === '3M' ? 8 : 10;
    const confluenceSampleValid = topConfluence.trades >= MIN_CONFLUENCE;

    if (!confluenceSampleValid) {
      // Not enough data — report honestly rather than flagging good/bad
      insights.push({
        type: 'pattern',
        badge: 'Confluence Signal',
        frequency: `${topConfluence.trades} trade${topConfluence.trades !== 1 ? 's' : ''} logged with "${topConfluence.label}"`,
        title: `"${topConfluence.label}" — too early to read`,
        body: `${topConfluence.trades} trade${topConfluence.trades !== 1 ? 's' : ''} is not a large enough sample to draw any conclusions. A single outcome can swing win rate from 0% to 100% and P&L by hundreds. Log at least ${MIN_CONFLUENCE} trades tagged "${topConfluence.label}" before treating any signal here as real.`,
        keyPhrases: [`"${topConfluence.label}"`, `${MIN_CONFLUENCE} trades`],
        tags: [
          { label: `${topConfluence.trades}/${MIN_CONFLUENCE} min trades`, tone: 'neutral' },
          { label: 'Insufficient sample', tone: 'neutral' },
        ],
        actionLabel: 'Review this confluence in pattern library ->',
      });
    } else {
      // Enough data — classify the signal properly
      const strongEdge = topConfluence.winRate >= 55 && topConfluence.netPnl > 0;
      const clearRisk  = topConfluence.winRate < 45 && topConfluence.netPnl < 0;
      insights.push({
        type: strongEdge ? 'edge' : clearRisk ? 'risk' : 'pattern',
        badge: 'Confluence Signal',
        frequency: `${topConfluence.trades} trades logged with "${topConfluence.label}"`,
        title: strongEdge
          ? `"${topConfluence.label}" is your highest-conviction confluence ${periodLabel}`
          : clearRisk
            ? `"${topConfluence.label}" is underperforming — review before reuse`
            : `"${topConfluence.label}" shows mixed results ${periodLabel}`,
        body: `Across ${topConfluence.trades} trades, "${topConfluence.label}" returned ${formatSignedCurrency(topConfluence.netPnl)} total (${formatSignedCurrency(topConfluence.avgPnl)} avg) with ${Math.round(topConfluence.winRate)}% win rate.`,
        keyPhrases: [
          `"${topConfluence.label}"`,
          formatSignedCurrency(topConfluence.netPnl),
          formatSignedCurrency(topConfluence.avgPnl),
          `${Math.round(topConfluence.winRate)}%`,
        ],
        tags: [
          { label: `${topConfluence.trades} tagged trades`, tone: 'neutral' },
          { label: `${Math.round(topConfluence.winRate)}% win rate`, tone: topConfluence.winRate >= 50 ? 'positive' : 'negative' },
          { label: `${formatSignedCurrency(topConfluence.netPnl)} net`, tone: topConfluence.netPnl >= 0 ? 'positive' : 'negative' },
        ],
        actionLabel: 'Review this confluence in pattern library ->',
      });
    }
  }

  const focusItems: string[] = [];
  const byLabel = new Map(periodProcess.items.map(item => [item.label, item.value]));

  // Entry patience — compute early vs confirmed entry P&L if enough data
  const entryScore = byLabel.get('Entry patience') ?? 0;
  if (entryScore < 70) {
    const earlyEntries = periodTrades.filter(t => {
      if (!t.trade_time) return false;
      const [hStr, mStr] = t.trade_time.split(':');
      const h = Number(hStr); const m = Number(mStr ?? 0);
      return h < 9 || (h === 9 && m < 45);
    });
    const confirmedEntries = periodTrades.filter(t => {
      if (!t.trade_time) return false;
      const [hStr, mStr] = t.trade_time.split(':');
      const h = Number(hStr); const m = Number(mStr ?? 0);
      return h > 9 || (h === 9 && m >= 45);
    });
    const earlyAvg = earlyEntries.length ? earlyEntries.reduce((s, t) => s + Number(t.pnl ?? 0), 0) / earlyEntries.length : null;
    const confirmedAvg = confirmedEntries.length ? confirmedEntries.reduce((s, t) => s + Number(t.pnl ?? 0), 0) / confirmedEntries.length : null;
    if (earlyAvg !== null && confirmedAvg !== null && earlyEntries.length >= 2 && confirmedEntries.length >= 2) {
      const gap = Math.abs(confirmedAvg - earlyAvg);
      focusItems.push(`Entry patience scored ${entryScore}/100. Your ${earlyEntries.length} early entries averaged ${formatSignedCurrency(earlyAvg)} per trade compared to ${formatSignedCurrency(confirmedAvg)} for entries placed after the opening window settled — a ${formatSignedCurrency(gap)} gap per trade. That difference is the measurable cost of anticipating rather than confirming.`);
    } else {
      focusItems.push(`Entry patience is at ${entryScore}/100 — entries are being placed before the opening structure has formed. Define the specific price action condition that needs to appear before the order goes in, and treat anything that doesn't meet it as a pass, not a delayed entry.`);
    }
  }

  // Post-loss management
  const postLossItem = periodProcess.items.find(i => i.label === 'Post-loss mgmt');
  if (postLossItem && !postLossItem.noData && postLossItem.value < 65) {
    const lossCount = periodTrades.filter(t => Number(t.pnl ?? 0) < 0).length;
    focusItems.push(`Post-loss management scored ${postLossItem.value}/100 across ${lossCount} losing trade${lossCount !== 1 ? 's' : ''} this period. The data suggests re-entries are happening too quickly after losses — before sizing has reset or before the reactive state has cleared. Compound losses, where one bad trade leads immediately into another, are almost always a pacing problem, not an edge problem.`);
  }

  // Plan adherence
  const planScore = byLabel.get('Plan adherence') ?? 0;
  if (planScore < 75) {
    if (periodRuleReport.checked > 0 && periodRuleReport.mostBrokenRule) {
      const rule = periodRuleReport.mostBrokenRule;
      focusItems.push(`Plan adherence is at ${planScore}/100. "${rule.label}" broke ${rule.failed} time${rule.failed !== 1 ? 's' : ''} this period and appeared on ${rule.dates.length} day${rule.dates.length !== 1 ? 's' : ''}. That is now the rule to protect first — make it visible before entry and require a deliberate pass/fail confirmation.`);
    } else {
    const violations = periodTrades.filter(t => t.followed_plan === false);
    const violPnl = violations.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
    if (violations.length >= 2) {
      focusItems.push(`Plan adherence is at ${planScore}/100. ${violations.length} of ${periodTrades.length} trades deviated from the stated plan and those ${violations.length} totalled ${formatSignedCurrency(violPnl)}. Drift almost never looks like ignoring the plan — it looks like entering a trade that's close enough and rationalising the missing conditions. The conditions that get skipped are the ones that mattered.`);
    } else {
      focusItems.push(`Plan adherence is at ${planScore}/100. The most common form of drift is entering a trade that partially meets criteria and rationalising the gap — the trade feels valid in the moment but the missing condition was load-bearing. Before each entry, state what specifically needs to be true, and if any one condition isn't present, that's the signal to pass.`);
    }
  }
    }

  // Size discipline
  const sizeScore = byLabel.get('Size discipline') ?? 0;
  if (sizeScore < 75) {
    focusItems.push(`Size discipline scored ${sizeScore}/100. Discretionary size changes typically happen when conviction is high — but confidence peaks right before a trade fails as often as right before it works. At ${Math.round(periodSummary.winRate)}% win rate this period, consistency in sizing does more for your P&L than trying to optimise which trades get more size.`);
  }

  // Weakest confluence
  const MIN_CONFLUENCE_FOCUS = tf === '1W' ? 3 : tf === '1M' ? 5 : tf === '3M' ? 8 : 10;
  if (weakestConfluence && weakestConfluence.trades >= MIN_CONFLUENCE_FOCUS) {
    focusItems.push(`"${weakestConfluence.label}" has appeared in ${weakestConfluence.trades} trades at ${Math.round(weakestConfluence.winRate)}% win rate and ${formatSignedCurrency(weakestConfluence.netPnl)} net — averaging ${formatSignedCurrency(weakestConfluence.avgPnl)} per trade. The confluence is subtracting from your edge rather than adding to it. Until the sample shows a consistent positive result, treat it as a secondary filter, not a standalone trigger.`);
  }

  const nextSunday = (() => {
    const day = periodEnd.getDay();
    const days = ((7 - day) % 7) || 7;
    return addDays(periodEnd, days);
  })();

  return {
    weekRange: formatPeriodRange(displayStart, displayEnd),
    sessionCount,
    tradeCount: periodTrades.length,
    instruments,
    stats: {
      netR: { label: 'Net PL', value: formatSignedCurrency(periodSummary.netPnl), subLabel: tf !== 'All' ? `vs ${formatSignedCurrency(previousSummary.netPnl)} ${prevLabel}` : `${periodTrades.length} trades`, tone: periodSummary.netPnl >= 0 ? 'positive' : 'negative' },
      winRate: { label: 'Win Rate', value: `${Math.round(periodSummary.winRate)}%`, subLabel: `${periodSummary.wins}W / ${periodSummary.losses}L`, tone: 'neutral' },
      avgWinner: { label: 'Avg Winner', value: formatSignedCurrency(periodSummary.avgWinnerPnl), subLabel: `Best ${formatSignedCurrency(periodSummary.bestPnl)}`, tone: periodSummary.avgWinnerPnl >= 0 ? 'positive' : 'neutral' },
      avgLoser: { label: 'Avg Loser', value: formatSignedCurrency(periodSummary.avgLoserPnl), subLabel: `Worst ${formatSignedCurrency(periodSummary.worstPnl)}`, tone: periodSummary.avgLoserPnl < 0 ? 'negative' : 'neutral' },
      processScore: { label: 'Process Score', value: `${periodProcess.score}/100`, subLabel: `${processDiff >= 0 ? '+' : ''}${processDiff} vs 90-day avg`, tone: 'info' },
    },
    question,
    insights,
    processBreakdown: periodProcess.items,
    confluences: confluenceLeaders.slice(0, 4),
    focusItems: focusItems.slice(0, 3),
    nextDebrief: {
      generatedOn: nextSunday.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }),
      sessionsLogged: sessionCount,
      sessionsTarget: tf === '1W' ? 5 : tf === '1M' ? 20 : tf === '3M' ? 60 : 100,
    },
  };
}
