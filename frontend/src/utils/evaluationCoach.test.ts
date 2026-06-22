import { describe, expect, it } from 'vitest';
import type { Account, Trade } from '../store/types.js';
import {
  buildEvaluationAgentAlerts,
  computeEvaluationProgress,
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
    expect(progress.drawdownUsed).toBe(200);
    expect(progress.dailyPnl).toBe(200);
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
});
