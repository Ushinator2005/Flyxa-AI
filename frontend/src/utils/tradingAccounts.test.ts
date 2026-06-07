import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_ID,
  ensureDefaultAccount,
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
