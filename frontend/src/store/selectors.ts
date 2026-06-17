import { useMemo } from 'react';
import useFlyxaStore from './flyxaStore.js';
import { computeAchievementProgress, computeJournalStreak } from './achievements.js';
import type { Achievement, JournalEntry, Trade } from './types.js';

function withoutDeletedTrades(entries: JournalEntry[], deletedTradeIds: string[]): JournalEntry[] {
  if (deletedTradeIds.length === 0) return entries;
  const deleted = new Set(deletedTradeIds);
  return entries.map((entry) => ({
    ...entry,
    trades: entry.trades.filter((trade) => !deleted.has(trade.id)),
  }));
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfToday(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

export const useActiveAccountEntries = (): JournalEntry[] => {
  const entries = useFlyxaStore((state) => state.entries);
  const activeAccountId = useFlyxaStore((state) => state.activeAccountId);
  const deletedTradeIds = useFlyxaStore((state) => state.deletedTradeIds);
  return useMemo(() => {
    const visibleEntries = withoutDeletedTrades(entries, deletedTradeIds);
    if (!activeAccountId) return visibleEntries;
    return visibleEntries.filter((entry) => entry.account === activeAccountId);
  }, [activeAccountId, deletedTradeIds, entries]);
};

export const useAllTrades = (): Trade[] => {
  const entries = useActiveAccountEntries();
  return useMemo(() => entries.flatMap((entry) => entry.trades), [entries]);
};

export const useTradesInRange = (from: Date, to: Date): Trade[] => {
  const trades = useAllTrades();
  return useMemo(() => trades.filter((trade) => {
    const d = new Date(`${trade.date}T00:00:00`);
    return d >= from && d <= to;
  }), [from, to, trades]);
};

export const useDashboardStats = () => {
  const trades = useAllTrades();
  return useMemo(() => {
    const wins = trades.filter((trade) => trade.result === 'win');
    const losses = trades.filter((trade) => trade.result === 'loss');
    const today = todayISO();
    const todayTrades = trades.filter((trade) => trade.date === today);

    return {
      netPnL: trades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0),
      winRate: trades.length ? (wins.length / Math.max(1, wins.length + losses.length)) * 100 : 0,
      avgRR: trades.length ? trades.reduce((sum, trade) => sum + trade.rr, 0) / trades.length : 0,
      totalTrades: trades.length,
      todayTrades,
      todayPnL: todayTrades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0),
    };
  }, [trades]);
};

export const useMonthlyPnLByDay = (year: number, month: number) => {
  const entries = useActiveAccountEntries();
  return useMemo(() => entries
    .filter((entry) => {
      const d = new Date(`${entry.date}T00:00:00`);
      return d.getFullYear() === year && d.getMonth() === month;
    })
    .map((entry) => ({
      date: entry.date,
      pnl: entry.trades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0),
      trades: entry.trades.length,
      grade: entry.grade,
    })), [entries, month, year]);
};

export const useEquityCurve = () => {
  const entries = useActiveAccountEntries();
  const account = useFlyxaStore((state) => state.accounts.find((item) => item.id === state.activeAccountId) ?? state.accounts[0]);
  return useMemo(() => {
    let running = account?.startingBalance ?? 0;
    return [...entries]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((entry) => {
        const dayPnL = entry.trades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0);
        running += dayPnL;
        return { date: entry.date, equity: running, pnl: dayPnL };
      });
  }, [account?.startingBalance, entries]);
};

export const useSetupPerformance = () => {
  const trades = useAllTrades();
  return useMemo(() => {
    const bySymbol: Record<string, Trade[]> = {};
    trades.forEach((trade) => {
      if (!bySymbol[trade.symbol]) bySymbol[trade.symbol] = [];
      bySymbol[trade.symbol].push(trade);
    });

    return Object.entries(bySymbol).map(([symbol, symbolTrades]) => ({
      symbol,
      trades: symbolTrades.length,
      winRate: (symbolTrades.filter((trade) => trade.result === 'win').length / Math.max(1, symbolTrades.length)) * 100,
      avgRR: symbolTrades.reduce((sum, trade) => sum + trade.rr, 0) / Math.max(1, symbolTrades.length),
      totalPnL: symbolTrades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0),
    }));
  }, [trades]);
};

export const usePerformanceByHour = () => {
  const trades = useAllTrades();
  return useMemo(() => {
    const byHour: Record<number, Trade[]> = {};
    trades.forEach((trade) => {
      const [hourToken] = trade.time.split(':');
      const hour = Number.parseInt(hourToken, 10);
      if (!Number.isFinite(hour)) return;
      if (!byHour[hour]) byHour[hour] = [];
      byHour[hour].push(trade);
    });

    return Object.entries(byHour).map(([hour, hourTrades]) => ({
      hour: Number.parseInt(hour, 10),
      trades: hourTrades.length,
      winRate: (hourTrades.filter((trade) => trade.result === 'win').length / Math.max(1, hourTrades.length)) * 100,
      avgPnL: hourTrades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0) / Math.max(1, hourTrades.length),
    }));
  }, [trades]);
};

export const usePsychologyCorrelation = () => {
  const entries = useActiveAccountEntries();
  return useMemo(() => entries.map((entry) => ({
    date: entry.date,
    discipline: entry.psychology.discipline,
    setupQuality: entry.psychology.setupQuality,
    execution: entry.psychology.execution,
    pnl: entry.trades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0),
    winRate: entry.trades.length
      ? (entry.trades.filter((trade) => trade.result === 'win').length / entry.trades.length) * 100
      : 0,
  })), [entries]);
};

export const useDailyLossUsed = () => {
  const account = useFlyxaStore((state) => state.accounts.find((item) => item.id === state.activeAccountId) ?? state.accounts[0]);
  const todayTrades = useTradesInRange(startOfToday(), endOfToday());

  return useMemo(() => {
    const todayPnL = todayTrades.reduce((sum, trade) => sum + trade.pnl - (trade.commission ?? 0), 0);
    const used = Math.min(0, todayPnL);
    const limit = account?.dailyLossLimit ?? 0;
    return {
      used,
      limit,
      remaining: limit + used,
      pct: (Math.abs(used) / Math.max(1, limit)) * 100,
    };
  }, [account?.dailyLossLimit, todayTrades]);
};

export const useAchievementsWithProgress = (): Achievement[] => {
  const achievements = useFlyxaStore((state) => state.achievements);
  const billingAccounts = useFlyxaStore((state) => state.billingAccounts);
  const trades = useAllTrades();
  const entries = useActiveAccountEntries();

  return useMemo(() => achievements.map((achievement) => (
    computeAchievementProgress(achievement, trades, entries, billingAccounts)
  )), [achievements, billingAccounts, entries, trades]);
};

export const useJournalStreak = (): number => {
  const entries = useActiveAccountEntries();
  return useMemo(() => computeJournalStreak(entries), [entries]);
};
