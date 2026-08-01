import { useMemo, useState, useRef, type ReactNode, type CSSProperties } from 'react';
import { Btn, PageHeader, SectionPanel, EmptyState } from '../components/ds/index.js';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import LollipopDistribution from '../components/analytics/LollipopDistribution.js';
import RuleAdherenceCard, { type AdherenceData, type AdherenceDay } from '../components/analytics/RuleAdherenceCard.js';
import { useTrades } from '../hooks/useTrades.js';
import { ALL_ACCOUNTS_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { JournalEntry as StoreJournalEntry } from '../store/types.js';
import { Trade } from '../types/index.js';
import { formatCurrency } from '../utils/calculations.js';
import { getSessionKeyForTime, timeToMinutes } from '../utils/sessionTimes.js';
import { getTradeRiskReward } from '../utils/tradeAnalytics.js';
import { formatRiskRewardRatio } from '../utils/riskReward.js';
import { normalizeConfluenceKey, normalizeConfluenceTags } from '../utils/confluenceTags.js';
import { buildPlanAdherenceReport } from '../utils/planAdherence.js';

type PeriodKey = '1W' | '1M' | '3M' | 'YTD' | 'ALL';

const PERIOD_OPTIONS: Array<{ key: PeriodKey; label: string }> = [
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: 'YTD', label: 'YTD' },
  { key: 'ALL', label: 'All' },
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const BUSINESS_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
const SESSION_BUCKETS = [
  { key: 'asia', label: 'Asia' },
  { key: 'london', label: 'London' },
  { key: 'preMarket', label: 'Pre Market' },
  { key: 'newYork', label: 'New York' },
] as const;
const TOP_TIME_BUCKETS = 7;

type TimeWindowMins = 15 | 30 | 60;
const TIME_WINDOW_OPTIONS: Array<{ value: TimeWindowMins; label: string }> = [
  { value: 15, label: '15m' },
  { value: 30, label: '30m' },
  { value: 60, label: '1hr' },
];
const DASHBOARD_GREEN = '#34d399';
const DASHBOARD_RED = '#f87171';


// Mono uppercase section labels — the report/terminal voice used across Flyxa.
const KICKER: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--app-text-muted)',
};

