import { describe, expect, it } from 'vitest';
import type { Trade } from '../types/index.js';
import {
  evaluateTradeViolations,
  generateNextSessionPrescriptions,
  summarizePerformanceOutcome,
} from './performanceLoop.js';

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: crypto.randomUUID(),
    user_id: 'test',
    symbol: 'MNQ',
    direction: 'Long',
    entry_price: 100,
    exit_price: 99,
    sl_price: 99,
    tp_price: 102,
    exit_reason: 'SL',
    pnl: -100,
    commission: 0,
    contract_size: 1,
    point_value: 1,
    trade_date: '2026-06-21',
    trade_time: '09:30',
    trade_length_seconds: 60,
    candle_count: 1,
    timeframe_minutes: 1,
    pre_trade_notes: '',
    post_trade_notes: '',
    session: 'New York',
    created_at: '2026-06-21T09:30:00.000Z',
    ...overrides,
  };
}

describe('performance loop', () => {
  it('detects risk limit, trade count, and contract violations', () => {
    const previous = [trade({ id: 'one', pnl: -150 })];
    const violations = evaluateTradeViolations(
      trade({ id: 'two', pnl: -100, contract_size: 4 }),
      previous,
      { dailyLossLimit: 200, maxTrades: 1, maxContracts: 2 },
    );

    expect(violations.map(item => item.type)).toEqual(expect.arrayContaining([
      'daily_loss_limit',
      'max_trades',
      'max_contracts',
    ]));
  });

  it('detects a revenge trade after a loss', () => {
    const violations = evaluateTradeViolations(
      trade({ emotional_state: 'Revenge Trading' }),
      [trade({ id: 'previous-loss', pnl: -50 })],
      { dailyLossLimit: 500, maxTrades: 5, maxContracts: 2 },
    );

    expect(violations.some(item => item.type === 'revenge_trade')).toBe(true);
  });

  it('prescribes a post-loss pause when post-loss expectancy is negative', () => {
    const prescriptions = generateNextSessionPrescriptions([
      trade({ id: 'a', pnl: -50, trade_time: '09:30' }),
      trade({ id: 'b', pnl: -100, trade_time: '09:40' }),
      trade({ id: 'c', pnl: -25, trade_time: '10:00' }),
      trade({ id: 'd', pnl: -75, trade_time: '10:10' }),
    ], { dailyLossLimit: 500, maxTrades: 4, maxContracts: 2 });

    expect(prescriptions.some(item => item.type === 'post_loss_pause')).toBe(true);
  });

  it('scores the completed session against structured rules', () => {
    const prescriptions = generateNextSessionPrescriptions([], {
      dailyLossLimit: 200,
      maxTrades: 1,
      maxContracts: 1,
    });
    const outcome = summarizePerformanceOutcome([
      trade({ id: 'first', pnl: -150 }),
      trade({ id: 'second', pnl: -100, contract_size: 2, trade_time: '10:00' }),
    ], prescriptions, { dailyLossLimit: 200, maxTrades: 1, maxContracts: 1 });

    expect(outcome.violations.length).toBeGreaterThan(0);
    expect(outcome.adherencePct).toBeLessThan(100);
    expect(outcome.estimatedCost).toBeGreaterThan(0);
  });
});
