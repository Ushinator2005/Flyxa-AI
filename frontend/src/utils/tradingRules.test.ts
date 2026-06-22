import { describe, expect, it } from 'vitest';
import type { JournalEntry, Trade } from '../store/types.js';
import { DEFAULT_STRUCTURED_RULES, evaluateEntryRules, evaluateTradeRules } from './tradingRules.js';

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    entryId: 'entry-1',
    date: '2026-06-23',
    symbol: 'MNQ',
    direction: 'LONG',
    entry: 20000,
    sl: 19990,
    tp: 20020,
    exit: 20020,
    contracts: 1,
    rr: 2,
    pnl: 100,
    result: 'win',
    time: '09:45',
    exitTime: '10:00',
    duration: 15,
    screenshots: [],
    scannedImageUrl: null,
    reflection: { thesis: '', execution: '', adjustment: '', processGrade: 0, followedPlan: null },
    account: 'account-1',
    createdAt: '2026-06-23T09:45:00Z',
    ...overrides,
  };
}

describe('trading rule evaluation', () => {
  it('detects measurable trade violations', () => {
    const current = trade({ contracts: 3, rr: 1, time: '12:00' });
    const rules = DEFAULT_STRUCTURED_RULES.map(rule => (
      rule.kind === 'time_window' ? { ...rule, enabled: true } : rule
    ));
    const checks = evaluateTradeRules(current, [current], rules);

    expect(checks.find(check => check.ruleId === 'structured-max-contracts')?.state).toBe('fail');
    expect(checks.find(check => check.ruleId === 'structured-min-rr')?.state).toBe('fail');
    expect(checks.find(check => check.ruleId === 'structured-trading-window')?.state).toBe('fail');
  });

  it('combines automatic checks with manual confirmations', () => {
    const current = trade();
    const entry: JournalEntry = {
      id: 'entry-1',
      date: current.date,
      trades: [current],
      screenshots: [],
      reflection: { pre: '', post: '', lessons: '' },
      rules: [{ text: 'Trade matched my defined setup', state: 'fail' }],
      psychology: { setupQuality: 0, discipline: 0, execution: 0 },
      emotions: [],
      grade: 'C',
      account: 'account-1',
    };
    const checks = evaluateEntryRules(entry, DEFAULT_STRUCTURED_RULES);

    expect(checks.find(check => check.ruleId === 'structured-max-contracts')?.state).toBe('ok');
    expect(checks.find(check => check.ruleId === 'structured-valid-setup')?.state).toBe('fail');
    expect(checks.find(check => check.ruleId === 'structured-valid-setup')?.source).toBe('manual');
  });

  it('does not treat missing data as a pass', () => {
    const current = trade({ time: '' });
    const rules = DEFAULT_STRUCTURED_RULES.map(rule => (
      rule.kind === 'time_window' ? { ...rule, enabled: true } : rule
    ));
    const check = evaluateTradeRules(current, [current], rules)
      .find(item => item.ruleId === 'structured-trading-window');
    expect(check?.state).toBe('unchecked');
  });
});
