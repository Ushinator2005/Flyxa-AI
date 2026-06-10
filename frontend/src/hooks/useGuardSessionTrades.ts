import { useEffect, useState } from 'react';

export const SESSION_TRADES_STORAGE = 'flyxa.session-trades-v1';

export type GuardTradeDirection = 'long' | 'short';
export type GuardTradeOutcome = 'win' | 'loss' | 'be';

export interface GuardSessionTrade {
  direction: GuardTradeDirection;
  outcome: GuardTradeOutcome;
  amount: number;
}

export interface GuardSessionSummary {
  count: number;
  pnl: number;
  loss: number;
  wins: number;
  losses: number;
  breakevens: number;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeGuardTrade(value: unknown): GuardSessionTrade | null {
  if (!value || typeof value !== 'object') return null;
  const trade = value as Partial<GuardSessionTrade>;
  const direction = String(trade.direction ?? '').toLowerCase();
  const outcome = String(trade.outcome ?? '').toLowerCase();
  const rawAmount = typeof trade.amount === 'number'
    ? trade.amount
    : Number.parseFloat(String(trade.amount ?? '').replace(/[^-\d.]/g, ''));
  const amount = Math.abs(rawAmount);

  if ((direction !== 'long' && direction !== 'short')
    || (outcome !== 'win' && outcome !== 'loss' && outcome !== 'be')
    || !Number.isFinite(amount)) {
    return null;
  }

  return {
    direction,
    outcome,
    amount,
  };
}

export function readGuardSessionTrades(): GuardSessionTrade[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(SESSION_TRADES_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { date?: string; sessionStartedAt?: string | null; trades?: unknown[] };
    if (parsed.date !== todayKey() || !Array.isArray(parsed.trades)) return [];
    return parsed.trades
      .map(normalizeGuardTrade)
      .filter((trade): trade is GuardSessionTrade => trade !== null);
  } catch {
    return [];
  }
}

export function clearStaleGuardSessionTrades(sessionStartedAt?: string | null) {
  if (typeof window === 'undefined' || !sessionStartedAt) return;
  try {
    const raw = window.localStorage.getItem(SESSION_TRADES_STORAGE);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { date?: string; sessionStartedAt?: string | null };
    if (parsed.date !== todayKey() || (parsed.sessionStartedAt && parsed.sessionStartedAt !== sessionStartedAt)) {
      window.localStorage.removeItem(SESSION_TRADES_STORAGE);
      window.dispatchEvent(new CustomEvent('flyxa:session-trades-updated'));
    }
  } catch {
    window.localStorage.removeItem(SESSION_TRADES_STORAGE);
  }
}

export function summarizeGuardSessionTrades(trades: GuardSessionTrade[]): GuardSessionSummary {
  return trades.reduce<GuardSessionSummary>((summary, trade) => {
    const amount = Math.max(0, trade.amount);
    if (trade.outcome === 'win') {
      summary.pnl += amount;
      summary.wins += 1;
    } else if (trade.outcome === 'loss') {
      summary.pnl -= amount;
      summary.loss += amount;
      summary.losses += 1;
    } else {
      summary.breakevens += 1;
    }
    summary.count += 1;
    return summary;
  }, { count: 0, pnl: 0, loss: 0, wins: 0, losses: 0, breakevens: 0 });
}

export function saveGuardSessionTrades(trades: GuardSessionTrade[], sessionStartedAt?: string | null) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SESSION_TRADES_STORAGE, JSON.stringify({ date: todayKey(), sessionStartedAt: sessionStartedAt ?? null, trades }));
  } catch {
    return;
  }
  const message = { type: 'flyxa:session-trades-updated' };
  window.dispatchEvent(new CustomEvent('flyxa:session-trades-updated'));
  try { window.parent?.postMessage(message, '*'); } catch { /* ignore */ }
  try {
    if (window.opener && window.opener !== window) {
      (window.opener as Window).postMessage(message, '*');
    }
  } catch { /* ignore */ }
}

export function useGuardSessionTrades(sessionStartedAt?: string | null): GuardSessionTrade[] {
  const [trades, setTrades] = useState<GuardSessionTrade[]>(() => readGuardSessionTrades());

  useEffect(() => {
    const refresh = () => setTrades(readGuardSessionTrades());
    const storageHandler = (event: StorageEvent) => {
      if (event.key === SESSION_TRADES_STORAGE) refresh();
    };
    const messageHandler = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'flyxa:session-trades-updated') refresh();
    };

    window.addEventListener('storage', storageHandler);
    window.addEventListener('message', messageHandler);
    window.addEventListener('flyxa:session-trades-updated', refresh);
    const poll = window.setInterval(refresh, 1500);
    refresh();

    return () => {
      window.removeEventListener('storage', storageHandler);
      window.removeEventListener('message', messageHandler);
      window.removeEventListener('flyxa:session-trades-updated', refresh);
      window.clearInterval(poll);
    };
  }, [sessionStartedAt]);

  return trades;
}
