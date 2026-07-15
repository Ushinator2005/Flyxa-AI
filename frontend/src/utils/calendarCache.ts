// Single source of truth for the econ-calendar localStorage cache key.
// MarketNews writes the cache; Dashboard, TradeCheck, and useHighImpactAlerts
// read it. The key version MUST move in lockstep — a v4→v5 bump that only
// touched the writer left every reader staring at a stale key and the
// dashboard reporting "no high-impact events" while the calendar was full.
// Bump the version HERE and every consumer follows.
export const CALENDAR_CACHE_KEY = 'flyxa_calendar_cache_v5';

/** Legacy keys cleared on reset so old caches don't linger. */
export const LEGACY_CALENDAR_CACHE_KEYS = ['flyxa_calendar_cache_v4'];
