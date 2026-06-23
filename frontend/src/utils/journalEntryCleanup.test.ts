import { describe, expect, it } from 'vitest';
import { pruneEmptyJournalEntries } from './journalEntryCleanup.js';

describe('pruneEmptyJournalEntries', () => {
  it('removes an orphan day after its final trade moves elsewhere', () => {
    const entries = [
      { id: 'june-24', date: '2026-06-24', trades: [] },
      { id: 'june-23', date: '2026-06-23', trades: [{ id: 'trade-1' }] },
    ];

    expect(pruneEmptyJournalEntries(entries)).toEqual([
      { id: 'june-23', date: '2026-06-23', trades: [{ id: 'trade-1' }] },
    ]);
  });

  it('keeps every day that still contains a trade', () => {
    const entries = [
      { id: 'june-24', trades: [{ id: 'trade-2' }] },
      { id: 'june-23', trades: [{ id: 'trade-1' }] },
    ];

    expect(pruneEmptyJournalEntries(entries)).toHaveLength(2);
  });
});
