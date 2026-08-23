/**
 * Billing-ledger persistence guards.
 *
 * The billing ledger (`billingAccounts`) kept wiping itself because it was the
 * one important array with NO protection against a blank snapshot:
 *   - the rehydrate merge took `persisted.billingAccounts ?? base` and an empty
 *     array (`[]`) is not nullish, so a stale/empty blob replaced the ledger;
 *   - the cloud write path deliberately skipped billing recovery, so that empty
 *     state then overwrote the cloud copy, making the wipe permanent.
 *
 * These helpers err toward KEEPING billing data. The cost is that clearing the
 * ledger to empty is best-effort (a delete-to-empty can be undone by a stale
 * remote copy); losing the whole ledger repeatedly is far worse than a rare
 * resurrected row. Reliable deletion would need per-row tombstones like trades.
 */

/**
 * Choose which billing ledger to keep when a persisted/rehydrated snapshot meets
 * the in-memory one. Never shrink below what memory already holds: a stale or
 * empty persisted blob must not wipe the ledger.
 */
export function chooseBillingLedger<T extends { id: string }>(base: T[] = [], persisted: T[] = []): T[] {
  const b = Array.isArray(base) ? base : [];
  const p = Array.isArray(persisted) ? persisted : [];
  return p.length >= b.length ? p : b;
}
