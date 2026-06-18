export function scaleContractAmount(
  value: number | undefined,
  currentContracts: number,
  nextContracts: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const current = Math.max(1, Math.round(currentContracts || 1));
  const next = Math.max(1, Math.round(nextContracts || 1));
  if (current === next) return value;
  return Math.round((value * next / current) * 100) / 100;
}
