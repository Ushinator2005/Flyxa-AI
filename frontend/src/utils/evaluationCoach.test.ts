import { describe, expect, it } from 'vitest';
import type { Account, Trade } from '../store/types.js';
import {
  buildEvaluationAgentAlerts,
  computeEvaluationProgress,
  computeMllSeries,
  getEvaluationTemplates,
  inferEvaluationTemplate,
  tradesForAccount,
} from './evaluationCoach.js';

const account: Account = {
  id: 'eval-1',
  name: 'Evaluation 1',
  firm: 'Custom',
  size: 50_000,
  type: 'eval',
  phase: 'eval',
  balance: 50_000,
  startingBalance: 50_000,
  dailyLossLimit: 1_000,
  maxDrawdown: 2_000,
  profitTarget: 3_000,
  minimumTradingDays: 2,
  maxContracts: 5,
  isActive: true,
};

function trade(id: string, date: string, time: string, pnl: number, accountId = account.id): Trade {
  return {
    id,
    entryId: `entry-${date}`,
    date,
    symbol: 'MNQ',
    direction: 'LONG',
    entry: 100,
    sl: 90,
    tp: 120,
    exit: 110,
    contracts: 1,
    rr: 1,
    pnl,
    result: pnl > 0 ? 'win' : 'loss',
    time,
    exitTime: null,
    duration: null,
    screenshots: [],
    scannedImageUrl: null,
    reflection: {
      thesis: '',
      execution: '',
      adjustment: '',
      processGrade: 0,
      followedPlan: true,
    },
    account: accountId,
    accountIds: [accountId],
    createdAt: `${date}T${time}:00`,
  };
}

