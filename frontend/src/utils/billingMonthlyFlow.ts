// Month-by-month money out (challenge fees) vs money in (payouts) for the
// Billing page. Kept pure and separate from the page so the bucketing rules —
// especially the legacy-payout fallback — can be tested directly.

export interface MonthlyFlowEntry {
  actualPrice: number;
  purchaseDate: string;
  payoutReceived: number;
  payouts?: Array<{ amount: number; date: string }>;
}

export interface MonthlyFlowPoint {
  /** YYYY-MM */
  key: string;
  /** Short month name, e.g. "Sep" */
  label: string;
  year: number;
  spent: number;
  payouts: number;
  net: number;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** YYYY-MM out of a YYYY-MM-DD date, or null if it isn't one. */
function monthKey(date: unknown): string | null {
  if (typeof date !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(date)) return null;
  const month = Number(date.slice(5, 7));
  if (month < 1 || month > 12) return null;
  return date.slice(0, 7);
}

function addMonths(key: string, delta: number): string {
  const year = Number(key.slice(0, 4));
  const monthIndex = Number(key.slice(5, 7)) - 1 + delta;
  const nextYear = year + Math.floor(monthIndex / 12);
  const nextMonth = ((monthIndex % 12) + 12) % 12;
  return `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}`;
}

/**
 * The most recent `monthCount` months of spend and payouts.
 *
 * The run is contiguous and ends at the latest month with activity, so a month
 * where nothing happened shows as a gap rather than being closed up — on a time
 * axis, squeezing empty months out would misrepresent the pace of spending.
 */
export function buildMonthlyFlow(entries: MonthlyFlowEntry[], monthCount = 6): MonthlyFlowPoint[] {
  const spentByMonth = new Map<string, number>();
  const payoutsByMonth = new Map<string, number>();

  const add = (target: Map<string, number>, key: string, amount: number) => {
    if (!(amount > 0)) return;
    target.set(key, (target.get(key) ?? 0) + amount);
  };

  entries.forEach(entry => {
    const purchasedIn = monthKey(entry.purchaseDate);
    if (purchasedIn) add(spentByMonth, purchasedIn, entry.actualPrice);

    // Payouts carry their own dates. Ledger rows written before payouts were
    // itemised only have the rolled-up total, which we attribute to the month the
    // account was bought — the only date such a row has.
    const dated = (entry.payouts ?? []).filter(payout => monthKey(payout.date) !== null);
    if (dated.length > 0) {
      dated.forEach(payout => add(payoutsByMonth, monthKey(payout.date) as string, payout.amount));
    } else if (purchasedIn) {
      add(payoutsByMonth, purchasedIn, entry.payoutReceived);
    }
  });

  const activeMonths = [...new Set([...spentByMonth.keys(), ...payoutsByMonth.keys()])].sort();
  if (activeMonths.length === 0) return [];

  const lastMonth = activeMonths[activeMonths.length - 1];
  const firstMonth = activeMonths[0];
  const span: string[] = [];
  for (let offset = monthCount - 1; offset >= 0; offset--) {
    const key = addMonths(lastMonth, -offset);
    if (key >= firstMonth) span.push(key);
  }

  return span.map(key => {
    const spent = spentByMonth.get(key) ?? 0;
    const payouts = payoutsByMonth.get(key) ?? 0;
    return {
      key,
      label: MONTH_NAMES[Number(key.slice(5, 7)) - 1],
      year: Number(key.slice(0, 4)),
      spent,
      payouts,
      net: payouts - spent,
    };
  });
}
