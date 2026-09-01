import { describe, expect, it } from 'vitest';
import { buildMonthlyFlow, type MonthlyFlowEntry } from './billingMonthlyFlow.js';

function entry(overrides: Partial<MonthlyFlowEntry> = {}): MonthlyFlowEntry {
  return {
    actualPrice: 0,
    purchaseDate: '2026-08-10',
    payoutReceived: 0,
    ...overrides,
  };
}

describe('buildMonthlyFlow', () => {
  it('returns nothing when there is no activity', () => {
    expect(buildMonthlyFlow([])).toEqual([]);
  });

  it('buckets spend by the month the account was purchased', () => {
    const flow = buildMonthlyFlow([
      entry({ actualPrice: 94, purchaseDate: '2026-08-20' }),
      entry({ actualPrice: 94, purchaseDate: '2026-08-25' }),
      entry({ actualPrice: 150, purchaseDate: '2026-09-01' }),
    ]);
    expect(flow.map(m => [m.key, m.spent])).toEqual([
      ['2026-08', 188],
      ['2026-09', 150],
    ]);
  });

  it('buckets payouts by their own date, not the purchase date', () => {
    const flow = buildMonthlyFlow([
      entry({
        actualPrice: 100,
        purchaseDate: '2026-07-02',
        payoutReceived: 1_270,
        payouts: [{ amount: 1_270, date: '2026-09-14' }],
      }),
    ]);
    expect(flow.find(m => m.key === '2026-07')).toMatchObject({ spent: 100, payouts: 0 });
    expect(flow.find(m => m.key === '2026-09')).toMatchObject({ spent: 0, payouts: 1_270 });
  });

  it('splits a multi-payout account across the months it was paid', () => {
    const flow = buildMonthlyFlow([
      entry({
        purchaseDate: '2026-08-01',
        payoutReceived: 2_070,
        payouts: [
          { amount: 1_270, date: '2026-08-23' },
          { amount: 800, date: '2026-09-05' },
        ],
      }),
    ]);
    expect(flow.find(m => m.key === '2026-08')?.payouts).toBe(1_270);
    expect(flow.find(m => m.key === '2026-09')?.payouts).toBe(800);
  });

  // Ledger rows written before payouts were itemised carry only the rolled-up
  // total, and the purchase date is the only date they have.
  it('falls back to the purchase month for a payout total with no dated entries', () => {
    const flow = buildMonthlyFlow([
      entry({ actualPrice: 50, purchaseDate: '2026-08-04', payoutReceived: 500 }),
    ]);
    expect(flow).toEqual([
      { key: '2026-08', label: 'Aug', year: 2026, spent: 50, payouts: 500, net: 450 },
    ]);
  });

  it('prefers dated payouts over the rolled-up total, so nothing is double counted', () => {
    const flow = buildMonthlyFlow([
      entry({
        purchaseDate: '2026-08-04',
        payoutReceived: 500,
        payouts: [{ amount: 500, date: '2026-08-20' }],
      }),
    ]);
    expect(flow.reduce((sum, m) => sum + m.payouts, 0)).toBe(500);
  });

  it('keeps empty months in the run rather than closing the gap', () => {
    const flow = buildMonthlyFlow([
      entry({ actualPrice: 100, purchaseDate: '2026-06-10' }),
      entry({ actualPrice: 100, purchaseDate: '2026-09-10' }),
    ]);
    expect(flow.map(m => m.key)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
    expect(flow[1]).toMatchObject({ spent: 0, payouts: 0, net: 0 });
  });

  it('keeps only the most recent months, and never starts before the first one', () => {
    const entries = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']
      .map(month => entry({ actualPrice: 10, purchaseDate: `${month}-05` }));
    expect(buildMonthlyFlow(entries, 3).map(m => m.key)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(buildMonthlyFlow([entry({ actualPrice: 10, purchaseDate: '2026-07-05' })], 6))
      .toHaveLength(1);
  });

  it('crosses a year boundary', () => {
    const flow = buildMonthlyFlow([
      entry({ actualPrice: 10, purchaseDate: '2025-12-05' }),
      entry({ actualPrice: 10, purchaseDate: '2026-01-05' }),
    ]);
    expect(flow.map(m => `${m.label} ${m.year}`)).toEqual(['Dec 2025', 'Jan 2026']);
  });

  it('ignores unusable dates and negative amounts', () => {
    const flow = buildMonthlyFlow([
      entry({ actualPrice: 100, purchaseDate: '' }),
      entry({ actualPrice: 100, purchaseDate: '2026-13-01' }),
      entry({ actualPrice: -50, purchaseDate: '2026-08-01' }),
      entry({ actualPrice: 25, purchaseDate: '2026-08-01', payoutReceived: -5 }),
    ]);
    expect(flow).toEqual([
      { key: '2026-08', label: 'Aug', year: 2026, spent: 25, payouts: 0, net: -25 },
    ]);
  });
});
