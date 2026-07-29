export function formatRiskRewardRatio(
  value: number | null | undefined,
  options?: {
    decimals?: number;
    placeholder?: string;
    includeSign?: boolean;
  },
): string {
  const decimals = options?.decimals ?? 2;
  const placeholder = options?.placeholder ?? 'N/A';
  const includeSign = options?.includeSign ?? false;

  if (!Number.isFinite(value)) return placeholder;

  const absolute = Math.abs(value as number);
  const rounded = Number(absolute.toFixed(decimals));
  const formattedNumber = rounded.toFixed(decimals).replace(/\.?0+$/, '');
  const rrDisplay = formattedNumber;

  if (includeSign && (value as number) < 0) {
    return `-${rrDisplay}`;
  }
  return rrDisplay;
}

// ── R:R averaging with outlier protection ─────────────────────────────
// A single typo'd stop or target (e.g. a take-profit of 292247 instead of
// 29224.75) produces an R:R in the thousands and poisons every average built
// from a naive mean. Real trades sit well under 20R; anything beyond
// MAX_PLAUSIBLE_RR is treated as a data-entry error and excluded.
export const MAX_PLAUSIBLE_RR = 50;

export function isPlausibleRR(rr: unknown): rr is number {
  return typeof rr === 'number' && Number.isFinite(rr) && rr !== 0 && Math.abs(rr) <= MAX_PLAUSIBLE_RR;
}

/** Mean of plausible R:R values, rounded to 2dp. Null when none qualify. */
export function averageRR(trades: Array<{ rr?: number | null }>): number | null {
  let sum = 0;
  let count = 0;
  for (const trade of trades) {
    if (isPlausibleRR(trade.rr)) {
      sum += trade.rr;
      count++;
    }
  }
  if (count === 0) return null;
  return Math.round((sum / count) * 100) / 100;
}

