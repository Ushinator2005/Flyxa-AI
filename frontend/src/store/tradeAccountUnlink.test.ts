import { describe, it, expect, beforeEach } from 'vitest';
import useFlyxaStore, { DEFAULT_ACCOUNT_ID } from './flyxaStore.js';
import type { JournalEntry } from './types.js';

// Regression: disconnecting an account from a trade used to be undone on the way
// into the store. setEntries fell back to the *stored* account whenever the
// incoming trade carried no `account`/`accountId`, which is exactly the shape a
// disconnect produces — so a trade mis-logged to a Passed account could never be
// unlinked, no matter how many times the user unchecked it.

const LUCID = 'acct-lucid';
const TOPSTEP = 'acct-topstep';

function entryWith(accountIds: string[]): JournalEntry {
  return {
    id: 'entry-1',
    date: '2026-08-27',
    account: accountIds[0],
    accountIds,
    rules: [],
    screenshots: ['', '', ''],
    reflection: { pre: '', post: '', lessons: '' },
    psychology: { setupQuality: 0, discipline: 0, execution: 0 },
    emotions: [],
    grade: '',
    trades: [{
      id: 'trade-1',
      entryId: 'entry-1',
      date: '2026-08-27',
      symbol: 'MNQ',
      direction: 'LONG',
      account: accountIds[0],
      accountIds,
    }],
  } as unknown as JournalEntry;
}

/** What AccountSelectorBlock sends when the user unchecks an account. */
function withTradeAccounts(entry: JournalEntry, nextIds: string[]): JournalEntry {
  return {
    ...entry,
    account: nextIds[0],
    accountIds: nextIds,
    trades: entry.trades.map(trade => ({
      ...trade,
      accountIds: nextIds,
      accountId: nextIds[0],
      account: nextIds[0],
    })),
  } as unknown as JournalEntry;
}

function storedTrade() {
  const entry = useFlyxaStore.getState().entries.find(e => e.date === '2026-08-27');
  return entry?.trades.find(t => t.id === 'trade-1');
}

describe('setEntries — trade account links', () => {
  beforeEach(() => {
    useFlyxaStore.getState().setEntries([entryWith([LUCID, TOPSTEP])], { notifyAchievements: false });
  });

  it('drops an account the user disconnected', () => {
    const [entry] = useFlyxaStore.getState().entries.filter(e => e.date === '2026-08-27');
    useFlyxaStore.getState().setEntries([withTradeAccounts(entry, [TOPSTEP])], { notifyAchievements: false });

    const trade = storedTrade();
    expect(trade?.accountIds).toEqual([TOPSTEP]);
    expect(trade?.account).toBe(TOPSTEP);
    expect(trade?.accountIds).not.toContain(LUCID);
  });

  it('leaves a fully disconnected trade unassigned rather than restoring the old account', () => {
    const [entry] = useFlyxaStore.getState().entries.filter(e => e.date === '2026-08-27');
    useFlyxaStore.getState().setEntries([withTradeAccounts(entry, [])], { notifyAchievements: false });

    const trade = storedTrade();
    expect(trade?.accountIds ?? []).toEqual([]);
    expect(trade?.account).toBe(DEFAULT_ACCOUNT_ID);
  });

  it('still preserves the stored account when a caller omits account fields entirely', () => {
    const [entry] = useFlyxaStore.getState().entries.filter(e => e.date === '2026-08-27');
    const untouched = {
      ...entry,
      trades: entry.trades.map(trade => {
        const { account: _account, accountIds: _accountIds, ...rest } = trade as unknown as Record<string, unknown>;
        return rest;
      }),
    } as unknown as JournalEntry;
    useFlyxaStore.getState().setEntries([untouched], { notifyAchievements: false });

    expect(storedTrade()?.account).toBe(LUCID);
  });
});
