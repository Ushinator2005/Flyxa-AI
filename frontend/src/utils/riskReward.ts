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

