import { describe, expect, it } from 'vitest';
import { computeEntryStats, findBestDay, type JournalEntry, type JournalTrade } from './tradeJournal.js';

// A trade mirrored on two accounts is two real executions, so it is two lots of
// money. Before this, the journal summed each row once while the dashboard
// calendar counted it per account, and the same day read -$1,145 on one page and
// -$2,290 on the other.

function trade(overrides: Partial<JournalTrade> = {}): JournalTrade {
  return {
    id: crypto.randomUUID(),
    symbol: 'NQ',
    direction: 'LONG',
    entryTime: '10:00',
    exitTime: '10:06',
    entryPrice: 0,
    exitPrice: 0,
    contracts: 1,
    rr: 0,
    pnl: 0,
    result: 'loss',
    ...overrides,
  };
}

function entry(trades: JournalTrade[]): JournalEntry {
  return {
    id: 'entry-1',
    date: '2026-09-01',
    trades,
    screenshots: ['', '', ''],
    reflection: { pre: '', post: '', lessons: '' },
    rules: [],
    psychology: { setupQuality: 0, discipline: 0, execution: 0 },
    emotions: [],
  };
}

/** Stands in for AppSettings' resolveTradeAccountIds. */
const byAccountIds = (t: JournalTrade) => t.accountIds ?? [];

describe('computeEntryStats — money vs counts', () => {
  it('counts a mirrored trade once per account in the money', () => {
    const day = entry([
      trade({ pnl: -960, accountIds: ['a', 'b'] }),
      trade({ pnl: -185, accountIds: ['a', 'b'] }),
    ]);
    expect(computeEntryStats(day, [], byAccountIds).pnl).toBe(-2290);
  });

  it('leaves trade counts per row, so every row stays openable', () => {
    const day = entry([
      trade({ pnl: -960, accountIds: ['a', 'b'] }),
      trade({ pnl: -185, accountIds: ['a', 'b'] }),
    ]);
    const stats = computeEntryStats(day, [], byAccountIds);
    expect(stats.tradeCount).toBe(2);
    expect(stats.losses).toBe(2);
    expect(stats.accountCount).toBe(2);
  });

  it('nets commission per account too', () => {
    const day = entry([trade({ pnl: 100, commission: 10, accountIds: ['a', 'b'] })]);
    expect(computeEntryStats(day, [], byAccountIds).pnl).toBe(180);
  });

  it('leaves a single-account day exactly as it was', () => {
    const day = entry([trade({ pnl: -960, accountIds: ['a'] }), trade({ pnl: -185, accountIds: ['a'] })]);
    const stats = computeEntryStats(day, [], byAccountIds);
    expect(stats.pnl).toBe(-1145);
    expect(stats.accountCount).toBe(1);
  });

  it('handles a day where only some trades are mirrored', () => {
    const day = entry([
      trade({ pnl: -1000, accountIds: ['a', 'b'] }),
      trade({ pnl: -100, accountIds: ['a'] }),
    ]);
    expect(computeEntryStats(day, [], byAccountIds).pnl).toBe(-2100);
    expect(computeEntryStats(day, [], byAccountIds).accountCount).toBe(2);
  });

  it('treats a trade with no resolvable account as one lot, never zero', () => {
    const day = entry([trade({ pnl: -500 })]);
    expect(computeEntryStats(day, [], byAccountIds).pnl).toBe(-500);
  });

  it('behaves exactly as before when no resolver is supplied', () => {
    const day = entry([trade({ pnl: -960, accountIds: ['a', 'b'] })]);
    expect(computeEntryStats(day).pnl).toBe(-960);
    expect(computeEntryStats(day).accountCount).toBe(0);
  });
});

describe('findBestDay', () => {
  it('ranks days on the same across-accounts basis the list shows', () => {
    const mirrored = entry([trade({ pnl: 700, result: 'win', accountIds: ['a', 'b'] })]);   // 1400
    const single = entry([trade({ pnl: 1000, result: 'win', accountIds: ['a'] })]);          // 1000
    expect(findBestDay([mirrored, single], byAccountIds)).toBe(1400);
    // Without the resolver the single-account day would look like the better one.
    expect(findBestDay([mirrored, single])).toBe(1000);
  });
});