describe('evaluation coach', () => {
  it('matches the exact Topstep size and product path', () => {
    const topstepAccount: Account = {
      ...account,
      firm: 'Topstep',
      name: 'Topstep 50K no activation',
      size: 50_000,
      evaluationPath: 'no_activation_fee',
    };
    const template = inferEvaluationTemplate(topstepAccount);
    expect(template.id).toBe('topstep-trading-combine-50000-no-activation-fee-v1');
    expect(template.profitTarget).toBe(3000);
    expect(template.maxDrawdown).toBe(2000);
    expect(template.activationFee).toBe(0);
    expect(template.minimumTradingDays).toBe(2);
    expect(template.responsibleTradingDiscount).toBe(10);
    expect(template.responsibleTradingBenefit).toContain('Double payout caps');
    expect(template.drawdownType).toBe('eod_trailing');
    expect(template.trailingStopsAt).toBe(50_000);
  });

  it('publishes six verified Topstep path and size combinations', () => {
    const topstep = getEvaluationTemplates().filter(template => template.firm === 'Topstep');
    expect(topstep).toHaveLength(6);
    expect(topstep.every(template => template.status === 'verified')).toBe(true);
  });

  it('keeps account trade attribution isolated', () => {
    const trades = [
      trade('mine', '2026-06-20', '09:00', 500),
      trade('other', '2026-06-20', '10:00', 900, 'other-account'),
    ];
    expect(tradesForAccount(trades, account.id).map(item => item.id)).toEqual(['mine']);
  });

  it('tracks target, drawdown and trading-day progress', () => {
    const progress = computeEvaluationProgress(account, [
      trade('one', '2026-06-20', '09:00', 800),
      trade('two', '2026-06-21', '09:00', -200),
      trade('three', '2026-06-21', '10:00', 400),
    ], new Date('2026-06-21T12:00:00'));

    expect(progress.netPnl).toBe(1000);
    expect(progress.targetRemaining).toBe(2000);
    expect(progress.tradingDays).toBe(2);
    expect(progress.drawdownFloor).toBe(48000);
    expect(progress.drawdownUsed).toBe(0);
    expect(progress.dailyPnl).toBe(200);
  });

  it('uses the active MLL floor for drawdown buffer instead of peak-to-trough movement', () => {
    const topstepAccount: Account = {
      ...account,
      firm: 'Topstep',
      name: 'Topstep 50K',
      size: 50_000,
      startingBalance: 50_000,
      maxDrawdown: 2_000,
      drawdownType: 'trailing',
    };
    const progress = computeEvaluationProgress(topstepAccount, [
      trade('loss', '2026-06-23', '09:30', -170, topstepAccount.id),
    ], new Date('2026-06-23T12:00:00'));

    expect(progress.currentBalance).toBe(49830);
    expect(progress.drawdownFloor).toBe(48000);
    expect(progress.drawdownRemaining).toBe(1830);
    expect(progress.drawdownUsed).toBe(170);
  });

  it('raises an intraday-trailing MLL from every closed-trade high, but an EOD MLL only from settled closes', () => {
    const trades = [
      trade('spike', '2026-06-20', '09:00', 1_000),
      trade('giveback', '2026-06-20', '10:00', -800),
    ];
    const now = new Date('2026-06-22T12:00:00');

    const intraday = computeEvaluationProgress({ ...account, drawdownType: 'intraday_trailing' }, trades, now);
    expect(intraday.drawdownFloor).toBe(49_000); // peak 51,000 − 2,000
    expect(intraday.drawdownType).toBe('intraday_trailing');

    const eod = computeEvaluationProgress({ ...account, drawdownType: 'eod_trailing' }, trades, now);
    expect(eod.drawdownFloor).toBe(48_200); // day settled at 50,200 − 2,000
  });

  it('does not let the unsettled current day raise an EOD-trailing MLL', () => {
    const progress = computeEvaluationProgress({ ...account, drawdownType: 'eod_trailing' }, [
      trade('big-day', '2026-06-20', '09:00', 1_500),
    ], new Date('2026-06-20T12:00:00'));
    expect(progress.drawdownFloor).toBe(48_000);
  });

  it('locks the MLL once it reaches trailingStopsAt', () => {
    const progress = computeEvaluationProgress(
      { ...account, drawdownType: 'intraday_trailing', trailingStopsAt: 50_000 },
      [trade('runner', '2026-06-20', '09:00', 2_600)],
      new Date('2026-06-22T12:00:00'),
    );
    expect(progress.drawdownFloor).toBe(50_000); // raw 50,600 capped at the lock
    expect(progress.floorLocked).toBe(true);
    expect(progress.drawdownRemaining).toBe(2_600);
  });

  it('treats the legacy trailing value as intraday trailing', () => {
    const progress = computeEvaluationProgress({ ...account, drawdownType: 'trailing' }, [
      trade('up', '2026-06-20', '09:00', 500),
    ], new Date('2026-06-22T12:00:00'));
    expect(progress.drawdownType).toBe('intraday_trailing');
    expect(progress.drawdownFloor).toBe(48_500);
  });

  it('blocks the pass while the consistency rule is not met', () => {
    const consistencyAccount: Account = { ...account, consistencyLimitPct: 50 };
    const progress = computeEvaluationProgress(consistencyAccount, [
      trade('big', '2026-06-20', '09:00', 2_900),
      trade('small', '2026-06-21', '09:00', 200),
    ], new Date('2026-06-21T12:00:00'));
    expect(progress.netPnl).toBe(3_100); // profit target reached...
    expect(progress.consistencyPct).toBe(94); // ...but one day is 94% of it
    expect(progress.status).not.toBe('passed');
    expect(progress.warnings.some(warning => warning.includes('Consistency'))).toBe(true);
  });

  it('carries the officially verified Take Profit Trader drawdowns', () => {
    const templates = getEvaluationTemplates();
    expect(templates.find(t => t.id === 'tpt-75k')?.maxDrawdown).toBe(2_500);
    expect(templates.find(t => t.id === 'tpt-100k')?.maxDrawdown).toBe(3_000);
    expect(templates.find(t => t.id === 'tpt-100k')?.trailingStopsAt).toBe(100_000);
  });

  it('builds an MLL series aligned to trading days for the equity chart', () => {
    const series = computeMllSeries({ ...account, drawdownType: 'eod_trailing' }, [
      trade('d1', '2026-06-20', '09:00', 1_000),
      trade('d2', '2026-06-21', '09:00', -500),
    ], new Date('2026-06-22T12:00:00'));
    expect(series).toEqual([48_000, 49_000, 49_000]);
  });

  it('creates a post-loss process warning from repeated immediate re-entry', () => {
    const trades = [
      trade('loss-1', '2026-06-20', '09:00', -300),
      trade('next-1', '2026-06-20', '09:05', -200),
      trade('loss-2', '2026-06-21', '09:00', -250),
      trade('next-2', '2026-06-21', '09:10', -150),
    ];
    const progress = computeEvaluationProgress(account, trades, new Date('2026-06-21T12:00:00'));
    const alerts = buildEvaluationAgentAlerts(account, trades, progress);
    expect(alerts.some(alert => alert.id === 'post-loss-cost')).toBe(true);
  });

  it('measures the post-loss re-entry gap from the previous trade exit, not its entry', () => {
    // Losses held for 90 minutes, re-entered 5 minutes after closing: an
    // entry-to-entry gap (95m) looks patient; the real wait was 5 minutes.
    const trades = [
      { ...trade('loss-1', '2026-06-20', '09:00', -300), exitTime: '10:30' },
      trade('next-1', '2026-06-20', '10:35', -200),
      { ...trade('loss-2', '2026-06-21', '09:00', -250), exitTime: '10:30' },
      trade('next-2', '2026-06-21', '10:35', -150),
    ];
    const progress = computeEvaluationProgress(account, trades, new Date('2026-06-21T12:00:00'));
    const alerts = buildEvaluationAgentAlerts(account, trades, progress);
    expect(alerts.some(alert => alert.id === 'post-loss-cost')).toBe(true);
  });
});
