export function pruneEmptyJournalEntries<T extends { trades: unknown[] }>(entries: T[]): T[] {
  return entries.filter(entry => entry.trades.length > 0);
}
