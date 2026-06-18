import { format } from 'date-fns';
import { AnalyticsSummary, EquityCurvePoint, Trade } from '../types/index.js';

export function getTradeRiskReward(trade: Trade): number | null {
  if (!trade.entry_price || !trade.sl_price || !trade.tp_price) return null;
  const risk = Math.abs(trade.entry_price - trade.sl_price);
  const reward = Math.abs(trade.tp_price - trade.entry_price);
  if (risk === 0) return null;
  return reward / risk;
}

export function buildAnalyticsSummary(trades: Trade[]): AnalyticsSummary {
  if (trades.length === 0) {
    return {
      netPnL: 0,
      winRate: 0,
      profitFactor: 0,
      avgRR: 0,
      totalTrades: 0,
      avgWin: 0,
      avgLoss: 0,
      largestWin: 0,
      largestLoss: 0,
      consecutiveWins: 0,
      consecutiveLosses: 0,
    };
  }

  const sortedTrades = [...trades].sort((a, b) => `${a.trade_date} ${a.trade_time}`.localeCompare(`${b.trade_date} ${b.trade_time}`));
  // Effective P&L accounts for commissions/fees paid
  const ep = (trade: Trade) => trade.pnl - (trade.commission ?? 0);
  const wins = sortedTrades.filter(trade => ep(trade) > 0);
  const losses = sortedTrades.filter(trade => ep(trade) < 0);
  const rrValues = sortedTrades.map(getTradeRiskReward).filter((value): value is number => value !== null);

  let currentWins = 0;
  let currentLosses = 0;
  let consecutiveWins = 0;
  let consecutiveLosses = 0;

  sortedTrades.forEach(trade => {
    if (ep(trade) > 0) {
      currentWins += 1;
      currentLosses = 0;
      consecutiveWins = Math.max(consecutiveWins, currentWins);
    } else if (ep(trade) < 0) {
      currentLosses += 1;
      currentWins = 0;
      consecutiveLosses = Math.max(consecutiveLosses, currentLosses);
    }
  });

  const grossProfit = wins.reduce((sum, trade) => sum + ep(trade), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + ep(trade), 0));

  return {
    netPnL: sortedTrades.reduce((sum, trade) => sum + ep(trade), 0),
    winRate: (wins.length / sortedTrades.length) * 100,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLoss,
    avgRR: rrValues.length > 0 ? rrValues.reduce((sum, value) => sum + value, 0) / rrValues.length : 0,
    totalTrades: sortedTrades.length,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? losses.reduce((sum, trade) => sum + ep(trade), 0) / losses.length : 0,
    largestWin: wins.length > 0 ? Math.max(...wins.map(trade => ep(trade))) : 0,
    largestLoss: losses.length > 0 ? Math.min(...losses.map(trade => ep(trade))) : 0,
    consecutiveWins,
    consecutiveLosses,
  };
}

export function buildEquityCurve(trades: Trade[]): EquityCurvePoint[] {
  const grouped = new Map<string, number>();

  [...trades]
    .sort((a, b) => `${a.trade_date} ${a.trade_time}`.localeCompare(`${b.trade_date} ${b.trade_time}`))
    .forEach(trade => {
      grouped.set(trade.trade_date, (grouped.get(trade.trade_date) ?? 0) + (trade.pnl - (trade.commission ?? 0)));
    });

  let cumulative = 0;
  return Array.from(grouped.entries()).map(([date, pnl]) => {
    cumulative += pnl;
    return { date, pnl, cumulative };
  });
}

export function buildMonthlyHeatmapData(trades: Trade[], year: number, month: number) {
  const days: Record<number, number> = {};
  const counts: Record<number, number> = {};

  trades.forEach(trade => {
    if (!trade.trade_date) return;
    const date = new Date(`${trade.trade_date}T00:00:00`);
    if (Number.isNaN(date.getTime())) return;
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month) return;

    const day = date.getDate();
    const grossPnl = typeof trade.pnlOverride === 'number' && Number.isFinite(trade.pnlOverride)
      ? trade.pnlOverride
      : trade.pnl;
    days[day] = (days[day] ?? 0) + (grossPnl - (trade.commission ?? 0));
    counts[day] = (counts[day] ?? 0) + 1;
  });

  return { days, counts };
}

export function buildRecentTrades(trades: Trade[], limit = 10) {
  return [...trades]
    .sort((a, b) => `${b.trade_date} ${b.trade_time}`.localeCompare(`${a.trade_date} ${a.trade_time}`))
    .slice(0, limit);
}

export function formatTradeDateLabel(date: string) {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : format(parsed, 'MMM d, yyyy');
}
