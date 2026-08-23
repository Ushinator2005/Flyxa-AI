import { describe, it, expect } from 'vitest';
import { chooseBillingLedger } from './billingPersistence.js';

const a = (id: string) => ({ id });

describe('chooseBillingLedger', () => {
  it('keeps the in-memory ledger when the persisted blob is empty (the wipe)', () => {
    const base = [a('1'), a('2'), a('3')];
    expect(chooseBillingLedger(base, []).map(x => x.id)).toEqual(['1', '2', '3']);
  });

  it('loads the persisted ledger on a cold start (base empty)', () => {
    const persisted = [a('1'), a('2')];
    expect(chooseBillingLedger([], persisted).map(x => x.id)).toEqual(['1', '2']);
  });

  it('prefers the persisted ledger when it has at least as many rows', () => {
    const base = [a('1')];
    const persisted = [a('1'), a('2')];
    expect(chooseBillingLedger(base, persisted).map(x => x.id)).toEqual(['1', '2']);
  });

  it('never shrinks below memory when persisted has fewer rows', () => {
    const base = [a('1'), a('2'), a('3')];
    const persisted = [a('1')];
    expect(chooseBillingLedger(base, persisted).map(x => x.id)).toEqual(['1', '2', '3']);
  });

  it('handles undefined / non-array inputs without throwing', () => {
    expect(chooseBillingLedger(undefined, undefined)).toEqual([]);
    expect(chooseBillingLedger(undefined, [a('1')]).map(x => x.id)).toEqual(['1']);
    expect(chooseBillingLedger([a('1')], undefined).map(x => x.id)).toEqual(['1']);
  });
});
