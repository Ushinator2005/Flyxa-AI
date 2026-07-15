// Shared currency formatting — the two families used across the app.
// formatUsd  → "$1,234.56" / "-$1,234.56" (locale currency, 2dp)
// formatUsd0 → "$1,235" / "-$1,235"       (whole dollars, explicit minus)
// Pages with genuinely different needs (Rivals' "+$x/-$x/$0", SessionActive's
// typographic minus) keep their own local variants on purpose.

export function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatUsd0(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
