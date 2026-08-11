// Generic funded-payout readiness. Given a firm's chosen FundedPath and the
// account's live figures, produce the requirement rows that gate the next
// payout, a blended readiness %, and the one requirement currently blocking it.
// The path decides which gates exist (winning days, min trading days,
// consistency, safety-net buffer, per-cycle profit goal); this engine only
// evaluates whichever are present, so it works for every firm without special
// casing.

import type { FundedPath } from '../data/fundedPayoutPaths.js';
import { resolveBySize } from '../data/fundedPayoutPaths.js';

const money = (v: number) => (Number.isFinite(v) ? v : 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

export interface PayoutRequirementRow {
  key: string;
  label: string;
  detail: string;
  met: boolean;
  /** 0–1 progress toward this requirement. */
  progress: number;
  /** Compact headline figure for a metric card, e.g. "4/5", "73%", "$2,913". */
  big: string;
}

export interface PayoutReadiness {
  rows: PayoutRequirementRow[];
  /** Blended readiness percentage, 0–100. */
  readyPct: number;
  /** True once every gate is met (and the account is intact). */
  payoutReady: boolean;
  /** Label of the first unmet requirement, or null when ready. */
  blocking: string | null;
}

export interface PayoutContext {
  /** Net P&L per trading day (one entry per day traded). */
  dayPnls: number[];
  tradingDays: number;
  /** Profit above the starting balance (what could be withdrawn). */
  withdrawable: number;
  /** Room left above the MLL; ≤ 0 means the account is gone. */
  drawdownRemaining: number;
  /** Account size, for size-scaled thresholds. */
  size: number;
  /** Biggest profitable day as a % of total net profit (null until profitable). */
  consistencyActualPct: number | null;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function computePayoutReadiness(path: FundedPath, ctx: PayoutContext): PayoutReadiness {
  const rows: PayoutRequirementRow[] = [];

  // Winning days ≥ a (possibly size-scaled) threshold.
  if (path.winningDays) {
    const threshold = resolveBySize(path.winningDays.min, ctx.size);
    const have = ctx.dayPnls.filter(p => p >= threshold).length;
    const need = path.winningDays.count;
    const label = 'Winning days';
    const thresholdLabel = threshold > 1 ? ` · ≥${money(threshold)}` : '';
    rows.push({
      key: 'winningDays',
      label,
      detail: `${have} of ${need}${thresholdLabel}`,
      met: have >= need,
      progress: clamp01(have / need),
      big: `${have}/${need}`,
    });
  }

  // Minimum number of trading days.
  if (path.minTradingDays) {
    const need = path.minTradingDays;
    rows.push({
      key: 'minTradingDays',
      label: 'Trading days',
      detail: `${ctx.tradingDays} of ${need}`,
      met: ctx.tradingDays >= need,
      progress: clamp01(ctx.tradingDays / need),
      big: `${ctx.tradingDays}/${need}`,
    });
  }

  // Consistency: largest day ≤ pct% of total profit.
  if (typeof path.consistencyPct === 'number') {
    const pct = path.consistencyPct;
    const actual = ctx.consistencyActualPct;
    const met = actual !== null && actual <= pct;
    rows.push({
      key: 'consistency',
      label: 'Consistency',
      detail: actual === null
        ? `No profit yet · cap ${pct}%`
        : `Biggest day ${Math.round(actual)}% of profit · cap ${pct}%`,
      met,
      progress: actual === null ? 0 : clamp01(pct / Math.max(actual, 1)),
      big: actual === null ? '—' : `${Math.round(actual)}%`,
    });
  }

  // Safety-net buffer: only profit above the net is withdrawable.
  if (path.buffer) {
    const met = ctx.withdrawable > 0 && ctx.drawdownRemaining > 0;
    rows.push({
      key: 'buffer',
      label: 'Safety net',
      detail: ctx.drawdownRemaining <= 0
        ? 'Buffer breached'
        : ctx.withdrawable > 0
          ? `${money(ctx.withdrawable)} withdrawable`
          : 'No profit above the net yet',
      met,
      progress: met ? 1 : 0,
      big: money(Math.max(0, ctx.withdrawable)),
    });
  }

  // Per-cycle profit goal. A goal of ~0 is just "be net positive".
  if (path.profitGoal !== undefined) {
    const goal = resolveBySize(path.profitGoal, ctx.size);
    if (goal <= 1) {
      rows.push({
        key: 'profitGoal',
        label: 'Net profit',
        detail: ctx.withdrawable > 0 ? 'Positive this cycle' : 'Not positive yet',
        met: ctx.withdrawable > 0,
        progress: ctx.withdrawable > 0 ? 1 : 0,
        big: money(Math.max(0, ctx.withdrawable)),
      });
    } else {
      rows.push({
        key: 'profitGoal',
        label: 'Profit goal',
        detail: `${money(Math.max(0, ctx.withdrawable))} of ${money(goal)}`,
        met: ctx.withdrawable >= goal,
        progress: clamp01(ctx.withdrawable / goal),
        big: money(Math.max(0, ctx.withdrawable)),
      });
    }
  }

  // Every path should produce at least one row; guard anyway.
  if (rows.length === 0) {
    rows.push({
      key: 'profit',
      label: 'Net profit',
      detail: ctx.withdrawable > 0 ? 'Positive' : 'Not positive yet',
      met: ctx.withdrawable > 0,
      progress: ctx.withdrawable > 0 ? 1 : 0,
      big: money(Math.max(0, ctx.withdrawable)),
    });
  }

  const readyPct = Math.round((rows.reduce((s, r) => s + r.progress, 0) / rows.length) * 100);
  const accountIntact = ctx.drawdownRemaining > 0;
  const payoutReady = accountIntact && rows.every(r => r.met);
  const blocking = payoutReady ? null : (rows.find(r => !r.met)?.label ?? null);

  return { rows, readyPct, payoutReady, blocking };
}
