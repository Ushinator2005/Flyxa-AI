import { CSSProperties, useMemo, useState } from 'react';
import { Clock3, AlertTriangle } from 'lucide-react';
import { NavLink, useSearchParams, useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';
import useFlyxaStore from '../store/flyxaStore.js';

type InsightType = 'risk' | 'pattern' | 'psychology' | 'edge';
type TagTone = 'positive' | 'negative' | 'neutral';

type WeeklyStat = {
  label: string;
  value: string;
  subLabel: string;
  tone: 'positive' | 'negative' | 'neutral' | 'info';
};

type WeeklyInsight = {
  type: InsightType;
  badge: string;
  frequency: string;
  title: string;
  body: string;
  keyPhrases: string[];
  tags: Array<{ label: string; tone: TagTone }>;
  actionLabel: string;
};

type ProcessBreakdownItem = { label: string; value: number; noData?: boolean; note?: string };
type ConfluenceHighlight = { label: string; trades: number; winRate: number; netPnl: number; avgPnl: number };

type WeeklyDebriefData = {
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


const colors = {
  d0: 'var(--d0, #0e0d0d)',
  d1: 'var(--d1, #141312)',
  d2: 'var(--d2, #1a1917)',
  d3: 'var(--d3, #201f1d)',
  d4: 'var(--d4, #27251f)',
  b0: 'var(--b0, rgba(255,255,255,0.07))',
  b1: 'var(--b1, rgba(255,255,255,0.12))',
  t0: 'var(--t0, #e8e3dc)',
  t1: 'var(--t1, #8a8178)',
  t2: 'var(--t2, #5c5751)',
  acc: 'var(--acc, #f59e0b)',
  grn: 'var(--grn, #22d68a)',
  red: 'var(--red, #f05252)',
  amb: 'var(--amb, #f59e0b)',
  blu: 'var(--blu, #f59e0b)',
  mono: 'var(--mono, \'DM Mono\', ui-monospace, monospace)',
};

const insightTypeStyles: Record<InsightType, { accent: string }> = {
  risk: { accent: colors.red },
  pattern: { accent: colors.blu },
  psychology: { accent: colors.amb },
  edge: { accent: colors.grn },
};

const tinyMetaLabelStyle: CSSProperties = {
  fontSize: 9.5,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: colors.t2,
};

const cardBorder = `1px solid ${colors.b0}`;

function avg(values: number[]) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

function pct(part: number, whole: number) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

/** Returns midnight on the Monday of the current calendar week. */
function thisWeekMonday(): Date {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dow = today.getDay(); // 0=Sun,1=Mon,...,6=Sat
  const daysToMon = dow === 0 ? 6 : dow - 1;
  today.setDate(today.getDate() - daysToMon);
  return today;
}

type TimeFrame = '1W' | '1M' | '3M' | 'All';

function getPeriodWindow(tf: TimeFrame, weekOffset = 0) {
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

function formatPeriodRange(start: Date, end: Date): string {
  if (start.getTime() <= 1000) return `All time · through ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (start.getFullYear() !== end.getFullYear()) {
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`;
}

function parseTradeDate(trade?: Partial<Trade> | null): Date | null {
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

function parseTradeDateTime(trade?: Partial<Trade> | null): Date | null {
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

function tradeMinutes(trade?: Partial<Trade> | null): number | null {
  if (!trade) return null;
  // ApiTrade uses trade_time; StoreTrade uses time
  const timeStr = trade.trade_time || (trade as unknown as { time?: string }).time;
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return (h * 60) + m;
}

function tradeSessionKey(trade?: Partial<Trade> | null) {
  const date = parseTradeDate(trade);
  return date ? date.toISOString().slice(0, 10) : '';
}

function formatCurrency(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedCurrency(value: number) {
  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}

function formatSignedCompactCurrency(value: number) {
  const compact = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(value)).replace('K', 'k');
  return `${value >= 0 ? '+' : '-'}${compact}`;
}

function normalizeConfluences(value: unknown): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const deduped = new Set<string>();
  const normalized: string[] = [];

  for (const entry of rawValues) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.trim().replace(/\s+/g, ' ');
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (deduped.has(key)) continue;
    deduped.add(key);
    normalized.push(cleaned);
  }

  return normalized;
}

function tradeR(trade?: Partial<Trade> | null): number {
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

function summarize(trades: Trade[]) {
  const rs = trades.map(tradeR);
  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl < 0);
  const winnerRs = winners.map(tradeR);
  const loserRs = losers.map(tradeR);
  const pnls = trades.map(trade => Number(trade.pnl ?? 0));
  const winnerPnls = winners.map(trade => Number(trade.pnl ?? 0));
  const loserPnls = losers.map(trade => Number(trade.pnl ?? 0));
  return {
    netR: rs.reduce((s, r) => s + r, 0),
    netPnl: trades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0),
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

function processBreakdown(trades: Trade[]) {
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
  const plan = Math.round(rawPlan * coverage);

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
      { label: 'Plan adherence', value: plan, note: coverage < 1 ? `${Math.round(coverage * 100)}% of trades logged` : undefined },
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

function statToneColor(tone: WeeklyStat['tone']) {
  if (tone === 'positive') return colors.grn;
  if (tone === 'negative') return colors.red;
  if (tone === 'info') return colors.amb;
  return colors.t0;
}

function tagStyle(_tone: TagTone): CSSProperties {
  return {
    color: colors.t1,
    backgroundColor: colors.d3,
    border: `1px solid ${colors.b0}`,
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 10.5,
    lineHeight: 1.3,
    fontFamily: colors.mono,
  };
}

function breakdownColor(value: number) {
  if (value >= 80) return colors.grn;
  if (value >= 40) return colors.amb;
  return colors.red;
}

function gradeColor(grade: string) {
  if (grade === 'A') return colors.grn;
  if (grade === 'B') return '#60a5fa';
  if (grade === 'C') return colors.amb;
  return colors.red;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderBodyWithHighlights(body: string, keyPhrases: string[]) {
  if (!keyPhrases.length) return body;
  const lookup = new Set(keyPhrases.map(k => k.toLowerCase()));
  const pattern = new RegExp(`(${keyPhrases.map(escapeRegExp).join('|')})`, 'gi');
  return body.split(pattern).map((segment, idx) =>
    lookup.has(segment.toLowerCase()) ? (
      <mark
        key={`${segment}-${idx}`}
        style={{
          color: colors.t0,
          backgroundColor: 'rgba(255,255,255,0.07)',
          borderRadius: 3,
          padding: '1px 4px',
          fontWeight: 500,
        }}
      >
        {segment}
      </mark>
    ) : (
      <span key={`${segment}-${idx}`} style={{ color: colors.t1 }}>
        {segment}
      </span>
    )
  );
}


function formatMins(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

interface TimeBucket {
  start: number;
  end: number;
  label: string;
  trades: Trade[];
}

/** Splits timed trades into the smallest uniform buckets that yield ≥ 2 non-empty groups. */
function buildAdaptiveTimeBuckets(timedTrades: Trade[]): {
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

function buildData(trades: Trade[], tf: TimeFrame = '1W', weekOffset = 0): WeeklyDebriefData {
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
  const periodSummary = summarize(periodTrades);
  const previousSummary = summarize(previous);
  const periodProcess = processBreakdown(periodTrades);
  const rollingProcess = processBreakdown(rolling);
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
    const tradeConfluenceSet = new Set(tradeConfluences.map(confluence => confluence.toLowerCase()));
    const currentPnl = Number(trade.pnl ?? 0);

    tradeConfluenceSet.forEach(confluenceKey => {
      const label = tradeConfluences.find(confluence => confluence.toLowerCase() === confluenceKey) ?? confluenceKey;
      const current = confluenceGroups.get(confluenceKey) ?? {
        label,
        trades: 0,
        wins: 0,
        netPnl: 0,
      };
      current.trades += 1;
      current.netPnl += currentPnl;
      if (trade.pnl > 0) current.wins += 1;
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
    const violations = periodTrades.filter(t => t.followed_plan === false);
    const violPnl = violations.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
    if (violations.length >= 2) {
      focusItems.push(`Plan adherence is at ${planScore}/100. ${violations.length} of ${periodTrades.length} trades deviated from the stated plan and those ${violations.length} totalled ${formatSignedCurrency(violPnl)}. Drift almost never looks like ignoring the plan — it looks like entering a trade that's close enough and rationalising the missing conditions. The conditions that get skipped are the ones that mattered.`);
    } else {
      focusItems.push(`Plan adherence is at ${planScore}/100. The most common form of drift is entering a trade that partially meets criteria and rationalising the gap — the trade feels valid in the moment but the missing condition was load-bearing. Before each entry, state what specifically needs to be true, and if any one condition isn't present, that's the signal to pass.`);
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

export default function FlyxaAI() {
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [respondOpen, setRespondOpen] = useState(false);
  const [respondText, setRespondText] = useState('');
  const [timeframe, setTimeframe] = useState<TimeFrame>('1W');
  const [weekOffset, setWeekOffset] = useState(0);
  const aiReflections = useFlyxaStore(state => state.aiReflections);
  const addAiReflection = useFlyxaStore(state => state.addAiReflection);
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades]
  );
  const safeAccountTrades = useMemo(
    () => accountTrades.filter((trade): trade is Trade => Boolean(trade)),
    [accountTrades]
  );
  const weeklyDebriefData = useMemo(
    () => buildData(safeAccountTrades, timeframe, weekOffset),
    [safeAccountTrades, timeframe, weekOffset]
  );
  const focusedTradeId = searchParams.get('tradeId');
  const focusedTrade = useMemo(
    () => (focusedTradeId ? safeAccountTrades.find(trade => trade.id === focusedTradeId) ?? null : null),
    [focusedTradeId, safeAccountTrades]
  );
  const focusedTradePnl = useMemo(
    () => (focusedTrade ? Number(focusedTrade.pnl ?? 0) : null),
    [focusedTrade]
  );
  const focusedTradeConfluences = useMemo(
    () => normalizeConfluences(focusedTrade?.confluences),
    [focusedTrade]
  );

  const sessionsProgress = Math.min(100, (weeklyDebriefData.nextDebrief.sessionsLogged / weeklyDebriefData.nextDebrief.sessionsTarget) * 100);
  const processScoreNumeric = Number.parseInt(weeklyDebriefData.stats.processScore.value, 10);
  const boundedScore = Math.max(0, Math.min(100, Number.isFinite(processScoreNumeric) ? processScoreNumeric : 0));
  const dedupedFocusItems = Array.from(new Set(weeklyDebriefData.focusItems));
  const remainingSessions = Math.max(0, weeklyDebriefData.nextDebrief.sessionsTarget - weeklyDebriefData.nextDebrief.sessionsLogged);

  const themeVars = {
    '--d0': '#0e0d0d',
    '--d1': '#141312',
    '--d2': '#1a1917',
    '--d3': '#201f1d',
    '--d4': '#27251f',
    '--b0': 'rgba(255,255,255,0.07)',
    '--b1': 'rgba(255,255,255,0.12)',
    '--t0': '#e8e3dc',
    '--t1': '#8a8178',
    '--t2': '#5c5751',
    '--acc': '#f59e0b',
    '--grn': '#22d68a',
    '--red': '#f05252',
    '--amb': '#f59e0b',
    '--blu': '#f59e0b',
    '--mono': '\'DM Mono\', ui-monospace, monospace',
  } as CSSProperties;

  const weeklyWindow = useMemo(() => {
    const ordered = [...safeAccountTrades].sort((a, b) => (parseTradeDateTime(a)?.getTime() ?? 0) - (parseTradeDateTime(b)?.getTime() ?? 0));
    const { periodStart, periodEnd, prevStart, prevEnd } = getPeriodWindow(timeframe, weekOffset);
    const inRange = (trade: Trade, start: Date, end: Date) => {
      const date = parseTradeDate(trade);
      return Boolean(date && date.getTime() >= start.getTime() && date.getTime() <= end.getTime());
    };
    const weeklyTrades = ordered.filter(trade => inRange(trade, periodStart, periodEnd));
    const previousTrades = timeframe !== 'All' ? ordered.filter(trade => inRange(trade, prevStart, prevEnd)) : [];
    return { weeklyTrades, previousTrades };
  }, [safeAccountTrades, timeframe, weekOffset]);

  const previousWeekPnl = useMemo(
    () => summarize(weeklyWindow.previousTrades).netPnl,
    [weeklyWindow.previousTrades]
  );

  const dataCompleteness = useMemo(() => {
    const wt = weeklyWindow.weeklyTrades;
    if (!wt.length) return null;
    const withEmotion = wt.filter(t => t.emotional_state && (t.emotional_state as string) !== 'Unspecified').length;
    const withPlan = wt.filter(t => typeof t.followed_plan === 'boolean').length;
    const withNotes = wt.filter(t => t.post_trade_notes?.trim()).length;
    return {
      total: wt.length,
      emotionPct: Math.round((withEmotion / wt.length) * 100),
      planPct: Math.round((withPlan / wt.length) * 100),
      notesPct: Math.round((withNotes / wt.length) * 100),
    };
  }, [weeklyWindow.weeklyTrades]);
  const netRNumeric = Number.parseFloat(weeklyDebriefData.stats.netR.value.replace(/[^\d.+-]/g, '')) || 0;
  const weakestProcess = useMemo(
    () => [...weeklyDebriefData.processBreakdown].filter(item => !item.noData).sort((a, b) => a.value - b.value)[0],
    [weeklyDebriefData.processBreakdown]
  );
  const violationsByWeakestMetric = Math.max(
    0,
    Math.round((weeklyWindow.weeklyTrades.length * (100 - (weakestProcess?.value ?? 0))) / 100)
  );
  const violationType = weakestProcess?.label === 'Entry patience'
    ? 'Entry timing'
    : weakestProcess?.label === 'Post-loss mgmt'
      ? 'Post-loss impulse'
      : weakestProcess?.label === 'Size discipline'
        ? 'Sizing drift'
        : 'Plan drift';

  const statCells = [
    weeklyDebriefData.stats.winRate,
    weeklyDebriefData.stats.avgWinner,
    weeklyDebriefData.stats.avgLoser,
    weeklyDebriefData.stats.processScore,
    {
      label: 'Rule Violations',
      value: String(violationsByWeakestMetric),
      subLabel: violationType,
      tone: 'negative' as const,
    },
  ];

  const displayedInsights = weeklyDebriefData.insights.slice(0, 4);
  const recentReflections = aiReflections.slice(0, 3);

  function saveReflection() {
    const answer = respondText.trim();
    if (!answer) return;
    const period = getPeriodWindow(timeframe);
    addAiReflection({
      id: crypto.randomUUID(),
      question: weeklyDebriefData.question,
      answer,
      timeframe,
      periodLabel: period.headerLabel,
      createdAt: new Date().toISOString(),
    });
    setRespondOpen(false);
    setRespondText('');
  }

  const sparkline = useMemo(() => {
    const width = 168;
    const height = 42;
    const padX = 6;
    const padTop = 4;
    const padBottom = 6;
    const chartHeight = height - padTop - padBottom;
    const pnls = weeklyWindow.weeklyTrades.map(trade => Number(trade.pnl ?? 0));
    const cumulative: number[] = [0];
    pnls.forEach(pnl => cumulative.push((cumulative[cumulative.length - 1] ?? 0) + pnl));
    const min = Math.min(0, ...cumulative);
    const max = Math.max(0, ...cumulative);
    const dynamicPad = Math.max(20, Math.abs(max - min) * 0.15);
    const scaleMin = min - dynamicPad;
    const scaleMax = max + dynamicPad;
    const range = Math.max(1, scaleMax - scaleMin);
    const xAt = (step: number) => padX + ((step / Math.max(1, cumulative.length - 1)) * (width - (padX * 2)));
    const yAt = (value: number) => padTop + (((scaleMax - value) / range) * chartHeight);
    const baselineY = yAt(0);

    let linePath = `M ${xAt(0)} ${yAt(cumulative[0])}`;
    let areaPath = `M ${xAt(0)} ${baselineY} L ${xAt(0)} ${yAt(cumulative[0])}`;
    for (let index = 1; index < cumulative.length; index += 1) {
      linePath += ` L ${xAt(index)} ${yAt(cumulative[index])}`;
      areaPath += ` L ${xAt(index)} ${yAt(cumulative[index])}`;
    }
    areaPath += ` L ${xAt(cumulative.length - 1)} ${baselineY} Z`;

    const endX = xAt(cumulative.length - 1);
    const endY = yAt(cumulative[cumulative.length - 1] ?? 0);
    const endValue = cumulative[cumulative.length - 1] ?? 0;
    const isNearRightEdge = endX > width - 20;
    const isNearLeftEdge = endX < 20;

    return {
      width,
      height,
      baselineY,
      linePath,
      areaPath,
      endDot: {
        x: endX,
        y: endY,
        labelX: isNearRightEdge ? endX - 4 : isNearLeftEdge ? endX + 4 : endX,
        textAnchor: isNearRightEdge ? 'end' as const : isNearLeftEdge ? 'start' as const : 'middle' as const,
        label: formatSignedCompactCurrency(endValue),
      },
    };
  }, [weeklyWindow.weeklyTrades]);

  const bestTrade = useMemo(() => {
    if (!weeklyWindow.weeklyTrades.length) return null;
    const ranked = weeklyWindow.weeklyTrades
      .map(trade => ({ trade, pnl: Number(trade.pnl ?? 0) }))
      .sort((a, b) => b.pnl - a.pnl);
    const top = ranked[0];
    if (!top) return null;

    const parsed = parseTradeDateTime(top.trade);
    const dateLabel = parsed
      ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : (top.trade.trade_date || '--');

    return {
      symbol: top.trade.symbol || 'N/A',
      direction: top.trade.direction,
      resultPnl: formatSignedCurrency(top.pnl),
      session: top.trade.session || 'Other',
      time: top.trade.trade_time || '--:--',
      date: dateLabel,
      note: top.trade.pre_trade_notes?.trim() || 'Clean execution aligned with your process plan.',
      journal: top.trade.post_trade_notes?.trim() || 'Journal note not captured for this trade yet.',
    };
  }, [weeklyWindow.weeklyTrades]);

  const sessionBreakdownRows = useMemo(() => {
    const labels = ['London', 'New York', 'Asia'] as const;
    const rows = labels.map(label => {
      const tradesForSession = weeklyWindow.weeklyTrades.filter(trade => trade.session === label);
      const netPnl = tradesForSession.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
      const scored = tradesForSession.filter(trade => trade.pnl !== 0);
      const wins = scored.filter(trade => trade.pnl > 0).length;
      const winRate = scored.length ? Math.round((wins / scored.length) * 100) : 0;
      return { label, netPnl, winRate, trades: tradesForSession.length };
    });
    const maxAbs = Math.max(1, ...rows.map(row => Math.abs(row.netPnl)));
    return rows.map(row => ({ ...row, barWidth: row.trades ? Math.max(8, (Math.abs(row.netPnl) / maxAbs) * 100) : 0 }));
  }, [weeklyWindow.weeklyTrades]);

  const dailyBreakdownRows = useMemo(() => {
    const { periodStart, periodEnd } = getPeriodWindow(timeframe, weekOffset);
    const days: Date[] = [];
    const cur = new Date(periodStart); cur.setHours(0, 0, 0, 0);
    const end = new Date(periodEnd);   end.setHours(23, 59, 59, 999);
    while (cur <= end) {
      const dow = cur.getDay();
      if (dow >= 1 && dow <= 5) days.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return days.map(day => {
      const iso = day.toISOString().slice(0, 10);
      const dayLabel = day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const ps = preSessionHistory[iso];
      const dayTrades = weeklyWindow.weeklyTrades.filter(t => t.trade_date === iso);
      const netPnl = dayTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      const wins = dayTrades.filter(t => Number(t.pnl ?? 0) > 0).length;
      const losses = dayTrades.filter(t => Number(t.pnl ?? 0) < 0).length;

      // Bias adherence: for each instrument with a non-Neutral bias, check if trades aligned
      let biasAligned = 0, biasTotal = 0;
      if (ps?.bias && typeof ps.bias === 'object') {
        const biasMap = ps.bias as Record<string, string>;
        for (const [instrument, direction] of Object.entries(biasMap)) {
          if (direction === 'Neutral') continue;
          const instTrades = dayTrades.filter(t =>
            t.symbol?.toUpperCase().includes(instrument.toUpperCase())
          );
          instTrades.forEach(t => {
            biasTotal++;
            const tradeDir = t.direction?.toLowerCase();
            if (direction === 'Bull' && tradeDir === 'long') biasAligned++;
            if (direction === 'Bear' && tradeDir === 'short') biasAligned++;
          });
        }
      }

      return {
        iso, dayLabel, ps,
        trades: dayTrades.length, netPnl, wins, losses,
        biasAligned, biasTotal,
      };
    }).filter(row => row.trades > 0 || row.ps);
  }, [preSessionHistory, timeframe, weekOffset, weeklyWindow.weeklyTrades]);

  const weekGrade = boundedScore >= 90 ? 'A' : boundedScore >= 75 ? 'B' : boundedScore >= 60 ? 'C' : 'D';
  const nextThreshold = weekGrade === 'A' ? null : weekGrade === 'B' ? 90 : weekGrade === 'C' ? 75 : 60;
  const gradeHint = nextThreshold === null
    ? `Process score at ${boundedScore}/100 — all four metrics are holding. The focus now is protecting these conditions rather than changing anything that's working.`
    : `${weakestProcess?.label ?? 'Execution quality'} is scoring ${weakestProcess?.value ?? boundedScore}/100 — the biggest single drag on the overall grade. Closing that specific gap is worth more than adding trades.`;

  const actionItems = useMemo(() => {
    const items: string[] = [];
    const wt = weeklyWindow.weeklyTrades;
    const wp = weakestProcess;

    if (wp?.label === 'Entry patience') {
      items.push(`Entry patience at ${wp.value}/100 — the trade idea is there but the timing is costing edge. The gap between anticipating a move and waiting for it to confirm is where this score lives. Until there's a specific condition defined that triggers the entry, you're relying on feel rather than criteria.`);
    } else if (wp?.label === 'Post-loss mgmt') {
      const lossCount = wt.filter(t => Number(t.pnl ?? 0) < 0).length;
      items.push(`Post-loss management at ${wp.value}/100 across ${lossCount} losing trade${lossCount !== 1 ? 's' : ''} this week. The first loss is rarely the problem — it's what happens in the 30 minutes after it. Re-entering before you've reset the emotional state or the position sizing is where the real damage gets done. A loss doesn't clear itself by winning the next trade.`);
    } else if (wp?.label === 'Size discipline') {
      items.push(`Size discipline at ${wp.value}/100. If the conditions for sizing up aren't defined in advance and objective, the decisions are being made on confidence — and confidence tends to peak right before a trade fails just as often as right before it works. The edge in sizing comes from criteria, not from feel.`);
    } else if (wp?.label === 'Plan adherence') {
      const violations = wt.filter(t => t.followed_plan === false);
      const violPnl = violations.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      if (violations.length > 0) {
        items.push(`Plan adherence at ${wp.value}/100 — ${violations.length} trade${violations.length !== 1 ? 's' : ''} off-plan this week totalling ${formatSignedCurrency(violPnl)}. Every off-plan trade that produces a win makes the next deviation easier to justify. Every one that loses adds to the actual cost. The data has made its argument.`);
      } else {
        items.push(`Plan adherence at ${wp.value}/100 — the gap is in coverage rather than outright violations. Trades logged without plan data count against the score because they can't be verified. Filling in the followed_plan field consistently is what gives this metric its signal.`);
      }
    }

    const riskInsight = displayedInsights.find(i => i.type === 'risk');
    if (riskInsight) {
      const firstSentence = riskInsight.body.split(/[.!?]/)[0];
      items.push(`${firstSentence}. That's not a hypothesis — it's the active risk pattern in the data this period.`);
    }
    const edgeInsight = displayedInsights.find(i => i.type === 'edge');
    if (edgeInsight) {
      const firstSentence = edgeInsight.body.split(/[.!?]/)[0];
      items.push(`${firstSentence}. That's the working edge right now — it deserves priority in terms of preparation and entry selection.`);
    }

    dedupedFocusItems.forEach(item => items.push(item));
    return Array.from(new Set(items)).slice(0, 3);
  }, [dedupedFocusItems, displayedInsights, weakestProcess, weeklyWindow.weeklyTrades]);

  if (loading) {
    return (
      <div className="animate-fade-in flex h-[calc(100vh-3.5rem)] items-center justify-center rounded-2xl" style={{ ...themeVars, backgroundColor: colors.d0 }}>
        <LoadingSpinner size="lg" label="Analyzing your trade journal..." />
      </div>
    );
  }

  return (
    <div className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl" style={{ ...themeVars, backgroundColor: colors.d0, color: colors.t0 }}>
      <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[178px_minmax(0,1fr)_252px]">
        <aside className="hidden lg:block min-h-0 overflow-y-auto border-r px-2 py-4" style={{ backgroundColor: colors.d1, borderColor: colors.b0 }}>
          <div className="px-2">
            <p className="text-[14px] font-bold tracking-[0.1em]" style={{ color: colors.t0 }}>FLYXA</p>
            <p className="mt-0.5 text-[9.5px]" style={{ color: colors.t2 }}>Trading Intelligence</p>
          </div>

          <nav className="mt-4 space-y-0.5">
            {[
              { key: 'weekly', label: 'Debrief', to: '/flyxa-ai', end: true },
              { key: 'weekly-report', label: 'Weekly report', to: '/flyxa-ai/weekly-report', end: false },
              { key: 'execution', label: 'Execution coach', to: '/flyxa-ai/execution-coach', end: false },
              { key: 'pattern', label: 'Pattern library', to: '/flyxa-ai/patterns', end: false },
              { key: 'ask', label: 'Ask Flyxa', to: '/flyxa-ai/ask', end: false },
            ].map(item => (
              <NavLink key={item.key} to={item.to} end={item.end}>
                {({ isActive }) => (
                  <span
                    className="block border-l-2 px-2.5 py-2 text-[12.5px] transition-colors hover:bg-white/[0.04]"
                    style={{
                      borderLeftColor: isActive ? colors.acc : 'transparent',
                      backgroundColor: isActive ? 'rgba(0,212,168,0.07)' : 'transparent',
                      color: isActive ? colors.acc : colors.t1,
                    }}
                  >
                    {item.label}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>

        </aside>

        <main className="min-h-0 overflow-hidden" style={{ backgroundColor: colors.d0 }}>
          {/* Mobile horizontal nav */}
          <nav className="flex lg:hidden overflow-x-auto border-b" style={{ borderColor: colors.b0, backgroundColor: colors.d1, flexShrink: 0 }}>
            {[
              { key: 'weekly', label: 'Debrief', to: '/flyxa-ai', end: true },
              { key: 'weekly-report', label: 'Weekly report', to: '/flyxa-ai/weekly-report', end: false },
              { key: 'execution', label: 'Execution coach', to: '/flyxa-ai/execution-coach', end: false },
              { key: 'pattern', label: 'Pattern library', to: '/flyxa-ai/patterns', end: false },
              { key: 'ask', label: 'Ask Flyxa', to: '/flyxa-ai/ask', end: false },
            ].map(item => (
              <NavLink key={item.key} to={item.to} end={item.end} style={{ textDecoration: 'none', flexShrink: 0 }}>
                {({ isActive }) => (
                  <span
                    style={{
                      display: 'block',
                      padding: '9px 14px',
                      fontSize: 12,
                      fontWeight: isActive ? 600 : 400,
                      borderBottom: `2px solid ${isActive ? colors.acc : 'transparent'}`,
                      color: isActive ? colors.acc : colors.t1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {item.label}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="flex h-full min-h-0 flex-col">
            <section data-tour-id="flyxa-ai-header" className="border-b px-4 py-4 lg:px-6 lg:py-5" style={{ borderColor: colors.b0 }}>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
                <div className="min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: colors.t2 }}>{getPeriodWindow(timeframe, weekOffset).headerLabel}</p>
                    <div className="flex gap-0.5 rounded-[5px] p-0.5" style={{ backgroundColor: colors.d3 }}>
                      {(['1W', '1M', '3M', 'All'] as TimeFrame[]).map(tf => (
                        <button
                          key={tf}
                          type="button"
                          onClick={() => { setTimeframe(tf); setWeekOffset(0); }}
                          className="rounded-[3px] px-2.5 py-[3px] text-[10px] font-medium transition-colors"
                          style={{
                            backgroundColor: timeframe === tf ? colors.d4 : 'transparent',
                            color: timeframe === tf ? colors.t0 : colors.t2,
                            border: timeframe === tf ? `1px solid ${colors.b1}` : '1px solid transparent',
                          }}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>
                    {(timeframe === '1W' || timeframe === '1M') && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setWeekOffset(w => w + 1)}
                          className="rounded-[3px] px-2 py-[3px] text-[12px] transition-colors hover:bg-white/[0.06]"
                          style={{ color: colors.t1, border: `1px solid ${colors.b0}` }}
                          title={timeframe === '1W' ? 'Previous week' : 'Previous month'}
                        >←</button>
                        {weekOffset > 0 && (
                          <button
                            type="button"
                            onClick={() => setWeekOffset(0)}
                            className="rounded-[3px] px-2 py-[3px] text-[10px] transition-colors hover:bg-white/[0.06]"
                            style={{ color: colors.acc, border: `1px solid ${colors.b0}`, fontFamily: colors.mono }}
                          >{timeframe === '1W' ? 'This week' : 'This month'}</button>
                        )}
                        <button
                          type="button"
                          onClick={() => setWeekOffset(w => Math.max(0, w - 1))}
                          disabled={weekOffset === 0}
                          className="rounded-[3px] px-2 py-[3px] text-[12px] transition-colors"
                          style={{
                            color: weekOffset === 0 ? colors.t2 : colors.t1,
                            border: `1px solid ${colors.b0}`,
                            opacity: weekOffset === 0 ? 0.4 : 1,
                          }}
                          title={timeframe === '1W' ? 'Next week' : 'Next month'}
                        >→</button>
                      </div>
                    )}
                  </div>
                  <h1 className="mt-2 text-[18px] font-bold tracking-[-0.02em] lg:text-[24px]" style={{ color: colors.t0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {weeklyDebriefData.weekRange}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[12px]" style={{ color: colors.t2 }}>
                      {weeklyDebriefData.sessionCount} sessions &middot; {weeklyDebriefData.tradeCount} trades
                    </span>
                    <span
                      className="rounded-[4px] border px-2 py-[2px] text-[10.5px]"
                      style={{ borderColor: colors.b1, backgroundColor: colors.d3, color: colors.t1, fontFamily: colors.mono }}
                    >
                      {weeklyDebriefData.instruments[0] ?? 'N/A'}
                    </span>
                  </div>
                </div>

                <div className="flex items-end gap-4">
                  <svg width={sparkline.width} height={sparkline.height} viewBox={`0 0 ${sparkline.width} ${sparkline.height}`} className="hidden lg:block shrink-0">
                    <line x1={6} y1={sparkline.baselineY} x2={sparkline.width - 6} y2={sparkline.baselineY} stroke="rgba(255,255,255,0.05)" strokeWidth="0.5" />
                    <path d={sparkline.areaPath} fill={netRNumeric >= 0 ? 'rgba(34,214,138,0.07)' : 'rgba(255,95,95,0.09)'} />
                    <path d={sparkline.linePath} fill="none" stroke={netRNumeric >= 0 ? colors.grn : colors.red} strokeWidth="1.5" />
                    {weeklyWindow.weeklyTrades.length > 0 && (
                      <g>
                        <circle cx={sparkline.endDot.x} cy={sparkline.endDot.y} r={3} fill={netRNumeric >= 0 ? colors.grn : colors.red} />
                        <text x={sparkline.endDot.labelX} y={sparkline.endDot.y - 6} textAnchor={sparkline.endDot.textAnchor} fontSize="9" style={{ fill: netRNumeric >= 0 ? colors.grn : colors.red, fontFamily: colors.mono }}>
                          {sparkline.endDot.label}
                        </text>
                      </g>
                    )}
                  </svg>
                  <div className="pb-0.5">
                    <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: colors.t2 }}>Net PL</p>
                    <p className="mt-0.5 text-[24px] font-bold leading-none tracking-[-0.03em] lg:text-[36px]" style={{ color: netRNumeric >= 0 ? colors.grn : colors.red, fontFamily: colors.mono }}>
                      {weeklyDebriefData.stats.netR.value}
                    </p>
                    <p className="mt-1 text-[10.5px]" style={{ color: colors.t2 }}>
                      {timeframe !== 'All' ? `vs ${formatSignedCurrency(previousWeekPnl)} ${getPeriodWindow(timeframe, weekOffset).prevLabel}` : `${weeklyWindow.weeklyTrades.length} trades total`}
                    </p>
                  </div>
                </div>
              </div>
              {focusedTradeId && (
                <div className="mt-4 rounded-[8px] border px-4 py-3" style={{ borderColor: colors.b1, backgroundColor: colors.d2 }}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: colors.t2 }}>Trade Deep Dive</p>
                      <p className="mt-1 text-[13px] font-semibold" style={{ color: colors.t0 }}>
                        {focusedTrade ? `${focusedTrade.symbol || 'N/A'} ${focusedTrade.direction || ''} · ${focusedTrade.trade_date || 'Unknown date'} ${focusedTrade.trade_time || ''}` : 'Trade not found in this account'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const next = new URLSearchParams(searchParams);
                        next.delete('tradeId');
                        setSearchParams(next);
                      }}
                      className="text-[11px] underline-offset-2 hover:underline"
                      style={{ color: colors.acc }}
                    >
                      Clear focus
                    </button>
                  </div>
                  {focusedTrade ? (
                    <div className="mt-2 grid gap-2 text-[11.5px] leading-relaxed" style={{ color: colors.t1 }}>
                      <p>
                        Result: <span style={{ color: focusedTradePnl !== null && focusedTradePnl >= 0 ? colors.grn : colors.red, fontFamily: colors.mono }}>{focusedTradePnl !== null ? formatSignedCurrency(focusedTradePnl) : '$0.00'}</span>
                        {' '}({focusedTrade.pnl > 0 ? 'win' : focusedTrade.pnl < 0 ? 'loss' : 'flat'}) · P&L <span style={{ fontFamily: colors.mono }}>{formatCurrency(Number(focusedTrade.pnl || 0))}</span>
                      </p>
                      <p>
                        Plan adherence: <span style={{ color: typeof focusedTrade.followed_plan !== 'boolean' ? colors.t2 : (focusedTrade.followed_plan ? colors.grn : colors.red) }}>
                          {typeof focusedTrade.followed_plan !== 'boolean'
                            ? 'Not logged'
                            : (focusedTrade.followed_plan ? 'Followed plan' : 'Plan drift flagged')}
                        </span>
                        {' '}· Emotion: <span style={{ color: colors.t0 }}>{focusedTrade.emotional_state || 'Not logged'}</span>
                      </p>
                      <p>
                        Confluences: <span style={{ color: colors.t0 }}>{focusedTradeConfluences.length ? focusedTradeConfluences.join(', ') : 'None tagged'}</span>
                      </p>
                    </div>
                  ) : (
                    <p className="mt-2 text-[11.5px]" style={{ color: colors.t1 }}>
                      This trade ID was passed from journal, but it is not available in the currently selected account filter.
                    </p>
                  )}
                </div>
              )}
            </section>

            {safeAccountTrades.length === 0 && (
              <section className="border-t px-6 py-5" style={{ borderColor: colors.b0, backgroundColor: colors.d1 }}>
                <div className="rounded-[8px] border px-4 py-4" style={{ borderColor: colors.b1, backgroundColor: colors.d2 }}>
                  <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: colors.acc }}>Flyxa AI locked</p>
                  <h2 className="mt-2 text-[16px] font-semibold" style={{ color: colors.t0 }}>Log trades before asking for analysis</h2>
                  <p className="mt-2 max-w-2xl text-[12px] leading-6" style={{ color: colors.t1 }}>
                    Flyxa needs real journal data to find patterns, emotional fingerprints, confluence quality, and post-session feedback.
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate('/scanner')}
                    className="mt-4 rounded-[5px] px-3 py-2 text-[12px] font-semibold"
                    style={{ backgroundColor: colors.acc, color: colors.d0 }}
                  >
                    Log first trade
                  </button>
                </div>
              </section>
            )}

            <section data-tour-id="flyxa-ai-stats" className="border-t" style={{ borderColor: colors.b0 }}>
              <div className="grid grid-cols-5 gap-px" style={{ backgroundColor: colors.b0 }}>
                {statCells.map(stat => (
                  <div key={stat.label} className="px-[5px] py-[8px] lg:px-[15px] lg:py-[13px]" style={{ backgroundColor: colors.d1 }}>
                    <p className="text-[7px] uppercase tracking-[0.06em] lg:text-[9px] lg:tracking-[0.14em]" style={{ color: colors.t2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stat.label}</p>
                    <p className="mt-0.5 text-[12px] font-bold lg:mt-1 lg:text-[16px]" style={{ color: statToneColor(stat.tone), fontFamily: colors.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {stat.value}
                    </p>
                    <p className="mt-1 hidden text-[10px] lg:block" style={{ color: colors.t2 }}>{stat.subLabel}</p>
                  </div>
                ))}
              </div>
            </section>

            <div className="min-h-0 flex-1 overflow-y-auto border-t px-4 py-3 lg:px-5 lg:py-4" style={{ borderColor: colors.b0 }}>
              <section data-tour-id="flyxa-ai-reflection">
                <div className="flex items-center gap-3 rounded-[8px] px-[14px] py-3" style={{ backgroundColor: colors.d2, border: cardBorder }}>
                  <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] border" style={{ backgroundColor: 'rgba(0,212,168,0.08)', borderColor: 'rgba(0,212,168,0.18)' }}>
                    <Clock3 size={13} color={colors.acc} />
                  </div>
                  <p className="flex-1 text-[12.5px] leading-relaxed" style={{ color: colors.t1 }}>{weeklyDebriefData.question}</p>
                  <button
                    type="button"
                    className="shrink-0 cursor-pointer text-[11.5px]"
                    style={{ color: colors.acc }}
                    onClick={() => setRespondOpen(prev => !prev)}
                  >
                    {respondOpen ? 'Cancel' : 'Respond →'}
                  </button>
                </div>
                {respondOpen && (
                  <div className="mt-2">
                    <textarea
                      className="w-full resize-none rounded-[6px] text-[12px] leading-relaxed"
                      style={{
                        backgroundColor: colors.d3,
                        border: `1px solid ${colors.b1}`,
                        color: colors.t0,
                        padding: '10px 12px',
                        fontFamily: 'var(--font-sans)',
                        outline: 'none',
                        minHeight: 76,
                      }}
                      placeholder="Write your honest answer here..."
                      value={respondText}
                      onChange={e => setRespondText(e.target.value)}
                    />
                    {respondText.trim() && (
                      <div className="mt-1.5 flex justify-end">
                        <button
                          type="button"
                          className="rounded-[4px] px-3 py-1 text-[11px]"
                          style={{ backgroundColor: 'rgba(245,158,11,0.15)', color: colors.acc, border: '1px solid rgba(245,158,11,0.3)' }}
                          onClick={saveReflection}
                        >
                          Save reflection
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {recentReflections.length > 0 && (
                  <div className="mt-3 rounded-[8px] border px-[14px] py-3" style={{ borderColor: colors.b0, backgroundColor: colors.d1 }}>
                    <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: colors.t2 }}>Saved reflections</p>
                    <div className="mt-2 space-y-2">
                      {recentReflections.map(reflection => (
                        <div key={reflection.id} className="border-l-2 pl-3" style={{ borderLeftColor: colors.acc }}>
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-[11px]" style={{ color: colors.t2 }}>{reflection.periodLabel} · {new Date(reflection.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                            <span className="text-[10px]" style={{ color: colors.t2, fontFamily: colors.mono }}>{reflection.timeframe}</span>
                          </div>
                          <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: colors.t1 }}>{reflection.question}</p>
                          <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: colors.t0 }}>{reflection.answer}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {dataCompleteness && (dataCompleteness.emotionPct < 80 || dataCompleteness.planPct < 80) && (
                <div className="mt-3 flex items-start gap-2.5 rounded-[8px] border px-[14px] py-3" style={{ borderColor: 'rgba(245,158,11,0.3)', backgroundColor: 'rgba(245,158,11,0.06)' }}>
                  <AlertTriangle size={13} color={colors.amb} style={{ flexShrink: 0, marginTop: 1 }} />
                  <p className="min-w-0 flex-1 text-[12px] leading-relaxed" style={{ color: colors.amb }}>
                    Debrief accuracy limited —{dataCompleteness.emotionPct < 80 && ` emotion tagged on ${dataCompleteness.emotionPct}% of trades`}{dataCompleteness.emotionPct < 80 && dataCompleteness.planPct < 80 && ','}{dataCompleteness.planPct < 80 && ` plan logged on ${dataCompleteness.planPct}%`}. Fill in the gaps for real AI insights.
                  </p>
                  <button
                    type="button"
                    className="shrink-0 text-[11px] whitespace-nowrap"
                    style={{ color: colors.amb }}
                    onClick={() => navigate('/journal')}
                  >
                    Fill gaps →
                  </button>
                </div>
              )}

              <section className="mt-4" data-tour-id="flyxa-ai-insights">
                <p style={tinyMetaLabelStyle}>AI insights &middot; {displayedInsights.length} found &middot; {getPeriodWindow(timeframe).periodLabel}</p>
                <div className="mt-2 space-y-2.5">
                  {displayedInsights.map(insight => {
                    const style = insightTypeStyles[insight.type];
                    return (
                      <article
                        key={insight.title}
                        className="overflow-hidden rounded-[10px] border transition-all"
                        style={{
                          borderColor: `color-mix(in srgb, ${style.accent} 22%, rgba(255,255,255,0.06))`,
                          backgroundColor: `color-mix(in srgb, ${style.accent} 4%, ${colors.d2})`,
                        }}
                      >
                        <div className="px-4 py-[14px]">
                          {/* Type badge pill */}
                          <span
                            className="inline-flex items-center rounded-full px-[9px] py-[3px] text-[9px] font-bold uppercase tracking-[0.08em]"
                            style={{ color: style.accent, backgroundColor: `color-mix(in srgb, ${style.accent} 15%, transparent)` }}
                          >
                            {insight.badge}
                          </span>
                          {/* Title */}
                          <h3 className="mt-[9px] text-[15px] font-semibold leading-snug" style={{ color: colors.t0 }}>
                            {insight.title}
                          </h3>
                          {/* Frequency — subtitle under title */}
                          <p className="mt-[3px] mb-[10px] text-[10.5px]" style={{ color: colors.t2 }}>
                            {insight.frequency}
                          </p>
                          {/* Body */}
                          <p className="mb-3 text-[12.5px] leading-[1.65]" style={{ color: colors.t1 }}>
                            {renderBodyWithHighlights(insight.body, insight.keyPhrases)}
                          </p>
                          {/* Footer: tags + action */}
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap gap-1.5">
                              {insight.tags.map(tag => (
                                <span key={tag.label} style={tagStyle(tag.tone)}>
                                  {tag.label}
                                </span>
                              ))}
                            </div>
                            <button
                              type="button"
                              className="shrink-0 cursor-pointer text-[11px] opacity-70 transition-opacity hover:opacity-100"
                              style={{ color: style.accent }}
                              onClick={() => {
                                const label = insight.actionLabel.toLowerCase();
                                if (label.includes('pre-session')) navigate('/pre-session');
                                else if (label.includes('pattern library') || label.includes('confluence')) navigate('/flyxa-ai/patterns');
                                else if (label.includes('keep logging')) navigate('/scanner');
                                else navigate('/journal');
                              }}
                            >
                              {insight.actionLabel}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              {bestTrade && (
                <section className="mt-4 rounded-[8px] px-[14px] py-3" style={{ backgroundColor: colors.d2, border: cardBorder }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-[4px] px-2 py-[2px] text-[10px] font-semibold" style={{ color: colors.amb, backgroundColor: 'rgba(245,166,35,0.12)' }}>
                      &#9733; Top performer
                    </span>
                    <span className="text-[10.5px]" style={{ color: colors.t2 }}>
                      {bestTrade.date} &middot; {bestTrade.session} &middot; {bestTrade.time}
                    </span>
                  </div>
                  <div className="mt-2 flex items-end justify-between gap-2">
                    <div>
                      <p className="text-[15px] font-bold" style={{ color: colors.t0, fontFamily: colors.mono }}>{bestTrade.symbol}</p>
                      <p className="text-[11px]" style={{ color: colors.t2 }}>{bestTrade.direction}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[15px] font-bold" style={{ color: colors.grn, fontFamily: colors.mono }}>{bestTrade.resultPnl}</p>
                      <p className="text-[11px]" style={{ color: colors.t2 }}>{bestTrade.note}</p>
                    </div>
                  </div>
                  <p className="mt-1 text-[11.5px] italic leading-snug" style={{ color: colors.t1 }}>{bestTrade.journal}</p>
                </section>
              )}
            </div>
          </div>
        </main>

        <aside className="hidden lg:block min-h-0 overflow-y-auto border-l px-4 py-[18px]" style={{ backgroundColor: colors.d1, borderColor: colors.b0 }}>
          <section className="rounded-[8px] px-[14px] py-[14px]" style={{ backgroundColor: colors.d2, border: cardBorder }}>
            <div className="flex items-center gap-[14px]">
              <p className="text-[52px] font-bold leading-none" style={{ color: gradeColor(weekGrade), fontFamily: colors.mono }}>{weekGrade}</p>
              <div>
                <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: colors.t2 }}>Process score</p>
                <p className="mt-1 text-[14px] font-bold" style={{ color: colors.t0, fontFamily: colors.mono }}>{boundedScore}/100</p>
                <p className="mt-1 text-[11px] leading-snug" style={{ color: colors.t1 }}>{gradeHint}</p>
              </div>
            </div>
          </section>

          <section className="mt-4 rounded-[8px] px-[14px] py-3" style={{ backgroundColor: colors.d2, border: cardBorder }}>
            <p style={tinyMetaLabelStyle}>Process breakdown</p>
            <div className="mt-2.5 space-y-2.5">
              {weeklyDebriefData.processBreakdown.map(item => {
                const color = item.noData ? colors.t2 : breakdownColor(item.value);
                return (
                  <div key={item.label}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[11.5px]" style={{ color: colors.t1 }}>{item.label}</span>
                        {item.note && (
                          <span className="text-[10px]" style={{ color: colors.t2 }}>· {item.note}</span>
                        )}
                      </div>
                      <span className="text-[11.5px] font-bold shrink-0" style={{ color, fontFamily: colors.mono }}>
                        {item.noData ? 'N/A' : `${item.value}%`}
                      </span>
                    </div>
                    <div className="h-[2px] rounded-[2px]" style={{ backgroundColor: colors.d4 }}>
                      {!item.noData && (
                        <div className="h-[2px] rounded-[2px]" style={{ width: `${item.value}%`, backgroundColor: color }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="mt-4 rounded-[8px] px-[14px] py-3" style={{ backgroundColor: colors.d2, border: cardBorder }}>
            <p style={tinyMetaLabelStyle}>Session breakdown</p>
            <div className="mt-2.5 space-y-2.5">
              {sessionBreakdownRows.map(row => (
                <div key={row.label}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="w-14 text-[11.5px]" style={{ color: colors.t1 }}>{row.label}</span>
                    <div className="h-[3px] flex-1 rounded-[2px]" style={{ backgroundColor: colors.d4 }}>
                      <div
                        className="h-[3px] rounded-[2px]"
                        style={{ width: `${row.barWidth}%`, backgroundColor: row.netPnl > 0 ? colors.grn : row.netPnl < 0 ? colors.red : colors.t2 }}
                      />
                    </div>
                    <span className="w-16 text-right text-[11px]" style={{ color: row.netPnl > 0 ? colors.grn : row.netPnl < 0 ? colors.red : colors.t2, fontFamily: colors.mono }}>
                      {row.trades ? formatSignedCompactCurrency(row.netPnl) : '--'}
                    </span>
                    <span className="w-8 text-right text-[10px]" style={{ color: colors.t2 }}>
                      {row.trades ? `${row.winRate}%` : '--'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {dailyBreakdownRows.length > 0 && (
            <section className="mt-4 rounded-[8px] px-[14px] py-3" style={{ backgroundColor: colors.d2, border: cardBorder }}>
              <p style={tinyMetaLabelStyle}>Daily pre-session</p>
              <div className="mt-2.5 space-y-3">
                {dailyBreakdownRows.map(row => {
                  const readinessColor = row.ps?.readiness?.status === 'Ready' ? colors.grn : row.ps?.readiness?.status === 'Stand Down' ? colors.red : colors.acc;
                  return (
                    <div key={row.iso}>
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="text-[10.5px] font-medium" style={{ color: colors.t1 }}>{row.dayLabel}</span>
                        <span className="text-[11px] font-medium" style={{ color: row.netPnl > 0 ? colors.grn : row.netPnl < 0 ? colors.red : colors.t2, fontFamily: colors.mono }}>
                          {row.trades > 0 ? formatSignedCompactCurrency(row.netPnl) : '--'}
                        </span>
                      </div>
                      {row.ps ? (
                        <div className="flex flex-wrap gap-1">
                          {row.ps.emotion && (
                            <span className="rounded-[3px] px-1.5 py-0.5 text-[9.5px] font-medium" style={{ backgroundColor: colors.d4, color: colors.t1 }}>
                              {row.ps.emotion}
                            </span>
                          )}
                          {row.ps.readiness && (
                            <span className="rounded-[3px] px-1.5 py-0.5 text-[9.5px] font-medium" style={{ backgroundColor: colors.d4, color: readinessColor }}>
                              {row.ps.readiness.score}/100
                            </span>
                          )}
                          {row.biasTotal > 0 && (
                            <span className="rounded-[3px] px-1.5 py-0.5 text-[9.5px] font-medium" style={{ backgroundColor: colors.d4, color: row.biasAligned === row.biasTotal ? colors.grn : row.biasAligned === 0 ? colors.red : colors.acc }}>
                              bias {row.biasAligned}/{row.biasTotal}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[9.5px]" style={{ color: colors.t2 }}>No brief logged</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="mt-4 rounded-[8px] px-[14px] py-3" style={{ backgroundColor: colors.d2, border: cardBorder }}>
            <p style={tinyMetaLabelStyle}>3 things to action</p>
            <div className="mt-2.5 space-y-2.5">
              {actionItems.map((item, index) => (
                <div key={`${index}-${item}`} className="flex items-start gap-2">
                  <span className="w-5 text-[10px] font-bold opacity-65" style={{ color: colors.acc, fontFamily: colors.mono }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="text-[12px] leading-relaxed" style={{ color: colors.t1 }}>{item}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-4 rounded-[8px] px-[14px] py-3" style={{ backgroundColor: colors.d2, border: cardBorder }}>
            <p className="text-[12.5px] font-semibold" style={{ color: colors.t0 }}>Next debrief</p>
            <p className="mt-1 text-[11px]" style={{ color: colors.t2 }}>{weeklyDebriefData.nextDebrief.generatedOn}</p>
            <div className="mt-2 h-[2px] rounded-[2px]" style={{ backgroundColor: colors.d4 }}>
              <div className="h-[2px] rounded-[2px]" style={{ width: `${sessionsProgress}%`, backgroundColor: colors.acc }} />
            </div>
            <p className="mt-2 text-[10.5px]" style={{ color: colors.t2 }}>
              {remainingSessions} sessions remaining
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
