import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';
import { formatCurrency } from '../utils/calculations.js';
import { getSessionKeyForTime, timeToMinutes } from '../utils/sessionTimes.js';
import { getTradeRiskReward } from '../utils/tradeAnalytics.js';
import { formatRiskRewardRatio } from '../utils/riskReward.js';
import { normalizeConfluenceTag } from '../utils/confluenceTags.js';

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

function getPeriodStart(period: PeriodKey, now: Date): Date | null {
  if (period === 'ALL') return null;

  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  if (period === '1W') {
    // Roll back to the most recent Monday (week restarts on Monday).
    const dow = base.getDay(); // 0=Sun,1=Mon,...,6=Sat
    const daysToMon = dow === 0 ? 6 : dow - 1;
    base.setDate(base.getDate() - daysToMon);
    return base;
  }

  if (period === '1M') {
    base.setMonth(base.getMonth() - 1);
    return base;
  }

  if (period === '3M') {
    base.setMonth(base.getMonth() - 3);
    return base;
  }

  return new Date(base.getFullYear(), 0, 1);
}

function getPreviousRange(period: PeriodKey, now: Date): { start: Date; end: Date } | null {
  const currentStart = getPeriodStart(period, now);
  if (!currentStart) return null;

  // For 1W always compare against the prior full calendar week (Mon–Sun).
  if (period === '1W') {
    const prevMonday = new Date(currentStart);
    prevMonday.setDate(prevMonday.getDate() - 7);
    return { start: prevMonday, end: currentStart };
  }

  const currentEnd = new Date(now);
  const duration = currentEnd.getTime() - currentStart.getTime();
  if (duration <= 0) return null;

  return {
    start: new Date(currentStart.getTime() - duration),
    end: currentStart,
  };
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

function formatHoldDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
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
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const deduped = new Set<string>();
  const normalized: string[] = [];

  for (const entry of rawValues) {
    if (typeof entry !== 'string') continue;
    const canonical = normalizeConfluenceTag(entry.trim().replace(/\s+/g, ' '));
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    if (deduped.has(key)) continue;
    deduped.add(key);
    normalized.push(canonical);
  }

  return normalized;
}

function MetricCard({
  label,
  value,
  subtitle,
  valueClassName,
}: {
  label: string;
  value: string;
  subtitle: string;
  valueClassName: string;
}) {
  return (
    <div className="min-h-[112px] rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
      <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--app-text-subtle)]">{label}</p>
      <p className={`mt-2 text-[22px] font-semibold leading-tight ${valueClassName}`}>{value}</p>
      <p className="mt-2 text-xs leading-[1.3] text-[var(--app-text-muted)]">{subtitle}</p>
    </div>
  );
}

