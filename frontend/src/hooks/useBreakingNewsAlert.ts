import { useEffect, useRef } from 'react';
import { BREAKING_CACHE_KEY } from './useBackgroundNewsPoller.js';

const NEWS_CACHE_KEY = 'flyxa_news_cache_v2';
/** Only surface news items published within the last hour. */
const MAX_AGE_MS = 60 * 60 * 1000;
/** Re-check every 60 seconds. */
const CHECK_INTERVAL_MS = 60_000;
/** localStorage key to remember which headline was last shown. */
const LAST_SEEN_KEY = 'flyxa_breaking_news_last_seen';

interface RawHeadline {
  headline: string;
  source: string;
  timestamp: string;
  summary?: string;
  url?: string;
  /** Present on items from flyxa_news_cache_v2 (AI-filtered). */
  isBreaking?: boolean;
}

interface Cache {
  items: RawHeadline[];
  fetchedAt: number;
}

function newestWithinHour(items: RawHeadline[]): RawHeadline | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  const newest = sorted[0];
  if (!newest) return null;
  const age = Date.now() - new Date(newest.timestamp).getTime();
  return age <= MAX_AGE_MS ? newest : null;
}

/**
 * Priority:
 *  1. flyxa_breaking_cache_v1  — background-polled, AI-confirmed breaking items
 *  2. flyxa_news_cache_v2      — user-opened Market News, AI-filtered;
 *                                 only items where isBreaking === true are used
 */
function readLatestHeadline(): RawHeadline | null {
  // ── 1. Background breaking cache ────────────────────────────────
  try {
    const raw = localStorage.getItem(BREAKING_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Cache>;
      if (Array.isArray(parsed.items) && parsed.items.length > 0) {
        const found = newestWithinHour(parsed.items);
        if (found) return found;
      }
    }
  } catch { /* fall through */ }

  // ── 2. Market News page cache (breaking items only) ─────────────
  try {
    const raw = localStorage.getItem(NEWS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Cache>;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    const breakingOnly = parsed.items.filter(i => i.isBreaking === true);
    return newestWithinHour(breakingOnly);
  } catch {
    return null;
  }
}

/**
 * Polls both news caches every minute and fires a persistent notification bubble
 * whenever a new breaking headline appears that has not been shown before.
 *
 * Priority: flyxa_breaking_cache_v1 (background poller) →
 *           flyxa_news_cache_v2 with isBreaking=true (Market News page).
 *
 * @param onAlert  Callback called with the headline payload when new news is found.
 *                 Returns a cleanup/dismiss function.
 */
export function useBreakingNewsAlert(
  onAlert: (headline: { text: string; source: string; timestamp: string }) => () => void
) {
  const lastSeenRef = useRef<string>(
    typeof window !== 'undefined' ? (localStorage.getItem(LAST_SEEN_KEY) ?? '') : ''
  );
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    function check() {
      const latest = readLatestHeadline();
      if (!latest) return;

      // Use headline+timestamp as a unique key.
      const key = `${latest.timestamp}|${latest.headline}`;
      if (lastSeenRef.current === key) return;

      // Dismiss previous bubble if still open.
      cleanupRef.current?.();

      lastSeenRef.current = key;
      try { localStorage.setItem(LAST_SEEN_KEY, key); } catch { /* quota */ }

      cleanupRef.current = onAlert({
        text: latest.headline,
        source: latest.source,
        timestamp: latest.timestamp,
      });
    }

    check();
    const id = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      // Deliberately do NOT run cleanupRef here: the notification lives in a
      // global store and must survive unmounts — React StrictMode's dev
      // double-mount would otherwise dismiss it the instant it appears.
      // cleanupRef only fires when a NEWER headline replaces the current one.
    };
  }, [onAlert]);
}
