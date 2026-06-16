import { Trade } from '../types/index.js';
import { DEFAULT_SESSION_TIMES, getSessionLabelForTime } from './sessionTimes.js';

export function formatCurrency(value: number): string {
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  return value < 0 ? `-${formatted}` : formatted;
}

export function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export function calcWinRate(trades: Trade[]): number {
  if (trades.length === 0) return 0;
  const wins = trades.filter(t => t.exit_reason === 'TP').length;
  return (wins / trades.length) * 100;
}

export function calcProfitFactor(trades: Trade[]): number {
  const wins = trades.filter(t => t.exit_reason === 'TP');
  const losses = trades.filter(t => t.exit_reason === 'SL');
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  if (grossLoss === 0) return grossProfit > 0 ? 999 : 0;
  return grossProfit / grossLoss;
}

export function calcAvgRR(trades: Trade[]): number {
  const values = trades
    .filter(t => t.sl_price && t.tp_price && t.entry_price)
    .map(t => Math.abs(t.tp_price - t.entry_price) / Math.abs(t.sl_price - t.entry_price));
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function calcConsecutive(trades: Trade[]): { wins: number; losses: number } {
  let maxWins = 0, maxLosses = 0, curWins = 0, curLosses = 0;
  for (const t of trades) {
    if (t.exit_reason === 'TP') {
      curWins++;
      curLosses = 0;
      if (curWins > maxWins) maxWins = curWins;
    } else if (t.exit_reason === 'SL') {
      curLosses++;
      curWins = 0;
      if (curLosses > maxLosses) maxLosses = curLosses;
    }
    // BE resets nothing — it breaks neither streak
  }
  return { wins: maxWins, losses: maxLosses };
}

export function calcDrawdown(trades: Trade[]): { maxDrawdown: number; currentDrawdown: number } {
  let peak = 0, cumulative = 0, maxDrawdown = 0;
  for (const t of trades) {
    cumulative += t.pnl;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak > 0 ? ((peak - cumulative) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  const currentDrawdown = peak > 0 ? ((peak - cumulative) / peak) * 100 : 0;
  return { maxDrawdown, currentDrawdown };
}

export function getSession(time: string): string {
  return getSessionLabelForTime(time, DEFAULT_SESSION_TIMES, 'Other');
}

export function formatDuration(seconds: number): string {
  if (!seconds) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
