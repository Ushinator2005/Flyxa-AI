import { describe, it, expect } from 'vitest';
import { unionPayoutsById, mergeAccountsPreservingPayouts } from './accountPayouts.js';
import type { Payout } from '../store/types.js';

const p = (id: string, amount = 100, date = '2026-08-20'): Payout => ({ id, amount, date });

describe('unionPayoutsById', () => {
  it('keeps a payout present on either side', () => {
    expect(unionPayoutsById([p('a')], []).map(x => x.id)).toEqual(['a']);
    expect(unionPayoutsById([], [p('b')]).map(x => x.id)).toEqual(['b']);
  });

  it('unions distinct payouts from both sides', () => {
    expect(unionPayoutsById([p('a')], [p('b')]).map(x => x.id).sort()).toEqual(['a', 'b']);
  });

  it('dedupes by id (first occurrence wins)', () => {
    const merged = unionPayoutsById([p('a', 100)], [p('a', 999)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].amount).toBe(100);
  });

  it('dedupes legacy id-less rows by date:amount', () => {
    const legacy = { id: '', amount: 50, date: '2026-08-20' } as Payout;
    expect(unionPayoutsById([legacy], [{ ...legacy }])).toHaveLength(1);
  });

  it('tolerates undefined / null entries', () => {
    expect(unionPayoutsById(undefined, undefined)).toEqual([]);
    expect(unionPayoutsById([null as unknown as Payout, p('a')], [])).toHaveLength(1);
  });
});

describe('mergeAccountsPreservingPayouts', () => {
  const acct = (id: string, payouts: Payout[] = [], extra: Record<string, unknown> = {}) =>
    ({ id, payouts, ...extra });

  it('keeps a base payout that the incoming account omitted (the rehydrate/sync wipe)', () => {
    const base = [acct('acc1', [p('w1')])];
    const incoming = [acct('acc1', [])]; // stale blob with no payouts
    const merged = mergeAccountsPreservingPayouts(base, incoming);
    expect(merged[0].payouts.map(x => x.id)).toEqual(['w1']);
  });

  it('unions payouts logged on different sides', () => {
    const base = [acct('acc1', [p('w1')])];
    const incoming = [acct('acc1', [p('w2')])];
    const merged = mergeAccountsPreservingPayouts(base, incoming);
    expect(merged[0].payouts.map(x => x.id).sort()).toEqual(['w1', 'w2']);
  });

  it('lets incoming win for non-payout fields', () => {
    const base = [acct('acc1', [p('w1')], { name: 'Old' })];
    const incoming = [acct('acc1', [], { name: 'New' })];
    const merged = mergeAccountsPreservingPayouts(base, incoming);
    expect((merged[0] as unknown as { name: string }).name).toBe('New');
    expect(merged[0].payouts.map(x => x.id)).toEqual(['w1']);
  });

  it('passes through an incoming account not present in base', () => {
    const merged = mergeAccountsPreservingPayouts([], [acct('new', [p('w1')])]);
    expect(merged.map(a => a.id)).toEqual(['new']);
    expect(merged[0].payouts.map(x => x.id)).toEqual(['w1']);
  });

  it('leaves the account object untouched when nothing is added', () => {
    const incoming = [acct('acc1', [p('w1')])];
    const merged = mergeAccountsPreservingPayouts([acct('acc1', [p('w1')])], incoming);
    expect(merged[0]).toBe(incoming[0]);
  });
});
