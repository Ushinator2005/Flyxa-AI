const LEGACY_FLAG_ALIASES: Record<string, string> = {
  'off-playbook': 'incorrect-stop-loss',
};

export function normalizeBehavioralFlag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  if (!cleaned) return null;
  return LEGACY_FLAG_ALIASES[cleaned] ?? cleaned;
}

export function normalizeBehavioralFlags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map(normalizeBehavioralFlag)
      .filter((flag): flag is string => Boolean(flag)),
  )];
}