function parseTradeDateTime(trade: Trade): Date | null {
  const datePart = trade.trade_date || trade.created_at?.slice(0, 10);
  if (!datePart) return null;

  const rawTime = trade.trade_time || '00:00:00';
  const timePart = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${datePart}T${timePart}`);

  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  if (trade.created_at) {
    const fallback = new Date(trade.created_at);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  return null;
}

function parseTradeDateOnly(trade: Trade): Date | null {
  const datePart = trade.trade_date || trade.created_at?.slice(0, 10);
  if (!datePart) return null;
  const parsed = new Date(`${datePart}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Returns an inclusive-start / exclusive-end range for a given period + navigation offset.
// offset 0 = current period, -1 = one period back, etc.
function getPeriodRange(period: PeriodKey, offset: number, now: Date): { start: Date; end: Date } | null {
  if (period === 'ALL') return null;

  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  if (period === 'YTD') {
    // YTD is always Jan 1 of this year → today; offset has no effect.
    return { start: new Date(base.getFullYear(), 0, 1), end: new Date(base.getTime() + 86_400_000) };
  }

  if (period === '1W') {
    const dow = base.getDay(); // 0=Sun … 6=Sat
    const daysToMon = dow === 0 ? 6 : dow - 1;
    const monday = new Date(base);
    monday.setDate(base.getDate() - daysToMon + offset * 7);
    const end = new Date(monday);
    end.setDate(monday.getDate() + 7);
    return { start: monday, end };
  }

  if (period === '1M') {
    // Calendar months (Jan=0 … Dec=11), offset shifts by whole months.
    const month = now.getMonth() + offset;
    const start = new Date(now.getFullYear(), month, 1);
    const end = new Date(now.getFullYear(), month + 1, 1);
    return { start, end };
  }

  if (period === '3M') {
    // Align to calendar quarters: Q1=Jan–Mar, Q2=Apr–Jun, Q3=Jul–Sep, Q4=Oct–Dec.
    const currentQuarter = Math.floor(now.getMonth() / 3);
    const qMonth = (currentQuarter + offset) * 3;
    const year = now.getFullYear() + Math.floor(qMonth / 12);
    const month = ((qMonth % 12) + 12) % 12;
    const start = new Date(year, month, 1);
    const end = new Date(year, month + 3, 1);
    return { start, end };
  }

  return null;
}

function getPeriodLabel(period: PeriodKey, offset: number, now: Date): string {
  if (period === 'ALL') return 'All Time';
  if (period === 'YTD') return `Year to Date ${now.getFullYear()}`;

  const range = getPeriodRange(period, offset, now);
  if (!range) return '';

  const { start, end } = range;
  const endInclusive = new Date(end.getTime() - 86_400_000); // subtract 1 day for display

  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  if (period === '1W') {
    if (start.getFullYear() === endInclusive.getFullYear()) {
      return `${fmt(start)}, ${fmt(endInclusive)}, ${start.getFullYear()}`;
    }
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${endInclusive.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  if (period === '1M') {
    return start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  if (period === '3M') {
    if (start.getFullYear() === endInclusive.getFullYear()) {
      return `${fmt(start)}, ${fmt(endInclusive)}, ${start.getFullYear()}`;
    }
    return `${start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}, ${endInclusive.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
  }

  return '';
}

function formatSignedCurrency(value: number, withCents = false): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: withCents ? 2 : 0,
    maximumFractionDigits: withCents ? 2 : 0,
  });
  const signed = formatter.format(Math.abs(value));
  return `${value >= 0 ? '+' : '-'}${signed}`;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function safeAverage(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, current) => sum + current, 0) / values.length;
}

function formatDateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTimeBucketLabel(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

function normalizeConfluences(value: unknown): string[] {
  return normalizeConfluenceTags(value);
}


function InfoTooltip({ text }: { text: string }) {
  // Viewport-fixed so panels with overflow clipping (the KPI rail) can't hide it.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}
      onMouseEnter={() => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect) setPos({ x: rect.left + rect.width / 2, y: rect.top });
      }}
      onMouseLeave={() => setPos(null)}
    >
      <span style={{
        width: 13, height: 13, borderRadius: '50%',
        border: '1px solid var(--color-border, rgba(255,255,255,0.18))',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'default', fontSize: 8, fontWeight: 700,
        color: 'var(--color-text-subtle)',
        lineHeight: 1, userSelect: 'none', flexShrink: 0,
      }}>?</span>
      {pos && (
        <div style={{
          position: 'fixed',
          left: Math.min(Math.max(pos.x, 130), window.innerWidth - 130),
          top: pos.y - 7,
          transform: 'translate(-50%, -100%)',
          background: 'var(--color-panel, var(--app-panel))',
          border: '1px solid var(--color-border, var(--app-border))',
          borderRadius: 7, padding: '9px 11px',
          width: 230, zIndex: 80, pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          fontSize: 11, color: 'var(--color-text-muted, var(--app-text-muted))',
          lineHeight: 1.6,
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

// Hold-time buckets for the P&L-by-hold-time skyline. Durations come from the
// scanner or journal time fields; trades without one are excluded, not zeroed.
const HOLD_BUCKETS = [
  { label: '<5m', maxMinutes: 5 },
  { label: '5–15m', maxMinutes: 15 },
  { label: '15–30m', maxMinutes: 30 },
  { label: '30–60m', maxMinutes: 60 },
  { label: '1h+', maxMinutes: Infinity },
] as const;

function formatHoldSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

// Diverging skyline — columns rise (green) or fall (red) from a shared zero
// baseline whose position is proportional to the data's positive/negative range.
export default function Analytics() {
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount, preferences, selectedAccountId } = useAppSettings();
  const storeAccounts = useFlyxaStore(state => state.accounts);
  const entries = useFlyxaStore(state => state.entries);
  const riskRules = useFlyxaStore(state => state.riskRules);
  const selectedStoreAcct = selectedAccountId && selectedAccountId !== ALL_ACCOUNTS_ID
    ? storeAccounts.find(a => a.id === selectedAccountId)
    : undefined;
  const accountPayouts = selectedStoreAcct?.payouts ?? [];
  const [period, setPeriod] = useState<PeriodKey>('1M');
  const [periodOffset, setPeriodOffset] = useState<number>(0);
  const [timeWindow, setTimeWindow] = useState<TimeWindowMins>(30);
  const [showAllConfluences, setShowAllConfluences] = useState(false);
  const today = useMemo(() => new Date(), []);

  const handlePeriodChange = (key: PeriodKey) => {
    setPeriod(key);
    setPeriodOffset(0);
  };

  const sourceTrades = trades;
  const isLoading = loading;

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(sourceTrades),
    [filterTradesBySelectedAccount, sourceTrades]
  );

  const periodRange = useMemo(
    () => getPeriodRange(period, periodOffset, today),
    [period, periodOffset, today]
  );

  const planReport = useMemo(() => {
    const bounds = periodRange
      ? [dateKey(periodRange.start), dateKey(new Date(periodRange.end.getTime() - 86_400_000))] as [string, string]
      : undefined;
    return buildPlanAdherenceReport(entries as StoreJournalEntry[], riskRules, { bounds, accountId: selectedAccountId });
  }, [entries, periodRange, riskRules, selectedAccountId]);

  const filteredTrades = useMemo(() => {
    const range = periodRange;
    const next = accountTrades.filter(trade => {
      if (!range) return true; // ALL, include everything
      const tradeDate = parseTradeDateOnly(trade);
      if (!tradeDate) return false;
      // YTD: open-ended upper bound (today is the end); others: strict [start, end) range
      if (period === 'YTD') return tradeDate >= range.start;
      return tradeDate >= range.start && tradeDate < range.end;
    });

    return next.sort((a, b) => {
      const aTime = parseTradeDateTime(a)?.getTime() ?? 0;
      const bTime = parseTradeDateTime(b)?.getTime() ?? 0;
      return aTime - bTime;
    });
  }, [accountTrades, periodRange, period]);

  const previousPeriodNet = useMemo(() => {
    if (period === 'ALL' || period === 'YTD') return null;
    const prev = getPeriodRange(period, periodOffset - 1, today);
    if (!prev) return null;

    return accountTrades.reduce((sum, trade) => {
      const tradeDate = parseTradeDateOnly(trade);
      if (!tradeDate) return sum;
      if (tradeDate >= prev.start && tradeDate < prev.end) {
        return sum + trade.pnl - (trade.commission ?? 0);
      }
      return sum;
    }, 0);
  }, [accountTrades, period, periodOffset, today]);

  const metrics = useMemo(() => {
    const ep = (t: typeof filteredTrades[0]) => t.pnl - (t.commission ?? 0);
    const wins = filteredTrades.filter(trade => ep(trade) > 0);
    const losses = filteredTrades.filter(trade => ep(trade) < 0);
    const totalTrades = filteredTrades.length;
    const netPnL = filteredTrades.reduce((sum, trade) => sum + ep(trade), 0);
    const grossProfit = wins.reduce((sum, trade) => sum + ep(trade), 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + ep(trade), 0));
    const scoredTrades = wins.length + losses.length;
    const winRate = scoredTrades > 0 ? (wins.length / scoredTrades) * 100 : 0;
    const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLoss;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, trade) => sum + ep(trade), 0) / losses.length : 0;
    const avgPnL = totalTrades > 0 ? netPnL / totalTrades : 0;
    const winRateDecimal = scoredTrades > 0 ? wins.length / scoredTrades : 0;
    const lossRateDecimal = scoredTrades > 0 ? losses.length / scoredTrades : 0;
    const expectedValue = (winRateDecimal * avgWin) + (lossRateDecimal * avgLoss);
    const rrValues = filteredTrades
      .map(getTradeRiskReward)
      .filter((v): v is number => v !== null);
    const rrCount = rrValues.length;
    const avgRR = rrCount > 0
      ? rrValues.reduce((s, v) => s + v, 0) / rrCount
      : null;
    const activeDays = new Set(filteredTrades.map(trade => trade.trade_date)).size;
    const tradesPerDay = activeDays > 0 ? totalTrades / activeDays : 0;
    const avgWinHold = safeAverage(wins.map(trade => trade.trade_length_seconds || 0));
    const avgLossHold = safeAverage(losses.map(trade => trade.trade_length_seconds || 0));
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(trade => trade.pnl - (trade.commission ?? 0))) : 0;

    return {
      wins,
      losses,
      totalTrades,
      netPnL,
      winRate,
      profitFactor,
      avgWin,
      avgLoss,
      avgPnL,
      expectedValue,
      avgRR,
      rrCount,
      tradesPerDay,
      avgWinHold,
      avgLossHold,
      largestLoss,
    };
  }, [filteredTrades]);

  const netPnLChange = useMemo(() => {
    if (previousPeriodNet === null) return null;
    if (Math.abs(previousPeriodNet) < 0.0001) return null;
    return ((metrics.netPnL - previousPeriodNet) / Math.abs(previousPeriodNet)) * 100;
  }, [metrics.netPnL, previousPeriodNet]);

  const equityCurveData = useMemo(() => {
    const grouped = new Map<string, number>();
    filteredTrades.forEach(trade => {
      const key = trade.trade_date || trade.created_at?.slice(0, 10);
      if (!key) return;
      grouped.set(key, (grouped.get(key) ?? 0) + (trade.pnl - (trade.commission ?? 0)));
    });

    // Collect all dates (trades + payouts)
    const payoutByDate = new Map<string, number>();
    accountPayouts.forEach(p => {
      payoutByDate.set(p.date, (payoutByDate.get(p.date) ?? 0) + p.amount);
    });
    const allDates = Array.from(new Set([...grouped.keys(), ...payoutByDate.keys()])).sort();

    let cumulative = 0;
    return allDates.map(date => {
      cumulative += grouped.get(date) ?? 0;
      const payoutAmount = payoutByDate.get(date) ?? 0;
      cumulative -= payoutAmount;
      return {
        date,
        label: formatDateLabel(date),
        cumulative,
        breakeven: 0,
        payoutAmount: payoutAmount > 0 ? payoutAmount : undefined,
      };
    });
  }, [filteredTrades, accountPayouts]);

  const maxDrawdown = useMemo(() => {
    if (equityCurveData.length === 0) return 0;
    let peak = equityCurveData[0].cumulative;
    let dd = 0;
    for (const point of equityCurveData) {
      if (point.cumulative > peak) peak = point.cumulative;
      const current = peak - point.cumulative;
      if (current > dd) dd = current;
    }
    return dd;
  }, [equityCurveData]);

  const pnlDistribution = useMemo(() => {
    if (filteredTrades.length < 2) return null;
    const pnls = filteredTrades.map(t => t.pnl - (t.commission ?? 0));
    const minVal = Math.min(...pnls);
    const maxVal = Math.max(...pnls);
    if (maxVal - minVal < 0.01) return null;

    const totalRange = maxVal - minVal;
    const binWidth = Math.max(totalRange / 20, 0.01);

    // Group trades into x-bins, sorted by pnl for deterministic order
    const bins = new Map<number, { pnl: number; isPositive: boolean }[]>();
    [...filteredTrades]
      .sort((a, b) => (a.pnl - (a.commission ?? 0)) - (b.pnl - (b.commission ?? 0)))
      .forEach(trade => {
        const netPnl = trade.pnl - (trade.commission ?? 0);
        const key = Math.floor((netPnl - minVal) / binWidth);
        const bin = bins.get(key) ?? [];
        bin.push({ pnl: netPnl, isPositive: netPnl >= 0 });
        bins.set(key, bin);
      });

    // Center-stack: all isolated dots at y=0.5; stacks grow symmetrically with fixed step
    const dotStep = 0.10;
    // size encodes |P&L| — Recharts ZAxis maps this to dot area
    const dots: { pnl: number; y: number; isPositive: boolean; size: number }[] = [];
    bins.forEach(binDots => {
      const n = binDots.length;
      const startY = 0.5 - ((n - 1) * dotStep) / 2;
      binDots.forEach((dot, i) => {
        dots.push({ ...dot, y: startY + i * dotStep, size: Math.abs(dot.pnl) });
      });
    });

    // Symmetric domain: both sides equal so zero line is always centred
    const absExtreme = Math.max(Math.abs(minVal), Math.abs(maxVal));
    const step = absExtreme * 2 < 200 ? 10 : absExtreme * 2 < 1000 ? 100 : absExtreme * 2 < 5000 ? 500 : 1000;
    const domainExtent = Math.ceil((absExtreme * 1.15) / step) * step;
    const meanPnL = filteredTrades.reduce((sum, t) => sum + t.pnl - (t.commission ?? 0), 0) / filteredTrades.length;

    return {
      wins: dots.filter(d => d.isPositive),
      losses: dots.filter(d => !d.isPositive),
      domainMin: -domainExtent,
      domainMax: domainExtent,
      meanPnL,
    };
  }, [filteredTrades]);

  // One bar per rule-checked day in the period (capped for bar width sanity).
  // One reconciled data object for the rule-adherence card: the ribbon, the
  // percentage, the streaks, the breakdown and the callout all derive from
  // days[] here, so the callout can never contradict the ribbon.
  const adherenceData = useMemo<AdherenceData | null>(() => {
    const daily = [...planReport.daily]
      .filter(d => d.checked > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (daily.length === 0) return null;

    // Scope the ribbon to the month of the most recent day-level check.
    const last = daily[daily.length - 1].date; // YYYY-MM-DD
    const monthKey = last.slice(0, 7);
    const y = Number(last.slice(0, 4)), m = Number(last.slice(5, 7));
    const daysInMonth = new Date(y, m, 0).getDate();
    const byDate = new Map(daily.map(d => [d.date, d]));

    // Weekdays only — weekends aren't tradable, so they never belong in the
    // ribbon or any adherence figure (the daily-journal streak is the sole
    // place weekends still count).
    const days: AdherenceDay[] = [];
    for (let dnum = 1; dnum <= daysInMonth; dnum++) {
      const date = `${monthKey}-${String(dnum).padStart(2, '0')}`;
      const weekday = new Date(`${date}T00:00:00`).getDay();
      if (weekday === 0 || weekday === 6) continue;
      const d = byDate.get(date);
      const traded = !!d && d.checked > 0;
      days.push({
        date, traded,
        held: traded && d!.failed === 0,
        breaches: d ? d.failedRules.map(r => ({ id: r.ruleId, label: r.label })) : [],
      });
    }

    const trading = days.filter(d => d.traded);
    const tradingDays = trading.length;
    const cleanDays = trading.filter(d => d.held).length;
    const brokenDays = tradingDays - cleanDays;
    const breaches = trading.reduce((s, d) => s + d.breaches.length, 0);
    const adherence = tradingDays > 0 ? cleanDays / tradingDays : 0;

    let bestStreak = 0, run = 0;
    for (const d of trading) { if (d.held) { run += 1; bestStreak = Math.max(bestStreak, run); } else run = 0; }
    let currentStreak = 0;
    for (let i = trading.length - 1; i >= 0; i--) { if (trading[i].held) currentStreak += 1; else break; }

    // Per-rule breach counts (month-scoped) + every enabled rule at zero.
    const breachCount = new Map<string, number>();
    const labelById = new Map<string, string>();
    trading.forEach(d => d.breaches.forEach(b => {
      breachCount.set(b.id, (breachCount.get(b.id) ?? 0) + 1);
      labelById.set(b.id, b.label);
    }));
    const ruleMap = new Map<string, { id: string; label: string; breaches: number }>();
    riskRules.filter(r => r.enabled !== false).forEach(r => ruleMap.set(r.id, { id: r.id, label: r.label, breaches: breachCount.get(r.id) ?? 0 }));
    breachCount.forEach((n, id) => { if (!ruleMap.has(id)) ruleMap.set(id, { id, label: labelById.get(id) ?? 'Rule', breaches: n }); });
    const rules = [...ruleMap.values()].sort((a, b) => b.breaches - a.breaches);

    // Callout: one weekday carrying 60%+ of broken days, else one rule with 50%+ of breaches.
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const word = (n: number) => WORDS[n] ? WORDS[n][0].toUpperCase() + WORDS[n].slice(1) : String(n);
    let callout: AdherenceData['callout'] = null;
    const broken = trading.filter(d => !d.held);
    if (brokenDays > 0) {
      const byWd = new Map<number, number>();
      broken.forEach(d => { const wd = new Date(`${d.date}T00:00:00`).getDay(); byWd.set(wd, (byWd.get(wd) ?? 0) + 1); });
      const top = [...byWd.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 2 && top[1] / brokenDays >= 0.6) {
        callout = {
          text: `${word(top[1])} of your ${word(brokenDays).toLowerCase()} broken days were ${WEEKDAYS[top[0]]}s.`,
          detail: `That single weekday is behind ${Math.round((top[1] / brokenDays) * 100)}% of this month's rule breaks.`,
        };
      }
    }
    if (!callout && breaches > 0 && rules[0] && rules[0].breaches / breaches >= 0.5 && rules.length > 1) {
      const r = rules[0];
      callout = {
        text: `${r.label} caused ${word(r.breaches).toLowerCase()} of the ${word(breaches).toLowerCase()} breaches.`,
        detail: `More than the other ${rules.length - 1} rule${rules.length - 1 === 1 ? '' : 's'} combined.`,
      };
    }

    const monthLabel = new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
    return { monthLabel, days, rules, summary: { tradingDays, cleanDays, brokenDays, breaches, adherence, currentStreak, bestStreak }, callout };
  }, [planReport, riskRules]);

  const dayOfWeekRows = useMemo(() => {
    const values: Record<string, { pnl: number; count: number }> = {
      Mon: { pnl: 0, count: 0 },
      Tue: { pnl: 0, count: 0 },
      Wed: { pnl: 0, count: 0 },
      Thu: { pnl: 0, count: 0 },
      Fri: { pnl: 0, count: 0 },
    };

    filteredTrades.forEach(trade => {
      const tradeDate = parseTradeDateOnly(trade);
      if (!tradeDate) return;
      const dayLabel = DAY_LABELS[tradeDate.getDay()];
      if (dayLabel in values) {
        values[dayLabel].pnl += trade.pnl - (trade.commission ?? 0);
        values[dayLabel].count += 1;
      }
    });

    const maxAbs = Math.max(1, ...BUSINESS_DAY_LABELS.map(label => Math.abs(values[label].pnl)));
    return BUSINESS_DAY_LABELS.map(label => ({
      label,
      pnl: values[label].pnl,
      count: values[label].count,
      ratio: Math.abs(values[label].pnl) / maxAbs,
    }));
  }, [filteredTrades]);

  const sessionRows = useMemo(() => {
    const totals = new Map<string, { pnl: number; count: number }>(
      SESSION_BUCKETS.map(bucket => [bucket.key, { pnl: 0, count: 0 }])
    );

    filteredTrades.forEach(trade => {
      const sessionKey = getSessionKeyForTime(trade.trade_time, preferences.sessionTimes);
      const bucket = totals.get(sessionKey);
      if (!bucket) return;
      bucket.pnl += trade.pnl - (trade.commission ?? 0);
      bucket.count += 1;
    });

    const maxAbs = Math.max(1, ...SESSION_BUCKETS.map(item => Math.abs(totals.get(item.key)?.pnl ?? 0)));
    return SESSION_BUCKETS.map(bucket => {
      const { pnl, count } = totals.get(bucket.key) ?? { pnl: 0, count: 0 };
      return {
        key: bucket.key,
        label: bucket.label,
        pnl,
        count,
        ratio: Math.abs(pnl) / maxAbs,
      };
    });
  }, [filteredTrades, preferences.sessionTimes]);

  const holdTime = useMemo(() => {
    const totals = HOLD_BUCKETS.map(() => ({ pnl: 0, count: 0 }));
    let known = 0;
    filteredTrades.forEach(trade => {
      const seconds = trade.trade_length_seconds;
      if (typeof seconds !== 'number' || seconds <= 0) return;
      known += 1;
      const minutes = seconds / 60;
      const index = HOLD_BUCKETS.findIndex(bucket => minutes < bucket.maxMinutes);
      const bucket = totals[index === -1 ? HOLD_BUCKETS.length - 1 : index];
      bucket.pnl += trade.pnl - (trade.commission ?? 0);
      bucket.count += 1;
    });
    const rows = HOLD_BUCKETS.map((bucket, index) => ({ label: bucket.label, ...totals[index] }));
    const best = rows.filter(row => row.count > 0).sort((a, b) => b.pnl - a.pnl)[0] ?? null;
    const worst = rows.filter(row => row.count > 0 && row.pnl < 0).sort((a, b) => a.pnl - b.pnl)[0] ?? null;
    return { rows, known, best, worst };
  }, [filteredTrades]);

  const streakStats = useMemo(() => {
    const outcomes = filteredTrades.map(trade => {
      const net = trade.pnl - (trade.commission ?? 0);
      return net > 0 ? 1 : net < 0 ? -1 : 0;
    });
    const recent = outcomes.slice(-20);

    let currentType: 1 | -1 | 0 = 0;
    let currentLength = 0;
    for (let index = outcomes.length - 1; index >= 0; index -= 1) {
      const current = outcomes[index];
      if (current === 0) break;
      if (currentType === 0) {
        currentType = current as 1 | -1;
      }
      if (current !== currentType) break;
      currentLength += 1;
    }

    let bestWin = 0;
    let worstLoss = 0;
    let runWin = 0;
    let runLoss = 0;

    outcomes.forEach(outcome => {
      if (outcome > 0) {
        runWin += 1;
        runLoss = 0;
        bestWin = Math.max(bestWin, runWin);
        return;
      }

      if (outcome < 0) {
        runLoss += 1;
        runWin = 0;
        worstLoss = Math.max(worstLoss, runLoss);
        return;
      }

      runWin = 0;
      runLoss = 0;
    });

    return {
      recent,
      currentType,
      currentLength,
      bestWin,
      worstLoss,
    };
  }, [filteredTrades]);

  const timeOfDayRows = useMemo(() => {
    const bucketMap = new Map<number, { start: number; count: number; sumPnL: number }>();

    filteredTrades.forEach(trade => {
      const minutes = timeToMinutes(trade.trade_time);
      if (minutes === null) return;

      const bucketStart = Math.floor(minutes / timeWindow) * timeWindow;
      const current = bucketMap.get(bucketStart) ?? {
        start: bucketStart,
        count: 0,
        sumPnL: 0,
      };
      current.count += 1;
      current.sumPnL += trade.pnl - (trade.commission ?? 0);
      bucketMap.set(bucketStart, current);
    });

    const rows = Array.from(bucketMap.values())
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.start - b.start;
      })
      .slice(0, TOP_TIME_BUCKETS)
      .sort((a, b) => a.start - b.start)
      .map(row => ({
        label: formatTimeBucketLabel(row.start),
        start: row.start,
        end: row.start + timeWindow,
        count: row.count,
        avgPnL: row.sumPnL / row.count,
      }));

    const maxAbs = Math.max(
      1,
      ...rows.map(row => Math.abs(row.avgPnL ?? 0))
    );

    return rows.map(row => ({
      ...row,
      ratio: row.avgPnL === null ? 0 : Math.abs(row.avgPnL) / maxAbs,
    }));
  }, [filteredTrades, timeWindow]);

  const confluenceRows = useMemo(() => {
    const grouped = new Map<string, {
      label: string;
      trades: number;
      wins: number;
      netPnL: number;
    }>();

    filteredTrades.forEach(trade => {
      const confluences = normalizeConfluences(trade.confluences);
      if (!confluences.length) return;

      confluences.forEach(confluence => {
        const key = normalizeConfluenceKey(confluence);
        const current = grouped.get(key) ?? {
          label: confluence,
          trades: 0,
          wins: 0,
          netPnL: 0,
        };
        current.trades += 1;
        current.netPnL += trade.pnl - (trade.commission ?? 0);
        if (trade.pnl - (trade.commission ?? 0) > 0) current.wins += 1;
        grouped.set(key, current);
      });
    });

    return Array.from(grouped.values())
      .map(row => ({
        ...row,
        winRate: row.trades > 0 ? (row.wins / row.trades) * 100 : 0,
        avgPnL: row.trades > 0 ? row.netPnL / row.trades : 0,
      }))
      .sort((a, b) => b.netPnL - a.netPnL);
  }, [filteredTrades]);

  const behavioralFlagRows = useMemo(() => {
    const FLAG_LABELS: Record<string, string> = {
      'chased-entry':    'Chased entry',
      'no-confirmation': 'Jumped in early',
      'fomo':            'FOMO trade',
      'incorrect-stop-loss': 'Incorrect stop loss',
      'plan-deviation':  'Off-plan trade',
      'sized-up':        'Oversized position',
      'added-losing':    'Added to losing position',
      'moved-stop':      'Widened stop loss',
      'exit-early':      'Exited too early',
      'moved-target':    'Moved / ignored TP',
      'past-inval':      'Held past invalidation',
      'revenge':         'Revenge trade',
      'past-limit':      'Traded past daily limit',
    };
    const grouped = new Map<string, { label: string; count: number; netPnL: number }>();

    filteredTrades.forEach(trade => {
      const flags = (trade as unknown as { behavioral_flags?: string[] }).behavioral_flags ?? [];
      flags.forEach(flag => {
        const key = flag.toLowerCase();
        const current = grouped.get(key) ?? {
          label: FLAG_LABELS[key] ?? flag,
          count: 0,
          netPnL: 0,
        };
        current.count += 1;
        current.netPnL += trade.pnl - (trade.commission ?? 0);
        grouped.set(key, current);
      });
    });

    return Array.from(grouped.values())
      .map(row => ({ ...row, avgPnL: row.count > 0 ? row.netPnL / row.count : 0 }))
      .sort((a, b) => a.netPnL - b.netPnL);
  }, [filteredTrades]);

  const mistakeCost = useMemo(() => {
    const rows = behavioralFlagRows
      .map(row => ({
        ...row,
        cost: Math.max(0, -row.netPnL),
        recovered: Math.max(0, row.netPnL),
      }))
      .sort((a, b) => b.cost - a.cost || b.count - a.count);
    const costingRows = rows.filter(row => row.cost > 0);
    const topRows = costingRows.slice(0, 5);
    const otherRows = costingRows.slice(5);

    const avoidableCost = rows.reduce((sum, row) => sum + row.cost, 0);
    const otherCost = otherRows.reduce((sum, row) => sum + row.cost, 0);
    const otherCount = otherRows.reduce((sum, row) => sum + row.count, 0);
    const totalOccurrences = costingRows.reduce((sum, row) => sum + row.count, 0);
    const topLeak = rows.find(row => row.cost > 0) ?? null;
    const profitableFlags = rows.filter(row => row.recovered > 0).reduce((sum, row) => sum + row.recovered, 0);
    const netIfFixed = metrics.netPnL + avoidableCost;

    return {
      rows,
      topRows,
      otherCost,
      otherCount,
      totalOccurrences,
      avoidableCost,
      topLeak,
      profitableFlags,
      netIfFixed,
    };
  }, [behavioralFlagRows, metrics.netPnL]);

  // Hooks must run unconditionally — these lived below the loading early-return
  // before, which breaks React's hook ordering on the loading→loaded flip.
  const strongestConfluences = useMemo(
    () => confluenceRows.filter(row => row.netPnL > 0).slice(0, 3),
    [confluenceRows],
  );
  const weakestConfluences = useMemo(
    () => confluenceRows.filter(row => row.netPnL < 0).sort((a, b) => a.netPnL - b.netPnL).slice(0, 3),
    [confluenceRows],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner size="lg" label="Loading analytics..." />
      </div>
    );
  }

  const periodSubtitle = getPeriodLabel(period, periodOffset, today);
  const winLossTotal = metrics.wins.length + metrics.losses.length;

  // The KPI rail under the equity curve — one ruled strip, no floating boxes.
  const kpiCells: Array<{ label: string; value: ReactNode; color?: string; sub?: string; tip?: string }> = [
    {
      label: 'Expectancy',
      value: metrics.totalTrades > 0 ? formatSignedCurrency(metrics.expectedValue) : '--',
      color: metrics.expectedValue >= 0 ? DASHBOARD_GREEN : DASHBOARD_RED,
      sub: 'per trade',
      tip: 'Average dollar profit per trade, factoring in both win rate and win/loss size. Positive expectancy means the strategy has an edge over time.',
    },
    {
      label: 'Profit factor',
      value: metrics.profitFactor >= 999 ? '∞' : metrics.profitFactor.toFixed(2),
      color: metrics.profitFactor >= 1 ? DASHBOARD_GREEN : DASHBOARD_RED,
      sub: metrics.profitFactor >= 1 ? 'above breakeven' : 'below breakeven',
      tip: 'Gross profit ÷ gross loss. A value above 1.0 means you make more on winners than you lose on losers. 1.5+ is solid; 2.0+ is strong.',
    },
    {
      label: 'Max drawdown',
      value: maxDrawdown > 0 ? `−${formatCurrency(maxDrawdown)}` : '$0',
      color: maxDrawdown > 0 ? DASHBOARD_RED : 'var(--app-text)',
      sub: 'peak to trough',
      tip: 'The largest peak-to-trough decline in cumulative P&L during the selected period. Measures the worst losing run you experienced.',
    },
    {
      label: 'Avg win / loss',
      value: (
        <>
          <span style={{ color: DASHBOARD_GREEN }}>{metrics.wins.length > 0 ? formatSignedCurrency(metrics.avgWin) : '--'}</span>
          <span style={{ color: 'var(--app-text-subtle)' }}> / </span>
          <span style={{ color: DASHBOARD_RED }}>{metrics.losses.length > 0 ? formatSignedCurrency(metrics.avgLoss) : '--'}</span>
        </>
      ),
      sub: 'per scored trade',
    },
    {
      label: 'Avg RR',
      value: metrics.avgRR !== null ? formatRiskRewardRatio(metrics.avgRR, { decimals: 2 }) : '--',
      sub: 'planned reward : risk',
    },
    {
      label: 'Trades',
      value: String(metrics.totalTrades),
      sub: `${metrics.tradesPerDay.toFixed(1)}/day avg`,
    },
  ];

  return (
    <div className="animate-fade-in space-y-4">
      <PageHeader
        data-tour-id="analytics-header"
        title="Analytics"
        sub="Performance breakdown for your selected period"
        actions={
          <div data-tour-id="analytics-period-filter" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Date range navigator — hidden for YTD and ALL (no discrete periods) */}
            {period !== 'ALL' && period !== 'YTD' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '0 2px' }}>
                <button
                  type="button"
                  onClick={() => setPeriodOffset(o => o - 1)}
                  style={{
                    width: 24, height: 24, borderRadius: 5, border: '1px solid var(--app-border)',
                    background: 'transparent', color: 'var(--app-text-muted)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, lineHeight: 1, flexShrink: 0,
                  }}
                  title="Previous period"
                >
                  ‹
                </button>
                <span style={{
                  fontSize: 12, fontWeight: 500, color: 'var(--app-text)',
                  whiteSpace: 'nowrap', padding: '0 4px',
                }}>
                  {getPeriodLabel(period, periodOffset, today)}
                </span>
                {/* Only render › when it's usable — avoids invisible gap at offset 0 */}
                {periodOffset < 0 && (
                  <button
                    type="button"
                    onClick={() => setPeriodOffset(o => o + 1)}
                    style={{
                      width: 24, height: 24, borderRadius: 5, border: '1px solid var(--app-border)',
                      background: 'transparent', color: 'var(--app-text-muted)',
                      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 14, lineHeight: 1, flexShrink: 0,
                    }}
                    title="Next period"
                  >
                    ›
                  </button>
                )}
              </div>
            )}
            {/* Period tabs */}
            <div style={{ display: 'flex', gap: 4 }}>
              {PERIOD_OPTIONS.map(option => (
                <Btn
                  key={option.key}
                  variant={period === option.key ? 'primary' : 'ghost'}
                  size="sm"
                  onClick={() => handlePeriodChange(option.key)}
                >
                  {option.label}
                </Btn>
              ))}
            </div>
          </div>
        }
      />

      {accountTrades.length === 0 ? (
        <SectionPanel>
          <EmptyState
            title="Log trades to unlock performance breakdowns"
            sub="Once you add trades, this page will show equity curve, win rate, session performance, confluence quality, and time-of-day stats."
            action={{ label: 'Log first trade', onClick: () => window.location.href = '/scanner' }}
          />
        </SectionPanel>
      ) : filteredTrades.length === 0 ? (
        <SectionPanel>
          <EmptyState
            title="No trades in this period"
            sub="Switch to All or choose a wider period to review your full history."
          />
        </SectionPanel>
      ) : null}

      {/* Performance terminal — net result, curve, and the KPI rail in one sheet */}
      <section data-tour-id="analytics-equity-curve" className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]">
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-4">
          <div>
            <p style={KICKER}>Net P&amp;L · {periodSubtitle}</p>
            <p style={{
              margin: '9px 0 0', fontFamily: 'var(--font-mono)', fontSize: 29, fontWeight: 500,
              lineHeight: 1, letterSpacing: '-0.02em',
              color: metrics.netPnL >= 0 ? DASHBOARD_GREEN : DASHBOARD_RED,
            }}>
              {formatSignedCurrency(metrics.netPnL)}
            </p>
            <p style={{ margin: '8px 0 0', fontSize: 11, color: 'var(--app-text-muted)' }}>
              {netPnLChange === null
                ? `${metrics.totalTrades} trade${metrics.totalTrades !== 1 ? 's' : ''} · ${metrics.winRate.toFixed(0)}% win rate`
                : `${netPnLChange >= 0 ? '+' : ''}${netPnLChange.toFixed(1)}% vs previous period · ${metrics.winRate.toFixed(0)}% win rate`}
            </p>
          </div>
        </div>

        <div className="px-3 pt-2">
          {equityCurveData.length > 0 ? (
            <ResponsiveContainer width="100%" height={252}>
              <AreaChart data={equityCurveData} margin={{ top: 8, right: 10, left: 2, bottom: 2 }}>
                <defs>
                  <linearGradient id="pnl-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={DASHBOARD_GREEN} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={DASHBOARD_GREEN} stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--app-panel-strong)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'var(--app-text-subtle)', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fill: 'var(--app-text-subtle)', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={value => `$${Number(value).toLocaleString()}`}
                />
                <Tooltip
                  contentStyle={{ background: 'var(--app-panel)', border: '1px solid var(--app-border)', borderRadius: 10 }}
                  labelStyle={{ color: 'var(--app-text-muted)' }}
                  itemStyle={{ color: 'var(--app-text)' }}
                  formatter={(value: number, name: string, props: { payload?: { payoutAmount?: number } }) => {
                    if (name === 'cumulative') {
                      const payout = props.payload?.payoutAmount;
                      if (payout) {
                        return [`${formatCurrency(value)} (payout −${formatCurrency(payout)})`, 'P&L'];
                      }
                      return [formatCurrency(value), 'P&L'];
                    }
                    return [formatCurrency(value), 'Breakeven'];
                  }}
                />
                <ReferenceLine y={0} stroke="var(--accent)" strokeDasharray="5 3" strokeWidth={1.5} strokeOpacity={0.85} />
                <Area
                  type="monotone"
                  dataKey="cumulative"
                  stroke={DASHBOARD_GREEN}
                  strokeWidth={3}
                  fill="url(#pnl-fill)"
                  dot={(props: { cx?: number; cy?: number; index?: number; payload?: { payoutAmount?: number } }) => {
                    const hasPayout = !!props.payload?.payoutAmount;
                    if (!hasPayout) return <g key={`${props.cx}-${props.cy}`} />;
                    return (
                      <g key={`dot-${props.index}-${props.cx}-${props.cy}`}>
                        {hasPayout && <circle cx={props.cx} cy={props.cy} r={5} fill="#f59e0b" stroke="#0e0d0d" strokeWidth={1.5} />}
                      </g>
                    );
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[252px] items-center justify-center text-sm text-[var(--app-text-muted)]">
              No trades in this period.
            </div>
          )}
        </div>

        {/* KPI rail — ruled cells, no floating boxes */}
        <div data-tour-id="analytics-metrics" className="flex overflow-x-auto border-t border-[var(--app-border)]">
          {kpiCells.map((cell, i) => (
            <div key={cell.label} style={{ flex: '1 1 0', minWidth: 128, padding: '12px 18px', borderLeft: i === 0 ? 'none' : '1px solid var(--app-border)' }}>
              <p style={{ ...KICKER, fontSize: 9, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--app-text-subtle)' }}>
                {cell.label}{cell.tip && <InfoTooltip text={cell.tip} />}
              </p>
              <p style={{ margin: '7px 0 0', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', color: cell.color ?? 'var(--app-text)' }}>
                {cell.value}
              </p>
              {cell.sub && <p style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--app-text-subtle)', whiteSpace: 'nowrap' }}>{cell.sub}</p>}
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        {/* Win rate + last-20 record in one card */}
        <section data-tour-id="analytics-win-loss" className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]">
          <div style={{ padding: '15px 18px 16px' }}>
            <p style={KICKER}>Win rate · {winLossTotal} scored</p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginTop: 9 }}>
              <p style={{
                margin: 0, fontFamily: 'var(--font-mono)', fontSize: 29, fontWeight: 500, lineHeight: 1,
                color: winLossTotal === 0 ? 'var(--app-text-subtle)' : metrics.winRate >= 50 ? DASHBOARD_GREEN : DASHBOARD_RED,
              }}>
                {winLossTotal === 0 ? '--' : `${metrics.winRate.toFixed(0)}%`}
              </p>
              {winLossTotal > 0 && (
                <div
                  title={`${metrics.wins.length} wins · ${metrics.losses.length} losses`}
                  style={{
                    width: 58, height: 58, borderRadius: '50%', flexShrink: 0,
                    background: `conic-gradient(${DASHBOARD_GREEN} 0% ${metrics.winRate}%, ${DASHBOARD_RED} ${metrics.winRate}% 100%)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <div style={{ width: 36, height: 36, borderRadius: '50%', backgroundColor: 'var(--app-panel)' }} />
                </div>
              )}
            </div>
            <div style={{ display: 'flex', height: 10, borderRadius: 3, overflow: 'hidden', marginTop: 15, backgroundColor: 'var(--app-panel-strong)' }}>
              {winLossTotal > 0 && (
                <>
                  <span style={{ width: `${(metrics.wins.length / winLossTotal) * 100}%`, backgroundColor: DASHBOARD_GREEN }} />
                  <span style={{ width: `${(metrics.losses.length / winLossTotal) * 100}%`, backgroundColor: DASHBOARD_RED }} />
                </>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 9 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', color: DASHBOARD_GREEN }}>{metrics.wins.length} WINS</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', color: DASHBOARD_RED }}>{metrics.losses.length} LOSSES</span>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--app-border)', padding: '13px 18px 16px' }}>
            <p style={KICKER}>Last 20 trades</p>
            <div style={{ display: 'flex', gap: 3, marginTop: 11, height: 22 }}>
              {filteredTrades.slice(-20).map(trade => {
                const net = trade.pnl - (trade.commission ?? 0);
                return (
                  <span
                    key={trade.id}
                    title={formatSignedCurrency(net)}
                    style={{
                      flex: 1, maxWidth: 9, borderRadius: 2,
                      backgroundColor: net > 0 ? DASHBOARD_GREEN : net < 0 ? DASHBOARD_RED : 'var(--app-panel-strong)',
                    }}
                  />
                );
              })}
              {filteredTrades.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--app-text-subtle)' }}>No trades yet.</span>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 14px', marginTop: 13, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', color: 'var(--app-text-subtle)' }}>
              <span>CURRENT <b style={{ color: streakStats.currentType >= 0 ? DASHBOARD_GREEN : DASHBOARD_RED }}>{streakStats.currentLength}{streakStats.currentType >= 0 ? 'W' : 'L'}</b></span>
              <span>BEST <b style={{ color: DASHBOARD_GREEN }}>{streakStats.bestWin}W</b></span>
              <span>WORST <b style={{ color: DASHBOARD_RED }}>{streakStats.worstLoss}L</b></span>
              <span>MAX LOSS <b style={{ color: DASHBOARD_RED }}>{metrics.largestLoss < 0 ? formatCurrency(metrics.largestLoss) : '$0'}</b></span>
            </div>
          </div>
        </section>

        {/* Plan adherence — streak ribbon + rule breakdown, one reconciled object */}
        <RuleAdherenceCard data={adherenceData} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <LollipopDistribution
          title="P&L by day of week"
          rows={dayOfWeekRows.map(r => ({ key: r.label, count: r.count, value: r.pnl }))}
          order="given" unit="days" sortLabel="by weekday"
        />

        <LollipopDistribution
          title="P&L by session"
          rows={sessionRows.map(r => ({ key: r.label, count: r.count, value: r.pnl }))}
          order="given" unit="sessions" sortLabel="by session"
        />

        {holdTime.known > 0 ? (
          <LollipopDistribution
            title="P&L by hold time"
            rows={holdTime.rows.map(r => ({ key: r.label, count: r.count, value: r.pnl }))}
            order="given" unit="ranges" sortLabel="by duration"
            note={
              <>
                Winners held <b style={{ color: 'var(--app-text)' }}>{formatHoldSeconds(metrics.avgWinHold)}</b> avg
                {' '}· losers <b style={{ color: 'var(--app-text)' }}>{formatHoldSeconds(metrics.avgLossHold)}</b>
                {metrics.avgLossHold > 0 && metrics.avgWinHold > 0 && metrics.avgLossHold > metrics.avgWinHold * 1.5 && (
                  <>, <span style={{ color: DASHBOARD_RED }}>you sit in losers ~{(metrics.avgLossHold / metrics.avgWinHold).toFixed(1)}× longer than winners.</span></>
                )}
                {holdTime.worst && holdTime.best && holdTime.worst.label !== holdTime.best.label && (
                  <> {holdTime.worst.label} holds are the leak ({formatSignedCurrency(holdTime.worst.pnl)}).</>
                )}
              </>
            }
          />
        ) : (
          <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)]" style={{ padding: '20px 22px' }}>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '1.6px', textTransform: 'uppercase', color: 'var(--app-text-muted)' }}>P&amp;L by hold time</p>
            <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--app-text-subtle)' }}>
              No hold-time data in this period, durations come from scanned charts or the journal&apos;s entry/exit time fields.
            </p>
          </section>
        )}
      </div>

      {/* P&L Distribution — dot plot */}
      {pnlDistribution && (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 style={KICKER}>P&amp;L distribution</h3>
              <p className="mt-1.5 text-xs text-[var(--app-text-muted)]">Trade outcomes by dollar result</p>
              <div className="hidden">
                <span style={{ color: metrics.winRate >= 50 ? DASHBOARD_GREEN : DASHBOARD_RED, fontWeight: 700, fontSize: 13 }}>
                  {metrics.winRate.toFixed(0)}%
                </span>
                <span style={{ color: 'var(--app-text-muted)' }}>win rate</span>
                <span style={{ color: 'var(--app-text-subtle)' }}>·</span>
                <span style={{ color: 'var(--app-text)', fontWeight: 600 }}>
                  {pnlDistribution.wins.length}W / {pnlDistribution.losses.length}L
                </span>
                <span style={{ color: 'var(--app-text-subtle)' }}>·</span>
                <span style={{ color: metrics.avgPnL >= 0 ? DASHBOARD_GREEN : DASHBOARD_RED, fontWeight: 600 }}>
                  {formatSignedCurrency(metrics.avgPnL)}
                </span>
                <span style={{ color: 'var(--app-text-muted)' }}>avg / trade</span>
              </div>
            </div>
            {/* Size legend hint */}
            <span className="hidden">
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', display: 'inline-block', opacity: 0.5 }} />
              <span style={{ width: 11, height: 11, borderRadius: '50%', background: 'currentColor', display: 'inline-block', opacity: 0.5 }} />
              <span style={{ marginLeft: 3 }}>size = |P&amp;L|</span>
            </span>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <ScatterChart margin={{ top: 28, right: 16, left: 16, bottom: 16 }}>
              <CartesianGrid stroke="var(--app-panel-strong)" horizontal={false} />
              <XAxis
                dataKey="pnl"
                type="number"
                domain={[pnlDistribution.domainMin, pnlDistribution.domainMax]}
                tick={{ fill: 'var(--app-text-subtle)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickCount={6}
                tickFormatter={(v: number) => `$${Math.round(v).toLocaleString()}`}
              />
              <YAxis dataKey="y" type="number" hide domain={[0, 1]} />
              {/* dot area scales with |P&L|: ~2px to ~7px radius */}
              <ZAxis dataKey="size" range={[14, 160]} />
              <ReferenceLine
                x={0}
                stroke="var(--accent)"
                strokeDasharray="4 4"
                label={(props: any) => {
                  const vb = props?.viewBox;
                  if (!vb) return <g/>;
                  return (
                    <text x={vb.x} y={14}
                      fill="var(--accent)" fontSize={10} fontWeight={700}
                      textAnchor="middle">
                      $0
                    </text>
                  );
                }}
              />
              <Tooltip
                cursor={false}
                content={({ payload }) => {
                  const item = payload?.[0]?.payload as { pnl?: number; isPositive?: boolean } | undefined;
                  if (item == null || item.pnl == null) return null;
                  return (
                    <div style={{
                      background: 'var(--app-panel)', border: '1px solid var(--app-border)',
                      borderRadius: 10, padding: '8px 12px',
                    }}>
                      <p style={{ color: item.isPositive ? DASHBOARD_GREEN : DASHBOARD_RED, fontWeight: 600, fontSize: 13 }}>
                        {formatSignedCurrency(item.pnl)}
                      </p>
                      <p style={{ color: 'var(--app-text-muted)', fontSize: 11, marginTop: 2 }}>
                        {item.isPositive ? 'Win' : 'Loss'}
                      </p>
                    </div>
                  );
                }}
              />
              <Scatter data={pnlDistribution.losses} fill={DASHBOARD_RED} fillOpacity={0.75} />
              <Scatter data={pnlDistribution.wins} fill={DASHBOARD_GREEN} fillOpacity={0.75} />
            </ScatterChart>
          </ResponsiveContainer>
        </section>
      )}

      <section data-tour-id="analytics-time-of-day" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
        <div className="mb-5 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 style={KICKER}>P&amp;L by time of day</h3>
            <p className="text-xs text-[var(--app-text-muted)] mt-1.5">
              Avg P&amp;L in your most traded {timeWindow === 60 ? '1-hr' : `${timeWindow}-min`} windows
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-md border border-[var(--app-border)] bg-[var(--app-panel-strong)] p-0.5">
            {TIME_WINDOW_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setTimeWindow(opt.value)}
                className="rounded px-2.5 py-1 text-xs font-medium transition-colors"
                style={{
                  background: timeWindow === opt.value ? 'var(--accent, #60a5fa)' : 'transparent',
                  color: timeWindow === opt.value ? '#fff' : 'var(--app-text-muted)',
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto -mx-1 px-1">
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${timeOfDayRows.length}, minmax(72px, 1fr))`, minWidth: `${timeOfDayRows.length * 80}px` }}>
            {timeOfDayRows.map(row => (
              <div key={row.label} className="text-center">
                <p className="mb-1.5 text-[11px] text-[var(--app-text-muted)] whitespace-nowrap">{row.label}</p>
                <div
                  className="rounded-md px-1 py-2 text-xs font-medium whitespace-nowrap"
                  style={{
                    backgroundColor: row.avgPnL === null
                      ? 'var(--app-panel-strong)'
                      : row.avgPnL >= 0
                        ? `rgba(52,211,153,${0.3 + (row.ratio * 0.42)})`
                        : `rgba(248,113,113,${0.3 + (row.ratio * 0.42)})`,
                    color: row.avgPnL === null ? '#6d82a7' : row.avgPnL >= 0 ? DASHBOARD_GREEN : DASHBOARD_RED,
                  }}
                >
                  {row.avgPnL === null ? '--' : formatSignedCurrency(row.avgPnL)}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="hidden">
          <span className="text-xs text-[var(--app-text-muted)]">Mon-Fri</span>
          <div className="flex items-center gap-2 text-xs text-[var(--app-text-muted)]">
            <span>Loss</span>
            <span className="h-3 w-6 rounded bg-red-900/60" />
            <span className="h-3 w-6 rounded bg-red-400" />
            <span className="h-3 w-6 rounded bg-[var(--app-panel-strong)]" />
            <span className="h-3 w-6 rounded bg-emerald-900/60" />
            <span className="h-3 w-6 rounded bg-emerald-400" />
            <span className="h-3 w-6 rounded bg-emerald-400" />
            <span>Profit</span>
          </div>
        </div>
      </section>

      <section data-tour-id="analytics-confluence" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
        <div className="mb-1 flex items-start justify-between gap-3">
          <div>
            <h3 style={KICKER}>Confluence performance</h3>
            <p className="mt-1.5 text-xs text-[var(--app-text-muted)]">Which conditions are helping vs. hurting your P&amp;L</p>
          </div>
          <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.06em', color: 'var(--app-text-subtle)' }}>
            {confluenceRows.length} TRACKED
          </span>
        </div>

        {confluenceRows.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--app-text-muted)]">Add confluences on trades to unlock this breakdown.</p>
        ) : (() => {
          const shown = [...strongestConfluences, ...weakestConfluences];
          const maxAbs = Math.max(1, ...shown.map(row => Math.abs(row.netPnL)));
          const ledgerRow = (row: typeof shown[0], rank: number, positive: boolean) => (
            <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) minmax(90px, 220px) 100px', gap: 16, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--app-border)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, color: 'var(--app-text-subtle)' }}>
                {String(rank).padStart(2, '0')}
              </span>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--app-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.label}</p>
                <p style={{ margin: '2px 0 0', fontSize: 10.5, color: 'var(--app-text-subtle)' }}>{row.trades} trade{row.trades !== 1 ? 's' : ''} · {row.winRate.toFixed(0)}% win</p>
              </div>
              <div style={{ height: 5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.05)', overflow: 'hidden', display: 'flex', justifyContent: positive ? 'flex-start' : 'flex-end' }}>
                <div style={{ width: `${Math.max(2, (Math.abs(row.netPnL) / maxAbs) * 100)}%`, height: '100%', borderRadius: 2, backgroundColor: positive ? DASHBOARD_GREEN : DASHBOARD_RED, opacity: 0.9 }} />
              </div>
              <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', color: positive ? DASHBOARD_GREEN : DASHBOARD_RED }}>
                {formatSignedCurrency(row.netPnL)}
              </span>
            </div>
          );
          return (
            <div className="mt-4">
              <p style={{ margin: '0 0 2px', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: '0.1em', color: DASHBOARD_GREEN }}>MOST PROFITABLE</p>
              {strongestConfluences.length > 0
                ? strongestConfluences.map((row, i) => ledgerRow(row, i + 1, true))
                : <p style={{ margin: 0, padding: '10px 0', fontSize: 11, color: 'var(--app-text-subtle)', borderTop: '1px solid var(--app-border)' }}>None this period.</p>}
              <p style={{ margin: '16px 0 2px', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: '0.1em', color: DASHBOARD_RED }}>MOST COSTLY</p>
              {weakestConfluences.length > 0
                ? weakestConfluences.map((row, i) => ledgerRow(row, i + 1, false))
                : <p style={{ margin: 0, padding: '10px 0', fontSize: 11, color: 'var(--app-text-subtle)', borderTop: '1px solid var(--app-border)' }}>None this period.</p>}

              {confluenceRows.length > strongestConfluences.length + weakestConfluences.length && (() => {
                const allSorted = [...confluenceRows].sort((a, b) => b.netPnL - a.netPnL);
                const allMaxAbs = Math.max(1, ...allSorted.map(row => Math.abs(row.netPnL)));
                const fullRow = (row: typeof allSorted[0], rank: number) => {
                  const positive = row.netPnL >= 0;
                  return (
                    <div key={row.label} style={{ display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) minmax(90px, 220px) 100px', gap: 16, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--app-border)' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, color: 'var(--app-text-subtle)' }}>{String(rank).padStart(2, '0')}</span>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--app-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.label}</p>
                        <p style={{ margin: '2px 0 0', fontSize: 10.5, color: 'var(--app-text-subtle)' }}>{row.trades} trade{row.trades !== 1 ? 's' : ''} · {row.winRate.toFixed(0)}% win</p>
                      </div>
                      <div style={{ height: 5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.05)', overflow: 'hidden', display: 'flex', justifyContent: positive ? 'flex-start' : 'flex-end' }}>
                        <div style={{ width: `${Math.max(2, (Math.abs(row.netPnL) / allMaxAbs) * 100)}%`, height: '100%', borderRadius: 2, backgroundColor: positive ? DASHBOARD_GREEN : DASHBOARD_RED, opacity: 0.9 }} />
                      </div>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', color: positive ? DASHBOARD_GREEN : DASHBOARD_RED }}>{formatSignedCurrency(row.netPnL)}</span>
                    </div>
                  );
                };
                return (
                  <>
                    {showAllConfluences && (
                      <>
                        <p style={{ margin: '16px 0 2px', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: '0.1em', color: 'var(--app-text-subtle)' }}>ALL CONFLUENCES</p>
                        {allSorted.map((row, i) => fullRow(row, i + 1))}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowAllConfluences(v => !v)}
                      style={{ marginTop: 14, width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '8px 0', borderTop: '1px solid var(--app-border)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--app-text-muted)' }}
                    >
                      {showAllConfluences ? 'Show less' : `See all ${confluenceRows.length} confluences`}
                      <span style={{ display: 'inline-block', transition: 'transform 0.15s', transform: showAllConfluences ? 'rotate(180deg)' : 'none', fontSize: 9 }}>▾</span>
                    </button>
                  </>
                );
              })()}
            </div>
          );
        })()}
      </section>

      {mistakeCost.topRows.length > 0 && (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-2 flex items-start justify-between gap-4">
            <div>
              <h3 style={KICKER}>Mistake cost</h3>
              <p className="mt-1.5 text-xs text-[var(--app-text-muted)]">Top recurring leaks this period</p>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <p style={{ ...KICKER, fontSize: 9, color: 'var(--app-text-subtle)' }}>Avoidable loss</p>
              <p style={{ margin: '5px 0 0', fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 500, lineHeight: 1, color: DASHBOARD_RED }}>
                −{formatCurrency(mistakeCost.avoidableCost)}
              </p>
            </div>
          </div>

          <div>
            {(() => {
              const maxCost = Math.max(1, mistakeCost.topRows[0]?.cost ?? 0, mistakeCost.otherCost);
              const leakRow = (rank: string, label: string, count: number, cost: number, dim = false) => (
                <div key={label} style={{ display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) minmax(90px, 220px) 52px 110px', gap: 16, alignItems: 'center', padding: '10px 0', borderTop: '1px solid var(--app-border)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 500, color: 'var(--app-text-subtle)' }}>{rank}</span>
                  <span style={{ fontSize: 12.5, fontWeight: dim ? 400 : 600, color: dim ? 'var(--app-text-muted)' : 'var(--app-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {label}
                  </span>
                  <div style={{ height: 5, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(2, (cost / maxCost) * 100)}%`, height: '100%', borderRadius: 2, backgroundColor: DASHBOARD_RED, opacity: dim ? 0.5 : 0.9 }} />
                  </div>
                  <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--app-text-subtle)' }}>{count}×</span>
                  <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', color: DASHBOARD_RED }}>
                    −{formatCurrency(cost)}
                  </span>
                </div>
              );
              return (
                <>
                  {mistakeCost.topRows.map((row, index) => leakRow(String(index + 1).padStart(2, '0'), row.label, row.count, row.cost))}
                  {mistakeCost.otherCost > 0 && leakRow('+', 'Other flags', mistakeCost.otherCount, mistakeCost.otherCost, true)}
                </>
              );
            })()}
          </div>

          <p className="mt-3 text-xs text-[var(--app-text-muted)]">
            Fixing the top leak first would have the highest impact: <span className="text-[var(--app-text)]">{mistakeCost.topLeak?.label}</span>.
          </p>
        </section>
      )}

    </div>
  );
}
