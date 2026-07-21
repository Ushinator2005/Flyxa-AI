import { filterNewsItems, NewsFilterItem } from './claude';

type RawHeadline = { headline: string; source: string; timestamp: string; summary?: string; url?: string };

/** Matches the frontend breaking-news cache TTL (useBackgroundNewsPoller). */
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 1000;

// headline key -> classification (null = Claude judged it irrelevant)
const cache = new Map<string, { item: NewsFilterItem | null; at: number }>();

const keyFor = (headline: string) => headline.trim().toLowerCase();

function evict(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > TTL_MS) cache.delete(key);
  }
  // Map preserves insertion order, so the first keys are the oldest.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Classify headlines via Claude, memoized globally so each unique headline is
 * classified at most once per hour regardless of how many users are polling.
 * Without this, every logged-in browser pays to classify the same public
 * headlines every 5 minutes.
 */
export async function filterNewsItemsCached(headlines: RawHeadline[]): Promise<NewsFilterItem[]> {
  evict();
  const now = Date.now();
  const results: NewsFilterItem[] = [];
  const misses: RawHeadline[] = [];

  for (const h of headlines) {
    const hit = cache.get(keyFor(h.headline));
    if (hit && now - hit.at <= TTL_MS) {
      if (hit.item) results.push({ ...hit.item, url: h.url ?? hit.item.url });
    } else {
      misses.push(h);
    }
  }

  if (misses.length > 0) {
    const classified = await filterNewsItems(misses);
    for (const h of misses) {
      // filterNewsItems may lightly clean headlines; match on the same
      // 30-char prefix heuristic it uses internally for URL mapping.
      const item = classified.find(i => i.headline.slice(0, 30) === h.headline.slice(0, 30)) ?? null;
      cache.set(keyFor(h.headline), { item, at: now });
      if (item) results.push(item);
    }
  }

  return results;
}
