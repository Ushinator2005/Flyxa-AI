import type { Trade } from '../types/index.js';

export interface DailyFlowInsight {
  date: string;
  tradeCount: number;
  netPnl: number;
  biggestLeak: {
    id: string;
    label: string;
    cost: number;
    count: number;
  } | null;
  bestState: {
    label: string;
    avgPnl: number;
    count: number;
  } | null;
  worstState: {
    label: string;
    avgPnl: number;
    count: number;
  } | null;
  tomorrowRule: string;
  summary: string;
}

function formatMoney(value: number) {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function tradeDate(trade: Trade): string {
  return trade.trade_date || trade.created_at?.slice(0, 10) || '';
}

function tradeTime(trade: Trade): string {
  return trade.trade_time || '00:00';
}

function flagsOf(trade: Trade): string[] {
  return Array.isArray(trade.behavioral_flags) ? trade.behavioral_flags : [];
}

function isRevengeTrade(trade: Trade) {
  const emotion = String(trade.emotional_state ?? '').toLowerCase();
  return emotion.includes('revenge') || flagsOf(trade).some(flag => flag.toLowerCase().includes('revenge'));
}

function isOffPlanTrade(trade: Trade) {
  return trade.followed_plan === false || flagsOf(trade).includes('plan-deviation');
}

function sortedDayTrades(trades: Trade[], date: string) {
  return trades
    .filter(trade => tradeDate(trade) === date)
    .sort((a, b) => tradeTime(a).localeCompare(tradeTime(b)));
}

function sumNegativeCost(trades: Trade[]) {
  return trades.reduce((sum, trade) => sum + Math.min(0, Number(trade.pnl ?? 0)), 0);
}

function tradeCost(trades: Trade[]) {
  const cost = sumNegativeCost(trades);
  return cost < 0 ? cost : trades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
}

function postTwoLossTrades(dayTrades: Trade[]) {
  let losses = 0;
  const flagged: Trade[] = [];

  dayTrades.forEach(trade => {
    if (losses >= 2) flagged.push(trade);
    const pnl = Number(trade.pnl ?? 0);
    if (pnl < 0) losses += 1;
    else if (pnl > 0) losses = 0;
  });

  return flagged;
}

function stateStats(dayTrades: Trade[]) {
  const groups = new Map<string, Trade[]>();
  dayTrades.forEach(trade => {
    const state = String(trade.emotional_state ?? '').trim();
    if (!state) return;
    groups.set(state, [...(groups.get(state) ?? []), trade]);
  });

  const rows = Array.from(groups.entries()).map(([label, rows]) => {
    const total = rows.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
    return {
      label,
      count: rows.length,
      avgPnl: rows.length ? total / rows.length : 0,
    };
  });

  return {
    best: rows.length ? [...rows].sort((a, b) => b.avgPnl - a.avgPnl)[0] : null,
    worst: rows.length ? [...rows].sort((a, b) => a.avgPnl - b.avgPnl)[0] : null,
  };
}

export function buildDailyFlowInsight(trades: Trade[], date: string): DailyFlowInsight {
  const dayTrades = sortedDayTrades(trades, date);
  const netPnl = dayTrades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);

  const leakCandidates = [
    {
      id: 'overtrading',
      label: 'Third+ trades',
      rows: dayTrades.slice(2),
      rule: 'Max 2 trades. A third trade requires full checklist confirmation and half risk.',
    },
    {
      id: 'revenge',
      label: 'Revenge trades',
      rows: dayTrades.filter(isRevengeTrade),
      rule: 'After any frustration spike or loss, wait 15 minutes before the next order.',
    },
    {
      id: 'off-plan',
      label: 'Off-plan trades',
      rows: dayTrades.filter(isOffPlanTrade),
      rule: 'No off-plan trades. Every entry must match the written plan before execution.',
    },
    {
      id: 'post-two-losses',
      label: 'Trades after 2 losses',
      rows: postTwoLossTrades(dayTrades),
      rule: 'Stop after 2 losses. The next trade is blocked unless it is reviewed first.',
    },
  ].map(candidate => {
    const cost = tradeCost(candidate.rows);
    return {
      ...candidate,
      cost,
      count: candidate.rows.length,
    };
  }).filter(candidate => candidate.count > 0);

  const biggest = leakCandidates
    .filter(candidate => candidate.cost < 0)
    .sort((a, b) => a.cost - b.cost)[0] ?? null;

  const { best, worst } = stateStats(dayTrades);

  const fallbackRule = netPnl < 0
    ? 'Trade smaller and slower. First priority is avoiding yesterday’s leak.'
    : 'Repeat the process, not the P&L. Keep risk fixed and log every decision.';

  const tomorrowRule = biggest?.rule ?? fallbackRule;
  const summary = biggest
    ? `${biggest.label} cost ${formatMoney(biggest.cost)} across ${biggest.count} trade${biggest.count !== 1 ? 's' : ''}.`
    : dayTrades.length > 0
      ? `No major behavioral leak detected. Net session: ${formatMoney(netPnl)}.`
      : 'No trades logged, so tomorrow starts from the standard plan.';

  return {
    date,
    tradeCount: dayTrades.length,
    netPnl,
    biggestLeak: biggest ? {
      id: biggest.id,
      label: biggest.label,
      cost: biggest.cost,
      count: biggest.count,
    } : null,
    bestState: best,
    worstState: worst,
    tomorrowRule,
    summary,
  };
}

export function getMostRecentDailyFlowBefore(trades: Trade[], beforeDate: string): DailyFlowInsight | null {
  const dates = Array.from(new Set(trades.map(tradeDate).filter(Boolean)))
    .filter(date => date < beforeDate)
    .sort((a, b) => b.localeCompare(a));

  const lastDate = dates[0];
  return lastDate ? buildDailyFlowInsight(trades, lastDate) : null;
}
