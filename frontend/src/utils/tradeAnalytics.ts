import { AnalyticsSummary, Trade } from '../types/index.js';

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
  // Real breakevens closed at a price; zero-P&L rows without an exit are open
  // trades or skeleton records and must not dilute the win rate denominator.
  const breakevens = sortedTrades.filter(trade => ep(trade) === 0 && (trade.exit_price ?? 0) > 0);
  const decidedCount = wins.length + losses.length + breakevens.length;
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
    winRate: decidedCount > 0 ? (wins.length / decidedCount) * 100 : 0,
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
    // Skip skeleton records — trades where entry_price, exit_price, AND pnl all defaulted
    // to 0 because the source row had null values. Real breakeven trades always have a
    // non-zero entry/exit price (they closed at the same level, not at zero).
    if (grossPnl === 0 && trade.entry_price === 0 && trade.exit_price === 0) return;
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

