interface MaybeRichEntry {
  trades: unknown[];
  date?: string;
  isBlankDay?: boolean;
  dailyReflection?: { pre?: string; post?: string; lessons?: string } | null;
  reflection?: { pre?: string; post?: string; lessons?: string } | null;
  emotions?: Array<{ state?: string }> | null;
  physicalState?: { sleep?: number; stress?: number; energy?: number } | null;
  rules?: unknown[] | null;
  screenshots?: (string | null | undefined)[] | null;
  scannedImageUrl?: string | null;
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
  // An attached image on a no-trade day is intentional content.
  if (typeof entry.scannedImageUrl === 'string' && entry.scannedImageUrl.trim()) return true;
  return false;
}

/**
 * Remove entries that have no trades and no meaningful content.
 * Pass `preSessionHistory` so entries whose date has a pre-session or
 * post-session note are never silently pruned.
 */
export function pruneEmptyJournalEntries<T extends MaybeRichEntry>(
  entries: T[],
  preSessionHistory?: Record<string, unknown>,
): T[] {
  return entries.filter(entry => {
    if (entry.trades.length > 0) return true;
    // Explicitly marked blank days are intentional — always keep them.
    if (entry.isBlankDay) return true;
    if (hasContent(entry)) return true;
    // Keep the entry if a pre-session (or post-session note) exists for its date.
    if (preSessionHistory && typeof entry.date === 'string' && entry.date) {
      if (preSessionHistory[entry.date] != null) return true;
    }
    return false;
  });
}
