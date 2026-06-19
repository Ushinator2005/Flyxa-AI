import { useMemo, useState, useRef } from 'react';
import { Btn, MetricCard, PageHeader, SectionPanel, EmptyState } from '../components/ds/index.js';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
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
import { useTrades } from '../hooks/useTrades.js';
import { ALL_ACCOUNTS_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { Trade } from '../types/index.js';
import { formatCurrency } from '../utils/calculations.js';
import { getSessionKeyForTime, timeToMinutes } from '../utils/sessionTimes.js';
import { getTradeRiskReward } from '../utils/tradeAnalytics.js';
import { formatRiskRewardRatio } from '../utils/riskReward.js';
import { normalizeConfluenceKey, normalizeConfluenceTags } from '../utils/confluenceTags.js';

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
      return `${fmt(start)} – ${fmt(endInclusive)}, ${start.getFullYear()}`;
    }
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} – ${endInclusive.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }

  if (period === '1M') {
    return start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  if (period === '3M') {
    if (start.getFullYear() === endInclusive.getFullYear()) {
      return `${fmt(start)} – ${fmt(endInclusive)}, ${start.getFullYear()}`;
    }
    return `${start.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} – ${endInclusive.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
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
  return normalizeConfluenceTags(value);
}


function InfoTooltip({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <span
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <span style={{
        width: 13, height: 13, borderRadius: '50%',
        border: '1px solid var(--color-border, rgba(255,255,255,0.18))',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'default', fontSize: 8, fontWeight: 700,
        color: 'var(--color-text-subtle)',
        lineHeight: 1, userSelect: 'none', flexShrink: 0,
      }}>?</span>
      {visible && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 7px)', left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--color-panel)',
          border: '1px solid var(--color-border)',
          borderRadius: 7, padding: '9px 11px',
          width: 230, zIndex: 50, pointerEvents: 'none',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          fontSize: 11, color: 'var(--color-text-muted)',
          lineHeight: 1.6,
        }}>
          {text}
        </div>
      )}
    </span>
  );
}

export default function Analytics() {
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount, preferences, selectedAccountId } = useAppSettings();
  const storeAccounts = useFlyxaStore(state => state.accounts);
  const selectedStoreAcct = selectedAccountId && selectedAccountId !== ALL_ACCOUNTS_ID
    ? storeAccounts.find(a => a.id === selectedAccountId)
    : undefined;
  const accountPayouts = selectedStoreAcct?.payouts ?? [];
  const [period, setPeriod] = useState<PeriodKey>('1M');
  const [periodOffset, setPeriodOffset] = useState<number>(0);
  const [timeWindow, setTimeWindow] = useState<TimeWindowMins>(30);
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

  const filteredTrades = useMemo(() => {
    const range = periodRange;
    const next = accountTrades.filter(trade => {
      if (!range) return true; // ALL — include everything
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

  const curveStats = useMemo(() => {
    if (equityCurveData.length < 2) return null;
    const values = equityCurveData.map(d => d.cumulative);
    const peak = Math.max(...values);
    const trough = Math.min(...values);
    if (peak === trough) return null;
    return {
      peak,
      trough,
      peakIdx: values.lastIndexOf(peak),
      troughIdx: values.lastIndexOf(trough),
    };
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
        values[dayLabel] += trade.pnl - (trade.commission ?? 0);
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
      totals.set(sessionKey, (totals.get(sessionKey) ?? 0) + (trade.pnl - (trade.commission ?? 0)));
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
      'off-playbook':    'Off-plan trade',
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

    const avoidableCost = rows.reduce((sum, row) => sum + row.cost, 0);
    const topLeak = rows.find(row => row.cost > 0) ?? null;
    const profitableFlags = rows.filter(row => row.recovered > 0).reduce((sum, row) => sum + row.recovered, 0);
    const netIfFixed = metrics.netPnL + avoidableCost;

    return {
      rows,
      avoidableCost,
      topLeak,
      profitableFlags,
      netIfFixed,
    };
  }, [behavioralFlagRows, metrics.netPnL]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <LoadingSpinner size="lg" label="Loading analytics..." />
      </div>
    );
  }

  const periodSubtitle = getPeriodLabel(period, periodOffset, today);
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

      {/* Row 1 — headline metrics */}
      <div data-tour-id="analytics-metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard
          label="Net P&L"
          value={formatSignedCurrency(metrics.netPnL)}
          sub={netPnLChange === null ? `Live for ${periodSubtitle}` : `${netPnLChange >= 0 ? '+' : ''}${netPnLChange.toFixed(1)}% vs previous period`}
          valueTone={metrics.netPnL >= 0 ? 'positive' : 'negative'}
        />
        <MetricCard
          label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Expectancy
              <InfoTooltip text="Average dollar profit per trade, factoring in both win rate and win/loss size. Positive expectancy means the strategy has an edge over time." />
            </span>
          }
          value={metrics.totalTrades > 0 ? formatSignedCurrency(metrics.expectedValue) : '--'}
          sub="avg edge per trade"
          valueTone={metrics.expectedValue >= 0 ? 'positive' : 'negative'}
        />
        <MetricCard
          label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Max Drawdown
              <InfoTooltip text="The largest peak-to-trough decline in cumulative P&L during the selected period. Measures the worst losing run you experienced." />
            </span>
          }
          value={maxDrawdown > 0 ? `-${formatCurrency(maxDrawdown)}` : '$0'}
          sub="peak-to-trough loss"
          valueTone={maxDrawdown > 0 ? 'negative' : 'neutral'}
        />
        <MetricCard
          label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Profit Factor
              <InfoTooltip text="Gross profit ÷ gross loss. A value above 1.0 means you make more on winners than you lose on losers. 1.5+ is solid; 2.0+ is strong." />
            </span>
          }
          value={metrics.profitFactor >= 999 ? '∞' : metrics.profitFactor.toFixed(2)}
          sub={metrics.profitFactor >= 1 ? 'Above breakeven' : 'Below breakeven'}
          valueTone={metrics.profitFactor >= 1 ? 'positive' : 'negative'}
        />
        <MetricCard
          label="Total Trades"
          value={String(metrics.totalTrades)}
          sub={`${metrics.tradesPerDay.toFixed(1)}/day avg`}
        />
      </div>

      {/* Row 2 — supporting detail (compact tier) */}
      {filteredTrades.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard size="compact" label="Avg P/L" value={formatSignedCurrency(metrics.avgPnL)} sub={`${metrics.totalTrades} trade${metrics.totalTrades === 1 ? '' : 's'} average`} valueTone={metrics.avgPnL >= 0 ? 'positive' : 'negative'} />
          <MetricCard size="compact" label="Avg Win" value={metrics.wins.length > 0 ? formatSignedCurrency(metrics.avgWin) : '--'} sub={`${metrics.wins.length} winning trade${metrics.wins.length !== 1 ? 's' : ''}`} valueTone="positive" />
          <MetricCard size="compact" label="Avg Loss" value={metrics.losses.length > 0 ? formatSignedCurrency(metrics.avgLoss) : '--'} sub={`${metrics.losses.length} losing trade${metrics.losses.length !== 1 ? 's' : ''}`} valueTone="negative" />
          <MetricCard size="compact" label="Avg RR" value={metrics.avgRR !== null ? formatRiskRewardRatio(metrics.avgRR, { decimals: 2 }) : '--'} sub={metrics.avgRR !== null ? `${metrics.rrCount} trade${metrics.rrCount !== 1 ? 's' : ''} with SL/TP set` : 'Log SL & TP to calculate'} />
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
              {curveStats && (
                <>
                  <span className="inline-flex items-center gap-2">
                    <span style={{ display: 'inline-block', width: 16, height: 0, border: `1.5px dashed ${DASHBOARD_GREEN}`, opacity: 0.75 }} />
                    Peak
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <span style={{ display: 'inline-block', width: 16, height: 0, border: `1.5px dashed ${DASHBOARD_RED}`, opacity: 0.75 }} />
                    Trough
                  </span>
                </>
              )}
              {accountPayouts.length > 0 && (
                <span className="inline-flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full" style={{ background: '#f59e0b' }} />
                  Payout
                </span>
              )}
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
                {curveStats && curveStats.peak !== 0 && (
                  <ReferenceLine
                    y={curveStats.peak}
                    stroke={DASHBOARD_GREEN}
                    strokeDasharray="4 4"
                    strokeOpacity={0.6}
                    label={(props: any) => {
                      const vb = props?.viewBox;
                      if (!vb) return <g/>;
                      // Near bottom (little room below) → label above; otherwise below
                      const yOff = (vb.height ?? 100) < 50 ? -14 : 13;
                      return (
                        <text x={(vb.x ?? 0) + 6} y={(vb.y ?? 0) + yOff}
                          fill={DASHBOARD_GREEN} fontSize={10} fontWeight={600}>
                          {formatSignedCurrency(curveStats.peak)}
                        </text>
                      );
                    }}
                  />
                )}
                {curveStats && curveStats.trough !== 0 && (
                  <ReferenceLine
                    y={curveStats.trough}
                    stroke={DASHBOARD_RED}
                    strokeDasharray="4 4"
                    strokeOpacity={0.6}
                    label={(props: any) => {
                      const vb = props?.viewBox;
                      if (!vb) return <g/>;
                      // Near bottom (little room below) → label above; otherwise below
                      const yOff = (vb.height ?? 100) < 50 ? -14 : 13;
                      return (
                        <text x={(vb.x ?? 0) + 6} y={(vb.y ?? 0) + yOff}
                          fill={DASHBOARD_RED} fontSize={10} fontWeight={600}>
                          {formatSignedCurrency(curveStats.trough)}
                        </text>
                      );
                    }}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey="cumulative"
                  stroke={DASHBOARD_GREEN}
                  strokeWidth={3}
                  fill="url(#pnl-fill)"
                  dot={(props: { cx?: number; cy?: number; index?: number; payload?: { payoutAmount?: number } }) => {
                    const hasPayout = !!props.payload?.payoutAmount;
                    const isPeak = curveStats != null && props.index === curveStats.peakIdx;
                    const isTrough = curveStats != null && props.index === curveStats.troughIdx;
                    if (!hasPayout && !isPeak && !isTrough) return <g key={`${props.cx}-${props.cy}`} />;
                    return (
                      <g key={`dot-${props.index}-${props.cx}-${props.cy}`}>
                        {hasPayout && <circle cx={props.cx} cy={props.cy} r={5} fill="#f59e0b" stroke="#0e0d0d" strokeWidth={1.5} />}
                        {isPeak && !hasPayout && <circle cx={props.cx} cy={props.cy} r={5} fill={DASHBOARD_GREEN} stroke="#0e0d0d" strokeWidth={1.5} />}
                        {isTrough && !hasPayout && <circle cx={props.cx} cy={props.cy} r={5} fill={DASHBOARD_RED} stroke="#0e0d0d" strokeWidth={1.5} />}
                      </g>
                    );
                  }}
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
          <div className="mb-1 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--app-text)]">Win Rate</h2>
          </div>
          <div className="mb-3 flex items-baseline gap-2">
            <span style={{
              fontSize: 24,
              fontWeight: 700,
              lineHeight: 1,
              color: metrics.winRate >= 50 ? 'var(--green, #34d399)' : 'var(--red, #f87171)',
              fontVariantNumeric: 'tabular-nums',
              WebkitFontSmoothing: 'antialiased',
            }}>
              {metrics.winRate.toFixed(0)}%
            </span>
            <span style={{ fontSize: 12, color: 'var(--app-text-muted)', fontWeight: 400 }}>
              {metrics.wins.length}W / {metrics.losses.length}L
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
                      width: `${row.ratio * 90}%`,
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
                      width: `${row.ratio * 90}%`,
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
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--app-text)]">Win/loss streak</h3>
            <span className="flex items-center gap-2.5 text-[10px] text-[var(--app-text-subtle)]">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-1.5 rounded-full" style={{ backgroundColor: DASHBOARD_GREEN }} />
                Win
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-1.5 rounded-full" style={{ backgroundColor: DASHBOARD_RED }} />
                Loss
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-1.5 rounded-full bg-slate-600" />
                Breakeven
              </span>
            </span>
          </div>
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

      {/* P&L Distribution — dot plot */}
      {pnlDistribution && (
        <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--app-text)]">P&amp;L Distribution</h3>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
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
            <span className="mt-0.5 shrink-0 flex items-center gap-1 text-[10px]" style={{ color: 'var(--app-text-subtle)' }}>
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
              {/* Mean / expectancy line — gray, thinner, doesn't compete with $0 */}
              {Math.abs(pnlDistribution.meanPnL) > pnlDistribution.domainMax * 0.01 && (
                <ReferenceLine
                  x={pnlDistribution.meanPnL}
                  stroke="rgba(148,163,184,0.5)"
                  strokeDasharray="3 3"
                  strokeWidth={1.5}
                  label={(props: any) => {
                    const vb = props?.viewBox;
                    if (!vb) return <g/>;
                    return (
                      <text x={vb.x} y={14}
                        fill="rgba(148,163,184,0.9)" fontSize={9} fontWeight={600}
                        textAnchor="middle">
                        {formatSignedCurrency(pnlDistribution.meanPnL)}
                      </text>
                    );
                  }}
                />
              )}
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
              {/* Zone count labels at the top of each side */}
              <ReferenceLine
                x={pnlDistribution.domainMin / 2}
                stroke="transparent"
                label={(props: any) => {
                  const vb = props?.viewBox;
                  if (!vb) return <g/>;
                  return (
                    <text x={vb.x} y={14}
                      fill={DASHBOARD_RED} fontSize={10} fontWeight={700}
                      textAnchor="middle" opacity={0.85}>
                      {pnlDistribution.losses.length} loss{pnlDistribution.losses.length !== 1 ? 'es' : ''}
                    </text>
                  );
                }}
              />
              <ReferenceLine
                x={pnlDistribution.domainMax / 2}
                stroke="transparent"
                label={(props: any) => {
                  const vb = props?.viewBox;
                  if (!vb) return <g/>;
                  return (
                    <text x={vb.x} y={14}
                      fill={DASHBOARD_GREEN} fontSize={10} fontWeight={700}
                      textAnchor="middle" opacity={0.85}>
                      {pnlDistribution.wins.length} win{pnlDistribution.wins.length !== 1 ? 's' : ''}
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
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--app-text)]">Confluence Performance</h3>
            <p className="mt-0.5 text-xs text-[var(--app-text-muted)]">Which conditions are helping vs. hurting your P&amp;L</p>
          </div>
          <span className="shrink-0 rounded-md bg-[var(--app-panel-strong)] px-2.5 py-1 text-[11px] text-[var(--app-text-muted)]">
            {confluenceRows.length} confluence{confluenceRows.length !== 1 ? 's' : ''}
          </span>
        </div>

        {confluenceRows.length === 0 ? (
          <p className="text-sm text-[var(--app-text-muted)]">Add confluences on trades to unlock this breakdown.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {/* Most Profitable */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-400">Most Profitable</p>
              </div>
              {strongestConfluences.length > 0 ? (
                <div className="space-y-1">
                  {strongestConfluences.map((row, i) => {
                    const maxPnL = strongestConfluences[0]?.netPnL ?? 1;
                    const fillPct = Math.max(6, (row.netPnL / maxPnL) * 100);
                    return (
                      <div key={row.label} className="group relative flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2.5">
                        <div
                          className="absolute inset-y-0 left-0 rounded-lg transition-[width] duration-500"
                          style={{ width: `${fillPct}%`, background: 'rgba(52,211,153,0.08)' }}
                        />
                        <span className="relative z-10 w-4 shrink-0 text-center text-[10px] font-mono font-semibold text-emerald-500/50">{i + 1}</span>
                        <div className="relative z-10 flex-1 min-w-0">
                          <p className="truncate text-sm text-[var(--app-text)]">{row.label}</p>
                          <p className="text-[11px] text-[var(--app-text-muted)]">{row.trades} trade{row.trades !== 1 ? 's' : ''} · {row.winRate.toFixed(0)}% win</p>
                        </div>
                        <p className="relative z-10 shrink-0 text-sm font-semibold tabular-nums text-emerald-400">{formatSignedCurrency(row.netPnL)}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="py-4 text-center text-xs text-[var(--app-text-muted)]">No profitable confluences this period.</p>
              )}
            </div>

            {/* Most Costly */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-red-400">Most Costly</p>
              </div>
              {weakestConfluences.length > 0 ? (
                <div className="space-y-1">
                  {weakestConfluences.map((row, i) => {
                    const maxLoss = Math.abs(weakestConfluences[0]?.netPnL ?? 1);
                    const fillPct = Math.max(6, (Math.abs(row.netPnL) / maxLoss) * 100);
                    return (
                      <div key={row.label} className="group relative flex items-center gap-3 overflow-hidden rounded-lg px-3 py-2.5">
                        <div
                          className="absolute inset-y-0 left-0 rounded-lg transition-[width] duration-500"
                          style={{ width: `${fillPct}%`, background: 'rgba(248,113,113,0.08)' }}
                        />
                        <span className="relative z-10 w-4 shrink-0 text-center text-[10px] font-mono font-semibold text-red-500/50">{i + 1}</span>
                        <div className="relative z-10 flex-1 min-w-0">
                          <p className="truncate text-sm text-[var(--app-text)]">{row.label}</p>
                          <p className="text-[11px] text-[var(--app-text-muted)]">{row.trades} trade{row.trades !== 1 ? 's' : ''} · {row.winRate.toFixed(0)}% win</p>
                        </div>
                        <p className="relative z-10 shrink-0 text-sm font-semibold tabular-nums text-red-400">{formatSignedCurrency(row.netPnL)}</p>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="py-4 text-center text-xs text-[var(--app-text-muted)]">No losing confluences this period.</p>
              )}
            </div>
          </div>
        )}
      </section>

      {mistakeCost.rows.length > 0 && (() => {
        const totalOccurrences = mistakeCost.rows.reduce((s, r) => s + r.count, 0);
        const maxCost = Math.max(1, ...mistakeCost.rows.map(row => row.cost));
        return (
          <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
            {/* Header */}
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--app-text)]">Mistake Cost</h3>
                <p className="mt-0.5 text-[11px] text-[var(--app-text-muted)]">Repeat behaviors costing you this period</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="rounded bg-[var(--app-panel-strong)] px-2 py-0.5 text-[10px] text-[var(--app-text-muted)]">{totalOccurrences}x</span>
                <span className="rounded bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-red-400">
                  -{formatCurrency(mistakeCost.avoidableCost)}
                </span>
              </div>
            </div>

            {/* Compact stat strip */}
            <div className="mb-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-border)]">
              <div className="bg-[var(--app-panel-strong)] px-3 py-2">
                <p className="text-[10px] text-[var(--app-text-subtle)]">Avoidable loss</p>
                <p className="mt-0.5 text-sm font-bold tabular-nums text-red-400">-{formatCurrency(mistakeCost.avoidableCost)}</p>
              </div>
              <div className="bg-[var(--app-panel-strong)] px-3 py-2">
                <p className="text-[10px] text-[var(--app-text-subtle)]">Top leak</p>
                <p className={`mt-0.5 truncate text-[12px] font-semibold ${mistakeCost.topLeak ? 'text-red-400' : 'text-emerald-400'}`}>
                  {mistakeCost.topLeak ? mistakeCost.topLeak.label : '—'}
                </p>
              </div>
              <div className="bg-[var(--app-panel-strong)] px-3 py-2">
                <p className="text-[10px] text-[var(--app-text-subtle)]">Net if fixed</p>
                <p className={`mt-0.5 text-sm font-bold tabular-nums ${mistakeCost.netIfFixed >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatSignedCurrency(mistakeCost.netIfFixed)}
                </p>
              </div>
            </div>

            {/* Rows */}
            <div className="space-y-1.5">
              {mistakeCost.rows.map((row, index) => {
                const width = Math.max(6, (row.cost / maxCost) * 100);
                const hasCost = row.cost > 0;
                const recoveredWidth = Math.max(8, Math.min(100, (row.recovered / Math.max(1, mistakeCost.profitableFlags)) * 100));
                return (
                  <div key={row.label} className="flex items-center gap-3">
                    <span className={`w-4 shrink-0 text-right font-mono text-[10px] ${hasCost ? 'text-red-400/50' : 'text-emerald-400/50'}`}>
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[12px] text-[var(--app-text)]">{row.label}</p>
                        <div className="flex shrink-0 items-center gap-2.5">
                          <span className="font-mono text-[10px] text-[var(--app-text-subtle)]">{row.count}x</span>
                          <span className={`w-[72px] text-right font-mono text-[11px] font-semibold tabular-nums ${hasCost ? 'text-red-400' : 'text-emerald-400'}`}>
                            {hasCost ? `-${formatCurrency(row.cost)}` : formatSignedCurrency(row.recovered)}
                          </span>
                        </div>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--app-panel-strong)]">
                        <div
                          className={`h-full rounded-full ${hasCost ? 'bg-red-400/70' : 'bg-emerald-400/70'}`}
                          style={{ width: `${hasCost ? width : recoveredWidth}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}

      {false && behavioralFlagRows.length > 0 && (() => {
        const totalCost = behavioralFlagRows.reduce((s, r) => s + r.netPnL, 0);
        const totalOccurrences = behavioralFlagRows.reduce((s, r) => s + r.count, 0);
        return (
          <section className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] p-4">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--app-text)]">Behavioral Flag Impact</h3>
                <p className="text-xs text-[var(--app-text-muted)] mt-0.5">P&amp;L cost of discipline errors this period</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="rounded-md bg-[var(--app-panel-strong)] px-2.5 py-1 text-[11px] text-[var(--app-text-muted)]">
                  {totalOccurrences}×
                </span>
                <span className={`rounded-md px-2.5 py-1 text-[11px] font-semibold tabular-nums ${totalCost >= 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                  {formatSignedCurrency(totalCost)}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {behavioralFlagRows.map(row => {
                const isPos = row.netPnL >= 0;
                return (
                  <div key={row.label} className="relative overflow-hidden rounded-lg border border-red-500/15 bg-red-500/5 p-3">
                    <div className="mb-2.5 flex items-start justify-between gap-1.5">
                      <p className="text-xs leading-snug text-[var(--app-text)]">{row.label}</p>
                      <span className="shrink-0 rounded-full bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-red-400">
                        {row.count}×
                      </span>
                    </div>
                    <p className={`text-lg font-bold tabular-nums leading-none ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatSignedCurrency(row.netPnL)}
                    </p>
                    <p className="mt-1 text-[10px] text-[var(--app-text-muted)]">{formatSignedCurrency(row.avgPnL)} avg</p>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}
    </div>
  );
}
