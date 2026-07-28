import useFlyxaStore from '../store/flyxaStore.js';
import { flushSupabaseStoreNow, readLocalSafeBackupEntries } from '../store/supabaseStorage.js';
import type { JournalEntry } from '../store/types.js';

export interface RecoveryResult {
  tradesRecovered: number;
  daysRecovered: number;
}

/**
 * Merges trades from this browser's local safe backup into the store when they
 * are missing from cloud data. Tombstone-aware: trades and days the user
 * deleted are never resurrected. Safe to run automatically after hydration —
 * it only ever adds entries/trades the store does not have.
 */
export async function recoverMissingTradesFromLocalBackup(userId: string): Promise<RecoveryResult> {
  const result: RecoveryResult = { tradesRecovered: 0, daysRecovered: 0 };
  const safeEntries = readLocalSafeBackupEntries(userId);
  if (safeEntries.length === 0) return result;

  const state = useFlyxaStore.getState();
  const journalEntries = state.entries as JournalEntry[];
  const deletedTradeIds = new Set(state.deletedTradeIds ?? []);
  const deletedEntryDates = new Set(state.deletedEntryDates ?? []);

  const currentById = new Map(journalEntries.map(entry => [entry.id, entry]));
  const merged = [...journalEntries];

  for (const safeRaw of safeEntries) {
    const safeEntry = safeRaw as unknown as JournalEntry;
    if (!safeEntry?.id || deletedEntryDates.has(safeEntry.date)) continue;
    const safeTrades = (Array.isArray(safeEntry.trades) ? safeEntry.trades : [])
      .filter(trade => trade?.id && !deletedTradeIds.has(trade.id));
    const existing = currentById.get(safeEntry.id);

    if (!existing) {
      if (safeTrades.length === 0) continue;
      merged.push({ ...safeEntry, trades: safeTrades });
      result.daysRecovered++;
      result.tradesRecovered += safeTrades.length;
    } else {
      const existingTradeIds = new Set(existing.trades.map(trade => trade.id));
      const newTrades = safeTrades.filter(trade => !existingTradeIds.has(trade.id));
      if (newTrades.length > 0) {
        const index = merged.findIndex(entry => entry.id === existing.id);
        if (index !== -1) {
          merged[index] = { ...merged[index], trades: [...merged[index].trades, ...newTrades] };
          result.tradesRecovered += newTrades.length;
        }
      }
    }
  }

  if (result.tradesRecovered === 0 && result.daysRecovered === 0) return result;

  state.setEntries(merged, { notifyAchievements: false });
  await flushSupabaseStoreNow();
  return result;
}
