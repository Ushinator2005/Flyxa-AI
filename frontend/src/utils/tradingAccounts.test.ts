import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_ID,
  ensureDefaultAccount,
  resolveAutoPassStatus,
  resolveDefaultTradeAccountId,
} from './tradingAccounts.js';
import type { TradingAccount } from '../types/index.js';

function account(overrides: Partial<TradingAccount>): TradingAccount {
  return {
    id: 'account-a',
    name: 'Account A',
    broker: '',
    type: 'Futures',
    status: 'Eval',
    color: '#3b82f6',
    createdAt: '2026-05-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('tradingAccounts', () => {
  it('adds the built-in default profile when no accounts exist', () => {
    const accounts = ensureDefaultAccount([]);
    expect(accounts[0].id).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('uses the oldest non-blown real account as the default trade destination', () => {
    const accounts = ensureDefaultAccount([
      account({ id: 'newer', createdAt: '2026-05-10T00:00:00.000Z', status: 'Live' }),
      account({ id: 'oldest', createdAt: '2026-05-01T00:00:00.000Z', status: 'Eval' }),
    ]);

    expect(resolveDefaultTradeAccountId(accounts)).toBe('oldest');
  });

  it('skips blown accounts when resolving the default trade destination', () => {
    const accounts = ensureDefaultAccount([
      account({ id: 'oldest-blown', createdAt: '2026-05-01T00:00:00.000Z', status: 'Blown' }),
      account({ id: 'next-active', createdAt: '2026-05-02T00:00:00.000Z', status: 'Funded' }),
    ]);

    expect(resolveDefaultTradeAccountId(accounts)).toBe('next-active');
  });

  it('strips legacy credential fields from restored account settings', () => {
    const accounts = ensureDefaultAccount([
      account({ id: 'legacy', credentials: 'secret' } as Partial<TradingAccount> & { credentials: string }),
    ]);

    expect('credentials' in accounts.find(item => item.id === 'legacy')!).toBe(false);
  });

  it('preserves archived account state during normalization', () => {
    const accounts = ensureDefaultAccount([
      account({ id: 'archived-account', status: 'Blown', archived: true }),
    ]);

    expect(accounts.find(item => item.id === 'archived-account')?.archived).toBe(true);
  });
});

describe('resolveAutoPassStatus', () => {
  const target = 53_000;

  it('passes an Eval account once the balance reaches the target', () => {
    expect(resolveAutoPassStatus({ status: 'Eval' }, 53_695, target))
      .toEqual({ status: 'Passed', autoPassed: true });
  });

  it('leaves an Eval account alone below target', () => {
    expect(resolveAutoPassStatus({ status: 'Eval' }, 52_380, target)).toBeNull();
  });

  it('keeps a pass that still holds', () => {
    expect(resolveAutoPassStatus({ status: 'Passed', autoPassed: true }, 53_695, target)).toBeNull();
  });

  // The case that started this: a trade logged to the wrong account pushed the
  // balance over target, and unlinking it pulled the balance back under.
  it('reverts an auto-pass once the balance falls back under target', () => {
    expect(resolveAutoPassStatus({ status: 'Passed', autoPassed: true }, 52_380, target))
      .toEqual({ status: 'Eval', autoPassed: false });
  });

  it('reverts a pass from before the flag existed', () => {
    expect(resolveAutoPassStatus({ status: 'Passed' }, 52_380, target))
      .toEqual({ status: 'Eval', autoPassed: false });
  });

  it('never touches a status the user set by hand', () => {
    expect(resolveAutoPassStatus({ status: 'Passed', autoPassed: false }, 52_380, target)).toBeNull();
  });

  it('does nothing without a balance or a target', () => {
    expect(resolveAutoPassStatus({ status: 'Eval' }, null, target)).toBeNull();
    expect(resolveAutoPassStatus({ status: 'Passed' }, 52_380, null)).toBeNull();
  });

  it('leaves Funded, Live and Blown accounts out of it', () => {
    expect(resolveAutoPassStatus({ status: 'Funded' }, 53_695, target)).toBeNull();
    expect(resolveAutoPassStatus({ status: 'Live' }, 10, target)).toBeNull();
    expect(resolveAutoPassStatus({ status: 'Blown' }, 53_695, target)).toBeNull();
  });
});
