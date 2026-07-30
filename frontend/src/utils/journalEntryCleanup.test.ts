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

  it('keeps a no-trade day that has a scannedImageUrl attached', () => {
    const entries = [
      { id: 'june-9', date: '2026-06-09', trades: [], emotions: [], rules: [], scannedImageUrl: 'https://example.com/image.png' },
    ];

    expect(pruneEmptyJournalEntries(entries)).toHaveLength(1);
  });

  it('keeps a no-trade day that has a pre-session in preSessionHistory', () => {
    const entries = [
      { id: 'june-9', date: '2026-06-09', trades: [], emotions: [], rules: [] },
    ];
    const preSessionHistory = { '2026-06-09': { postSessionNote: 'Stayed disciplined today', commitment: {} } };

    expect(pruneEmptyJournalEntries(entries, preSessionHistory)).toHaveLength(1);
  });

  it('removes a no-trade day with no content and no pre-session', () => {
    const entries = [
      { id: 'june-9', date: '2026-06-09', trades: [], emotions: [], rules: [] },
    ];
    const preSessionHistory = { '2026-06-10': { postSessionNote: 'different day' } };

    expect(pruneEmptyJournalEntries(entries, preSessionHistory)).toHaveLength(0);
  });
});

describe('blank trading days', () => {
  it('keeps an explicit blank day — it signifies intent to trade with no trades taken', () => {
    const entries = [
      { id: 'blank-day', date: '2026-07-20', trades: [], emotions: [], rules: [], isBlankDay: true },
      { id: 'empty-shell', date: '2026-07-19', trades: [], emotions: [], rules: [] },
    ];

    expect(pruneEmptyJournalEntries(entries)).toEqual([
      { id: 'blank-day', date: '2026-07-20', trades: [], emotions: [], rules: [], isBlankDay: true },
    ]);
  });

  it('keeps a blank day even after all its trades were moved elsewhere', () => {
    const entries = [
      { id: 'was-blank', date: '2026-07-21', trades: [], emotions: [], rules: [], isBlankDay: true },
    ];

    expect(pruneEmptyJournalEntries(entries)).toHaveLength(1);
  });
});
