import type { Payout } from '../store/types.js';

/**
 * Union two payout lists by identity so a withdrawal present on EITHER side
 * survives. Identity is the payout id, falling back to `date:amount` for legacy
 * rows without an id. First occurrence wins.
 *
 * This is the single guard that keeps a payout from being dropped whenever the
 * accounts slice is replaced wholesale (persist rehydrate merge, the
 * AppSettings -> store sync via hydrateSharedData). Without it, a rehydrate from
 * a stale blob, or a sync that omits payouts, silently wipes a logged payout.
 */
export function unionPayoutsById(a: Payout[] = [], b: Payout[] = []): Payout[] {
  const byId = new Map<string, Payout>();
  for (const p of [...(a ?? []), ...(b ?? [])]) {
    if (!p) continue;
    const key = p.id || `${p.date}:${p.amount}`;
    if (!byId.has(key)) byId.set(key, p);
  }
  return [...byId.values()];
}

/**
 * Merge an incoming accounts array over a base array by id, keeping the incoming
 * account for every field EXCEPT payouts, which become the union of both sides.
 * `incoming` decides which accounts exist; a payout on the base (in-memory) side
 * can never be lost just because `incoming` (a persisted/synced blob) omitted it.
 */
export function mergeAccountsPreservingPayouts<T extends { id: string; payouts?: Payout[] }>(
  base: T[] = [],
  incoming: T[] = [],
): T[] {
  // Runs inside the persist rehydrate merge, so it must never throw on a legacy
  // or malformed stored blob (null rows, missing ids). Pass anything odd through
  // untouched rather than crashing hydration (which would hang the app on load).
  const baseById = new Map<string, T>();
  for (const account of Array.isArray(base) ? base : []) {
    if (account && typeof account.id === 'string') baseById.set(account.id, account);
  }
  return (Array.isArray(incoming) ? incoming : []).map(account => {
    if (!account || typeof account.id !== 'string') return account;
    const prior = baseById.get(account.id);
    if (!prior) return account;
    const merged = unionPayoutsById(prior.payouts, account.payouts);
    return merged.length !== (account.payouts?.length ?? 0) ? { ...account, payouts: merged } : account;
  });
}
