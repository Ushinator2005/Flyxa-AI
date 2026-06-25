interface MaybeRichEntry {
  trades: unknown[];
  dailyReflection?: { pre?: string; post?: string; lessons?: string } | null;
  reflection?: { pre?: string; post?: string; lessons?: string } | null;
  emotions?: Array<{ state?: string }> | null;
  physicalState?: { sleep?: number; stress?: number; energy?: number } | null;
  rules?: unknown[] | null;
  screenshots?: (string | null | undefined)[] | null;
}

function hasContent(entry: MaybeRichEntry): boolean {
  const dr = entry.dailyReflection;
  if (dr?.pre?.trim() || dr?.post?.trim() || dr?.lessons?.trim()) return true;
  const r = entry.reflection;
  if (r?.pre?.trim() || r?.post?.trim() || r?.lessons?.trim()) return true;
  if (entry.emotions?.some(e => e.state && e.state !== 'neutral')) return true;
  const ps = entry.physicalState;
  if (ps && (ps.sleep || ps.stress || ps.energy)) return true;
  if ((entry.rules?.length ?? 0) > 0) return true;
  if (entry.screenshots?.some(s => typeof s === 'string' && s.trim())) return true;
  return false;
}

export function pruneEmptyJournalEntries<T extends MaybeRichEntry>(entries: T[]): T[] {
  return entries.filter(entry => entry.trades.length > 0 || hasContent(entry));
}
