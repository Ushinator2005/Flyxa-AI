import useFlyxaStore from '../store/flyxaStore.js';
import { flushSupabaseStoreNow, readLocalSafeBackupEntries, readLocalBillingSafe } from '../store/supabaseStorage.js';
import type { BillingAccount, JournalEntry } from '../store/types.js';

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
  // A trade is only "missing" if its id exists NOWHERE in the journal.
  // Checking per-day would resurrect trades the user moved to another day
  // (the backup still lists them under the old date).
  const allTradeIds = new Set(journalEntries.flatMap(entry => entry.trades.map(trade => trade.id)));
  const merged = [...journalEntries];

  const currentDates = new Set(journalEntries.map(entry => entry.date));

  for (const safeRaw of safeEntries) {
    const safeEntry = safeRaw as unknown as JournalEntry;
    if (!safeEntry?.id || deletedEntryDates.has(safeEntry.date)) continue;
    const missingTrades = (Array.isArray(safeEntry.trades) ? safeEntry.trades : [])
      .filter(trade => trade?.id && !deletedTradeIds.has(trade.id) && !allTradeIds.has(trade.id));
    if (missingTrades.length === 0) {
      // Intentional blank days ("wanted to trade, took none") count as real
      // content — restore the day itself if it vanished without a tombstone.
      if (safeEntry.isBlankDay && !currentById.has(safeEntry.id) && !currentDates.has(safeEntry.date)) {
        merged.push({ ...safeEntry, trades: [] });
        currentDates.add(safeEntry.date);
        result.daysRecovered++;
      }
      continue;
    }
    const existing = currentById.get(safeEntry.id);

    if (!existing) {
      merged.push({ ...safeEntry, trades: missingTrades });
      result.daysRecovered++;
      result.tradesRecovered += missingTrades.length;
    } else {
      const index = merged.findIndex(entry => entry.id === existing.id);
      if (index !== -1) {
        merged[index] = { ...merged[index], trades: [...merged[index].trades, ...missingTrades] };
        result.tradesRecovered += missingTrades.length;
      }
    }
    missingTrades.forEach(trade => allTradeIds.add(trade.id));
  }

  if (result.tradesRecovered === 0 && result.daysRecovered === 0) return result;

  state.setEntries(merged, { notifyAchievements: false });
  await flushSupabaseStoreNow();
  return result;
}

/**
 * Restores billing accounts from this browser's append-only safe backup when the
 * store is missing them. Additive-only (never removes), so it repairs a wiped or
 * partially-lost ledger without fighting a legitimate edit. Safe to run on load.
 */
export async function recoverMissingBillingFromLocalBackup(userId: string): Promise<number> {
  const safe = readLocalBillingSafe(userId);
  if (safe.length === 0) return 0;

  const state = useFlyxaStore.getState();
  const current = (state.billingAccounts ?? []) as BillingAccount[];
  const haveIds = new Set(current.map(account => account?.id).filter(Boolean));
  const missing = safe.filter(
    (account): account is Record<string, unknown> & { id: string } =>
      !!account && typeof account.id === 'string' && !haveIds.has(account.id)
  );
  if (missing.length === 0) return 0;

  state.hydrateSharedData({ billingAccounts: [...current, ...(missing as unknown as BillingAccount[])] });
  await flushSupabaseStoreNow();
  return missing.length;
}
