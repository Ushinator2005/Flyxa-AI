import { describe, expect, it } from 'vitest';
import { pruneEmptyJournalEntries } from './journalEntryCleanup.js';

describe('pruneEmptyJournalEntries', () => {
  it('removes an orphan day after its final trade moves elsewhere', () => {
    const entries = [
      { id: 'june-24', date: '2026-06-24', trades: [], emotions: [], rules: [] },
      { id: 'june-23', date: '2026-06-23', trades: [{ id: 'trade-1' }], emotions: [], rules: [] },
    ];

    expect(pruneEmptyJournalEntries(entries)).toEqual([
      { id: 'june-23', date: '2026-06-23', trades: [{ id: 'trade-1' }], emotions: [], rules: [] },
    ]);
  });

  it('keeps every day that still contains a trade', () => {
    const entries = [
      { id: 'june-24', trades: [{ id: 'trade-2' }], emotions: [], rules: [] },
      { id: 'june-23', trades: [{ id: 'trade-1' }], emotions: [], rules: [] },
    ];

    expect(pruneEmptyJournalEntries(entries)).toHaveLength(2);
  });

  it('keeps a no-trade day that has pre-session text', () => {
    const entries = [
      { id: 'june-24', date: '2026-06-24', trades: [], emotions: [], rules: [], dailyReflection: { pre: 'Watching but not trading', post: '', lessons: '' } },
    ];

    expect(pruneEmptyJournalEntries(entries)).toHaveLength(1);
  });

  it('keeps a no-trade day that has post-session text', () => {
    const entries = [
      { id: 'june-24', date: '2026-06-24', trades: [], emotions: [], rules: [], dailyReflection: { pre: '', post: 'Market was choppy, good call sitting out', lessons: '' } },
    ];

    expect(pruneEmptyJournalEntries(entries)).toHaveLength(1);
  });

  it('removes a no-trade day with no content at all', () => {
    const entries = [
      { id: 'june-24', date: '2026-06-24', trades: [], emotions: [], rules: [], dailyReflection: { pre: '', post: '', lessons: '' } },
      { id: 'june-23', date: '2026-06-23', trades: [{ id: 't1' }], emotions: [], rules: [] },
    ];

    expect(pruneEmptyJournalEntries(entries)).toHaveLength(1);
  });
});