export default function Analytics() {
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount, preferences } = useAppSettings();
  const [period, setPeriod] = useState<PeriodKey>('1M');
  const [timeWindow, setTimeWindow] = useState<TimeWindowMins>(30);
  const today = useMemo(() => new Date(), []);

  const sourceTrades = trades;
  const isLoading = loading;

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(sourceTrades),
    [filterTradesBySelectedAccount, sourceTrades]
  );

  const filteredTrades = useMemo(() => {
    const start = getPeriodStart(period, today);
    const next = accountTrades.filter(trade => {
      if (!start) return true;
      const tradeDate = parseTradeDateOnly(trade);
      return tradeDate ? tradeDate >= start : false;
    });

    return next.sort((a, b) => {
      const aTime = parseTradeDateTime(a)?.getTime() ?? 0;
      const bTime = parseTradeDateTime(b)?.getTime() ?? 0;
      return aTime - bTime;
    });
  }, [accountTrades, period, today]);

  const previousPeriodNet = useMemo(() => {
    const prev = getPreviousRange(period, today);
    if (!prev) return null;

    return accountTrades.reduce((sum, trade) => {
      const tradeDate = parseTradeDateOnly(trade);
      if (!tradeDate) return sum;
      if (tradeDate >= prev.start && tradeDate < prev.end) {
        return sum + trade.pnl;
      }
      return sum;
    }, 0);
  }, [accountTrades, period, today]);

  const metrics = useMemo(() => {
    const wins = filteredTrades.filter(trade => trade.pnl > 0);
    const losses = filteredTrades.filter(trade => trade.pnl < 0);
    const totalTrades = filteredTrades.length;
    const netPnL = filteredTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
    const scoredTrades = wins.length + losses.length;
    const winRate = scoredTrades > 0 ? (wins.length / scoredTrades) * 100 : 0;
    const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLoss;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((sum, trade) => sum + trade.pnl, 0) / losses.length : 0;
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
    const largestLoss = losses.length > 0 ? Math.min(...losses.map(trade => trade.pnl)) : 0;

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
      grouped.set(key, (grouped.get(key) ?? 0) + trade.pnl);
    });

    const daily = Array.from(grouped.entries()).sort(([a], [b]) => a.localeCompare(b));
    let cumulative = 0;
    return daily.map(([date, pnl]) => {
      cumulative += pnl;
      return {
        date,
        label: formatDateLabel(date),
        cumulative,
        breakeven: 0,
      };
    });
  }, [filteredTrades]);

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
    if (filteredTrades.length < 3) return [];
    const pnls = filteredTrades.map(t => t.pnl);
    const minVal = Math.min(...pnls);
    const maxVal = Math.max(...pnls);
    const range = maxVal - minVal;
    if (range < 0.01) return [];
    const BUCKETS = 10;
    const bucketSize = range / BUCKETS;
    return Array.from({ length: BUCKETS }, (_, i) => {
      const low = minVal + i * bucketSize;
      const high = low + bucketSize;
      const midpoint = (low + high) / 2;
      const count = pnls.filter(p =>
        i === BUCKETS - 1 ? p >= low && p <= high : p >= low && p < high,
      ).length;
      const label = midpoint >= 0
        ? `+${Math.round(midpoint)}`
        : `${Math.round(midpoint)}`;
      return { label, count, isPositive: midpoint >= 0 };
    });
  }, [filteredTrades]);

  const winLossData = useMemo(() => {
    const scoredTrades = metrics.wins.length + metrics.losses.length;
    if (scoredTrades === 0) {
      return [{ name: 'No trades', value: 1, color: 'var(--app-panel-strong)' }];
    }

    return [
      { name: 'Wins', value: metrics.wins.length, color: DASHBOARD_GREEN },
      { name: 'Losses', value: metrics.losses.length, color: DASHBOARD_RED },
    ];
  }, [metrics.losses.length, metrics.wins.length]);

  const dayOfWeekRows = useMemo(() => {
    const values: Record<string, number> = {
      Mon: 0,
      Tue: 0,
      Wed: 0,
      Thu: 0,
      Fri: 0,
    };

    filteredTrades.forEach(trade => {
      const tradeDate = parseTradeDateOnly(trade);
      if (!tradeDate) return;
      const dayLabel = DAY_LABELS[tradeDate.getDay()];
      if (dayLabel in values) {
        values[dayLabel] += trade.pnl;
      }
    });

    const maxAbs = Math.max(1, ...BUSINESS_DAY_LABELS.map(label => Math.abs(values[label])));
    return BUSINESS_DAY_LABELS.map(label => ({
      label,
      pnl: values[label],
      ratio: Math.abs(values[label]) / maxAbs,
    }));
  }, [filteredTrades]);

  const sessionRows = useMemo(() => {
    const totals = new Map<string, number>(SESSION_BUCKETS.map(bucket => [bucket.key, 0]));

    filteredTrades.forEach(trade => {
      const sessionKey = getSessionKeyForTime(trade.trade_time, preferences.sessionTimes);
      if (!totals.has(sessionKey)) return;
      totals.set(sessionKey, (totals.get(sessionKey) ?? 0) + trade.pnl);
    });

    const maxAbs = Math.max(1, ...SESSION_BUCKETS.map(item => Math.abs(totals.get(item.key) ?? 0)));
    return SESSION_BUCKETS.map(bucket => {
      const pnl = totals.get(bucket.key) ?? 0;
      return {
        key: bucket.key,
        label: bucket.label,
        pnl,
        ratio: Math.abs(pnl) / maxAbs,
      };
    });
  }, [filteredTrades, preferences.sessionTimes]);

  const streakStats = useMemo(() => {
    const outcomes = filteredTrades.map(trade => (trade.pnl > 0 ? 1 : trade.pnl < 0 ? -1 : 0));
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
      current.sumPnL += trade.pnl;
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
        const key = confluence.toLowerCase();
        const current = grouped.get(key) ?? {
          label: confluence,
          trades: 0,
          wins: 0,
          netPnL: 0,
        };
        current.trades += 1;
        current.netPnL += trade.pnl;
        if (trade.pnl > 0) current.wins += 1;
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
      'fomo': 'FOMO entry',
      'exit-early': 'Exited too early',
      'past-inval': 'Held past invalidation',
      'off-playbook': 'Off-playbook setup',
      'past-limit': 'Traded past daily limit',
      'revenge': 'Revenge trade',
      'oversize': 'Oversized position',
      'move-stop': 'Moved stop against plan',
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
        current.netPnL += trade.pnl;
        grouped.set(key, current);
      });
    });

    return Array.from(grouped.values())
      .map(row => ({ ...row, avgPnL: row.count > 0 ? row.netPnL / row.count : 0 }))
      .sort((a, b) => a.netPnL - b.netPnL);
  }, [filteredTrades]);

  const TF_ORDER = ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d'];
  const timeframeRows = useMemo(() => {
    const grouped = new Map<string, { trades: number; wins: number; netPnL: number }>();

    filteredTrades.forEach(trade => {
      const mins = trade.timeframe_minutes;
      if (!mins || mins <= 0) return;
      const label = mins >= 1440 ? '1d' : mins >= 240 ? '4h' : mins >= 120 ? '2h' : mins >= 60 ? '1h' : mins >= 30 ? '30m' : mins >= 15 ? '15m' : mins >= 10 ? '10m' : mins >= 5 ? '5m' : mins >= 3 ? '3m' : mins >= 2 ? '2m' : '1m';
      const current = grouped.get(label) ?? { trades: 0, wins: 0, netPnL: 0 };
      current.trades += 1;
      current.netPnL += trade.pnl;
      if (trade.pnl > 0) current.wins += 1;
      grouped.set(label, current);
    });

    return Array.from(grouped.entries())
      .map(([label, data]) => ({
        label,
        ...data,
        winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
        avgPnL: data.trades > 0 ? data.netPnL / data.trades : 0,
      }))
      .sort((a, b) => TF_ORDER.indexOf(a.label) - TF_ORDER.indexOf(b.label));
  }, [filteredTrades]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner size="lg" label="Loading analytics..." />
      </div>
    );
  }

  const periodSubtitle = period === 'ALL' ? 'all time' : period === 'YTD' ? 'year to date' : period.toLowerCase();
  const winLossTotal = metrics.wins.length + metrics.losses.length;
  const strongestConfluences = useMemo(
    () => confluenceRows.filter(row => row.netPnL > 0).slice(0, 5),
    [confluenceRows],
  );
  const weakestConfluences = useMemo(
    () => confluenceRows.filter(row => row.netPnL < 0).sort((a, b) => a.netPnL - b.netPnL).slice(0, 5),
    [confluenceRows],
  );

  return (
    <div className="animate-fade-in space-y-4">
      <div data-tour-id="analytics-header" className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[18px] font-semibold leading-tight text-[var(--app-text)]">Analytics</h1>
          <p className="mt-1 text-xs text-[var(--app-text-muted)]">Performance breakdown for your selected period</p>
        </div>

        <div data-tour-id="analytics-period-filter" className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map(option => {
            const active = period === option.key;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => setPeriod(option.key)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)]'
                    : 'border-[var(--app-border)] bg-[var(--app-panel)] text-[var(--app-text-muted)] hover:text-[var(--app-text)]'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {accountTrades.length === 0 ? (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-5 py-6">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">Analytics locked</p>
          <h2 className="mt-2 text-[16px] font-semibold text-[var(--app-text)]">Log trades to unlock performance breakdowns</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--app-text-muted)]">
            Once you add trades, this page will show equity curve, win rate, session performance, confluence quality, and time-of-day stats.
          </p>
          <Link
            to="/scanner"
            className="mt-4 inline-flex h-9 items-center rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--app-bg)]"
          >
            Log first trade
          </Link>
        </section>
      ) : filteredTrades.length === 0 ? (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-5 py-5">
          <h2 className="text-[15px] font-semibold text-[var(--app-text)]">No trades in this period</h2>
          <p className="mt-2 text-sm text-[var(--app-text-muted)]">Switch to All or choose a wider period to review your full history.</p>
        </section>
      ) : null}

      <div data-tour-id="analytics-metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <MetricCard
          label="Net P&L"
          value={formatSignedCurrency(metrics.netPnL)}
          subtitle={
            netPnLChange === null
              ? `Live for ${periodSubtitle}`
              : `${netPnLChange >= 0 ? '+' : ''}${netPnLChange.toFixed(1)}% vs previous period`
          }
          valueClassName={metrics.netPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        {/* Win Rate card with gauge */}
        <div className="min-h-[112px] rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
          <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--app-text-subtle)]">Win Rate</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <div>
              <p className="text-[22px] font-semibold leading-tight text-[var(--app-text)]">{`${metrics.winRate.toFixed(0)}%`}</p>
              <p className="mt-2 text-xs text-[var(--app-text-muted)]">{`${metrics.wins.length}W / ${metrics.losses.length}L`}</p>
            </div>
            <div className="flex flex-shrink-0 flex-col items-center gap-1">
              {(() => {
                const T = Math.PI * 40;
                const sc = metrics.wins.length + metrics.losses.length;
                const wArc = sc > 0 ? (metrics.wins.length / sc) * T : 0;
                const lArc = sc > 0 ? (metrics.losses.length / sc) * T : 0;
                return (
                  <svg viewBox="0 0 96 54" width="92" height="52">
                    <path d="M 8 50 A 40 40 0 0 1 88 50" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="7" strokeLinecap="round" />
                    {sc > 0 && wArc > 0 && (
                      <path d="M 8 50 A 40 40 0 0 1 88 50" fill="none"
                        stroke={DASHBOARD_GREEN} strokeWidth="7" strokeLinecap="round"
                        strokeDasharray={`${wArc} ${T}`} strokeDashoffset={0}
                      />
                    )}
                    {sc > 0 && lArc > 0 && (
                      <path d="M 8 50 A 40 40 0 0 1 88 50" fill="none"
                        stroke={DASHBOARD_RED} strokeWidth="7" strokeLinecap="round"
                        strokeDasharray={`${lArc} ${T}`} strokeDashoffset={-wArc}
                      />
                    )}
                  </svg>
                );
              })()}
              <span className="font-mono text-[10px] text-[var(--app-text-subtle)]">{metrics.wins.length} · {metrics.losses.length}</span>
            </div>
          </div>
        </div>
        <MetricCard
          label="Profit Factor"
          value={metrics.profitFactor >= 999 ? '∞' : metrics.profitFactor.toFixed(2)}
          subtitle={metrics.profitFactor >= 1 ? 'Above breakeven' : 'Below breakeven'}
          valueClassName={metrics.profitFactor >= 1 ? 'text-[var(--accent)]' : 'text-[#f87171]'}
        />
        <MetricCard
          label="Avg PL"
          value={formatSignedCurrency(metrics.avgPnL)}
          subtitle={`${metrics.totalTrades} trade${metrics.totalTrades === 1 ? '' : 's'} average`}
          valueClassName={metrics.avgPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <MetricCard
          label="Avg RR"
          value={metrics.avgRR !== null ? formatRiskRewardRatio(metrics.avgRR, { decimals: 2 }) : '--'}
          subtitle={metrics.avgRR !== null ? `${metrics.rrCount} trade${metrics.rrCount !== 1 ? 's' : ''} with SL/TP set` : 'Log SL & TP to calculate'}
          valueClassName="text-[var(--app-text)]"
        />
        <MetricCard
          label="Total Trades"
          value={String(metrics.totalTrades)}
          subtitle={`${metrics.tradesPerDay.toFixed(1)}/ day avg`}
          valueClassName="text-[var(--app-text)]"
        />
      </div>

      {/* Edge Metrics strip — Expectancy, Avg Win, Avg Loss, Max Drawdown */}
      {filteredTrades.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--app-text-subtle)]">Expectancy</p>
            <p className={`mt-1.5 text-lg font-semibold ${metrics.expectedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {metrics.totalTrades > 0 ? formatSignedCurrency(metrics.expectedValue) : '--'}
            </p>
            <p className="mt-1 text-[11px] text-[var(--app-text-muted)]">avg edge per trade</p>
          </div>
          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--app-text-subtle)]">Avg Win</p>
            <p className="mt-1.5 text-lg font-semibold text-emerald-400">
              {metrics.wins.length > 0 ? formatSignedCurrency(metrics.avgWin) : '--'}
            </p>
            <p className="mt-1 text-[11px] text-[var(--app-text-muted)]">{metrics.wins.length} winning trade{metrics.wins.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--app-text-subtle)]">Avg Loss</p>
            <p className="mt-1.5 text-lg font-semibold text-red-400">
              {metrics.losses.length > 0 ? formatSignedCurrency(metrics.avgLoss) : '--'}
            </p>
            <p className="mt-1 text-[11px] text-[var(--app-text-muted)]">{metrics.losses.length} losing trade{metrics.losses.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--app-text-subtle)]">Max Drawdown</p>
            <p className="mt-1.5 text-lg font-semibold text-red-400">
              {maxDrawdown > 0 ? `-${formatCurrency(maxDrawdown)}` : '$0'}
            </p>
            <p className="mt-1 text-[11px] text-[var(--app-text-muted)]">peak-to-trough loss</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
        <section data-tour-id="analytics-equity-curve" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--app-text)]">Cumulative P&amp;L</h2>
            <div className="flex items-center gap-3 text-xs text-[var(--app-text-muted)]">
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-emerald-400" />
                P&amp;L
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-[var(--accent)]" />
                Breakeven
              </span>
            </div>
          </div>

          {equityCurveData.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
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
                  formatter={(value: number, name) => [formatCurrency(value), name === 'cumulative' ? 'P&L' : 'Breakeven']}
                />
                <ReferenceLine y={0} stroke="var(--accent)" strokeDasharray="4 4" />
                <Area
                  type="monotone"
                  dataKey="cumulative"
                  stroke={DASHBOARD_GREEN}
                  strokeWidth={3}
                  fill="url(#pnl-fill)"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[240px] items-center justify-center text-sm text-[var(--app-text-muted)]">
              No trades in this period.
            </div>
          )}
        </section>

        <section data-tour-id="analytics-win-loss" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--app-text)]">Win / Loss</h2>
            <span className="rounded-md bg-[var(--accent-dim)] px-2.5 py-1 text-[11px] text-[var(--accent)]">
              {metrics.winRate.toFixed(0)}% win rate
            </span>
          </div>

          <div className="mt-4 grid grid-cols-[1fr_auto] items-start gap-3">
            <div className="h-[190px] min-h-[190px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={winLossData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={48}
                    outerRadius={82}
                    stroke="none"
                  >
                    {winLossData.map(segment => (
                      <Cell key={segment.name} fill={segment.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between gap-5">
                <span className="inline-flex items-center gap-2 text-[var(--app-text-muted)]">
                  <span className="h-3 w-3 rounded-full bg-emerald-400" />
                  Wins
                </span>
                <span className="text-emerald-400">{metrics.wins.length}</span>
              </div>
              <div className="flex items-center justify-between gap-5">
                <span className="inline-flex items-center gap-2 text-[var(--app-text-muted)]">
                  <span className="h-3 w-3 rounded-full bg-red-400" />
                  Losses
                </span>
                <span className="text-red-400">{metrics.losses.length}</span>
              </div>
              <div className="border-t border-[var(--app-border)] pt-3 text-xs">
                <div className="mb-2 flex items-center justify-between gap-3 text-[var(--app-text-muted)]">
                  <span>Avg hold (wins)</span>
                  <span className="text-[var(--app-text)]">{formatHoldDuration(metrics.avgWinHold)}</span>
                </div>
                <div className="flex items-center justify-between gap-3 text-[var(--app-text-muted)]">
                  <span>Avg hold (losses)</span>
                  <span className="text-[var(--app-text)]">{formatHoldDuration(metrics.avgLossHold)}</span>
                </div>
                {winLossTotal === 0 && (
                  <p className="mt-3 text-[var(--app-text-muted)]">No scored trades yet.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <h3 className="text-sm font-semibold text-[var(--app-text)]">P&amp;L by day of week</h3>
          <div className="mt-5 space-y-2.5">
            {dayOfWeekRows.map(row => (
              <div key={row.label} className="grid grid-cols-[46px_minmax(0,1fr)_92px] items-center gap-2.5">
                <span className="w-[46px] text-xs leading-none text-[var(--app-text-muted)]">{row.label}</span>
                <div className="min-w-0 h-2.5 rounded-full bg-[var(--app-panel-strong)]">
                  <div
                    className="h-2.5 rounded-full"
                    style={{
                      width: `${Math.max(6, row.ratio * 100)}%`,
                      backgroundColor: row.pnl >= 0 ? DASHBOARD_GREEN : DASHBOARD_RED,
                    }}
                  />
                </div>
                <span className={`text-right text-xs tabular-nums whitespace-nowrap ${row.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatSignedCurrency(row.pnl)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <h3 className="text-sm font-semibold text-[var(--app-text)]">P&amp;L by session</h3>
          <div className="mt-5 space-y-3">
            {sessionRows.map(row => (
              <div key={row.key} className="grid grid-cols-[92px_minmax(0,1fr)_92px] items-center gap-2.5">
                <span className="w-[92px] text-xs leading-[1.05] text-[var(--app-text-muted)]">{row.label}</span>
                <div className="min-w-0 h-2.5 rounded-full bg-[var(--app-panel-strong)]">
                  <div
                    className="h-2.5 rounded-full"
                    style={{
                      width: `${Math.max(6, row.ratio * 100)}%`,
                      backgroundColor: row.pnl >= 0 ? DASHBOARD_GREEN : DASHBOARD_RED,
                    }}
                  />
                </div>
                <span className={`text-right text-xs tabular-nums whitespace-nowrap ${row.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatSignedCurrency(row.pnl)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <h3 className="text-sm font-semibold text-[var(--app-text)]">Win/loss streak</h3>
          <p className="mt-3 text-xs text-[var(--app-text-muted)]">Last 20 trades</p>

          <div className="mt-4 flex flex-wrap gap-2">
            {filteredTrades.slice(-20).map((trade) => {
              const outcome = trade.pnl > 0 ? 1 : trade.pnl < 0 ? -1 : 0;
              return (
                <span
                  key={trade.id}
                  className="h-6 w-2 rounded-full"
                  style={{
                    backgroundColor: outcome > 0 ? DASHBOARD_GREEN : outcome < 0 ? DASHBOARD_RED : '#334155',
                  }}
                />
              );
            })}
          </div>

          <div className="mt-5 grid grid-cols-2 gap-4 text-xs">
            <div>
              <p className="text-[var(--app-text-muted)]">CURRENT</p>
              <p className={streakStats.currentType >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {streakStats.currentLength}{streakStats.currentType >= 0 ? 'W' : 'L'} streak
              </p>
            </div>
            <div>
              <p className="text-[var(--app-text-muted)]">BEST</p>
              <p className="text-emerald-400">{streakStats.bestWin}W streak</p>
            </div>
            <div>
              <p className="text-[var(--app-text-muted)]">WORST LOSS</p>
              <p className="text-red-400">{streakStats.worstLoss}L streak</p>
            </div>
            <div>
              <p className="text-[var(--app-text-muted)]">LARGEST LOSS</p>
              <p className="text-red-400">{metrics.largestLoss < 0 ? formatCurrency(metrics.largestLoss) : '$0.00'}</p>
            </div>
          </div>
        </section>
      </div>

      {/* P&L Distribution histogram */}
      {pnlDistribution.length > 0 && (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--app-text)]">P&amp;L Distribution</h3>
              <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">How your individual trade results are sized</p>
            </div>
            <div className="flex items-center gap-4 text-[11px] text-[var(--app-text-muted)]">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: DASHBOARD_GREEN }} />
                Wins
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: DASHBOARD_RED }} />
                Losses
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={pnlDistribution} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
              <CartesianGrid stroke="var(--app-panel-strong)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: 'var(--app-text-subtle)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: 'var(--app-text-subtle)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={28}
              />
              <Tooltip
                contentStyle={{ background: 'var(--app-panel)', border: '1px solid var(--app-border)', borderRadius: 10 }}
                labelStyle={{ color: 'var(--app-text-muted)', fontSize: 12 }}
                formatter={(value: number) => [value, 'Trades']}
                labelFormatter={(label: string) => `P&L ≈ $${label}`}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                {pnlDistribution.map((bucket) => (
                  <Cell
                    key={bucket.label}
                    fill={bucket.isPositive ? DASHBOARD_GREEN : DASHBOARD_RED}
                    fillOpacity={0.85}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </section>
      )}

      <section data-tour-id="analytics-time-of-day" className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
        <div className="mb-5 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-[var(--app-text)]">P&amp;L by time of day</h3>
            <p className="text-xs text-[var(--app-text-muted)] mt-0.5">
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

        <div className="grid grid-cols-7 gap-2">
          {timeOfDayRows.map(row => (
            <div key={row.label} className="text-center">
              <p className="mb-1.5 text-[11px] text-[var(--app-text-muted)]">{row.label}</p>
              <div
                className="rounded-md px-2 py-2 text-xs font-medium"
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

        <div className="mt-5 flex items-center justify-between">
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
        <div className="mb-5 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-[var(--app-text)]">Confluence Performance</h3>
          <p className="text-xs text-[var(--app-text-muted)]">Ranked by net P&amp;L contribution</p>
        </div>

        {confluenceRows.length === 0 ? (
          <p className="text-sm text-[var(--app-text-muted)]">Add confluences on trades to unlock this breakdown.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-emerald-300">Most Profitable</p>
              <div className="mt-3 space-y-2.5">
                {strongestConfluences.length > 0 ? strongestConfluences.map(row => (
                  <div key={row.label} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-[var(--app-panel)] px-3 py-2">
                    <div>
                      <p className="text-sm text-[var(--app-text)]">{row.label}</p>
                      <p className="text-xs text-[var(--app-text-muted)]">{row.trades} trades | {row.winRate.toFixed(0)}% win</p>
                    </div>
                    <p className="text-sm font-semibold text-emerald-400">{formatSignedCurrency(row.netPnL)}</p>
                  </div>
                )) : (
                  <p className="text-xs text-[var(--app-text-muted)]">No profitable confluences in this period.</p>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-red-300">Most Costly</p>
              <div className="mt-3 space-y-2.5">
                {weakestConfluences.length > 0 ? weakestConfluences.map(row => (
                  <div key={row.label} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-[var(--app-panel)] px-3 py-2">
                    <div>
                      <p className="text-sm text-[var(--app-text)]">{row.label}</p>
                      <p className="text-xs text-[var(--app-text-muted)]">{row.trades} trades | {row.winRate.toFixed(0)}% win</p>
                    </div>
                    <p className="text-sm font-semibold text-red-400">{formatSignedCurrency(row.netPnL)}</p>
                  </div>
                )) : (
                  <p className="text-xs text-[var(--app-text-muted)]">No losing confluences in this period.</p>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {timeframeRows.length > 0 && (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--app-text)]">P&amp;L by Timeframe</h3>
              <p className="text-xs text-[var(--app-text-muted)] mt-0.5">Performance breakdown across the timeframes you traded</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--app-border)]">
                  {['Timeframe', 'Trades', 'Win Rate', 'Avg P&L', 'Net P&L'].map(h => (
                    <th key={h} className="pb-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--app-text-subtle)]">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {timeframeRows.map(row => (
                  <tr key={row.label} className="border-b border-[var(--app-border)] last:border-0">
                    <td className="py-2.5 font-mono text-[var(--app-text)]">{row.label}</td>
                    <td className="py-2.5 text-[var(--app-text-muted)]">{row.trades}</td>
                    <td className={`py-2.5 ${row.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>{row.winRate.toFixed(0)}%</td>
                    <td className={`py-2.5 tabular-nums ${row.avgPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatSignedCurrency(row.avgPnL)}</td>
                    <td className={`py-2.5 font-medium tabular-nums ${row.netPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{formatSignedCurrency(row.netPnL)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {behavioralFlagRows.length > 0 && (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--app-text)]">Behavioral Flag Impact</h3>
              <p className="text-xs text-[var(--app-text-muted)] mt-0.5">P&amp;L lost to discipline errors in this period</p>
            </div>
            <span className="rounded-md bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-400">
              {behavioralFlagRows.reduce((sum, r) => sum + r.count, 0)} flag{behavioralFlagRows.reduce((sum, r) => sum + r.count, 0) !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="space-y-2">
            {behavioralFlagRows.map(row => (
              <div key={row.label} className="grid grid-cols-[minmax(0,1fr)_64px_92px_92px] items-center gap-3 rounded-lg border border-white/5 bg-[var(--app-panel-strong)] px-3 py-2.5 text-sm">
                <span className="truncate text-[var(--app-text)]">{row.label}</span>
                <span className="text-center text-xs text-[var(--app-text-muted)]">{row.count}×</span>
                <span className={`text-right text-xs tabular-nums ${row.avgPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatSignedCurrency(row.avgPnL)} avg
                </span>
                <span className={`text-right text-xs font-medium tabular-nums ${row.netPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatSignedCurrency(row.netPnL)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-[var(--app-text-muted)]">Flags are set on individual trades in the Journal → Psychology tab.</p>
        </section>
      )}
    </div>
  );
}
