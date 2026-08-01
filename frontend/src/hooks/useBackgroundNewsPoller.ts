import { useEffect, useRef } from 'react';
import { aiApi, marketDataApi } from '../services/api.js';

const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_KEY as string | undefined;
/** Poll every 5 minutes. */
const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** localStorage key for AI-confirmed breaking items. */
export const BREAKING_CACHE_KEY = 'flyxa_breaking_cache_v1';
/** Keep breaking items for up to 1 hour. */
const BREAKING_CACHE_TTL_MS = 60 * 60 * 1000;

interface RawItem {
  headline: string;
  source: string;
  timestamp: string;
  summary?: string;
  url?: string;
}

interface BreakingCache {
  items: RawItem[];
  fetchedAt: number;
}

function readBreakingCache(): BreakingCache | null {
  try {
    const raw = localStorage.getItem(BREAKING_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as BreakingCache;
  } catch {
    return null;
  }
}

async function fetchFinnhubRaw(): Promise<RawItem[]> {
  if (!FINNHUB_KEY) return [];
  const res = await fetch(
    `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`
  );
  if (!res.ok) return [];
  const data = await res.json() as Array<{
    headline: string;
    source: string;
    datetime: number;
    summary?: string;
    url?: string;
  }>;
  return data.slice(0, 50).map(item => ({
    headline: item.headline,
    source: item.source,
    timestamp: new Date(item.datetime * 1000).toISOString(),
    summary: item.summary,
    url: item.url,
  }));
}

async function pollOnce(): Promise<void> {
  const [finnhubResult, xResult] = await Promise.allSettled([
    fetchFinnhubRaw(),
    marketDataApi.getXNews(),
  ]);
  const raw = [
    ...(finnhubResult.status === 'fulfilled' ? finnhubResult.value : []),
    ...(xResult.status === 'fulfilled' ? xResult.value : []),
  ];
  if (raw.length === 0) return;

  // Skip headlines we've already processed.
  const existing = readBreakingCache();
  const seenKeys = new Set(
    (existing?.items ?? []).map(i => `${i.timestamp}|${i.headline.slice(0, 80)}`)
  );
  const newItems = raw.filter(
    item => !seenKeys.has(`${item.timestamp}|${item.headline.slice(0, 80)}`)
  );
  if (newItems.length === 0) return;

  // Run new headlines through the AI filter.
  const { items: filtered } = await aiApi.filterNews(newItems);

  // Keep only items the AI flagged as breaking.
  const breaking = filtered.filter(item => item.isBreaking);
  if (breaking.length === 0) return;

  // Merge with existing cache, evict anything older than 1 hour, cap at 20 items.
  const now = Date.now();
  const fresh = (existing?.items ?? []).filter(
    i => now - new Date(i.timestamp).getTime() < BREAKING_CACHE_TTL_MS
  );
  const merged: RawItem[] = [
    ...breaking.map(item => ({
      headline: item.headline,
      source: item.source,
      timestamp: item.timestamp,
      summary: item.summary,
      url: item.url,
    })),
    ...fresh,
  ].slice(0, 20);

  const cache: BreakingCache = { items: merged, fetchedAt: now };
  try { localStorage.setItem(BREAKING_CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
}

/**
 * Silently polls configured breaking-news sources every 5 minutes in the background.
 * New headlines are sent through the AI filter; only items classified as
 * `isBreaking: true` are written to `flyxa_breaking_cache_v1`.
 *
 * @param enabled  Pass `false` to disable (e.g. when user is not logged in).
 */
export function useBackgroundNewsPoller(enabled: boolean) {
  const runningRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    async function run() {
      if (runningRef.current) return; // prevent concurrent runs
      runningRef.current = true;
      try { await pollOnce(); } catch { /* silent, never crash the app */ }
      finally { runningRef.current = false; }
    }

    run();
    const id = window.setInterval(run, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled]);
}
