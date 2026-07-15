import { useEffect, useRef } from 'react';
import { pushToast, dismissToast } from '../store/toastStore.js';
import { CALENDAR_CACHE_KEY } from '../utils/calendarCache.js';
/** Fire a notification when an event is within 30 minutes. */
const LOOKAHEAD_MS = 30 * 60 * 1000;
/** Also notify if the event just fired within the last 2 minutes. */
const LOOKBACK_MS = 2 * 60 * 1000;
/** Re-check every minute. */
const CHECK_INTERVAL_MS = 60 * 1_000;

interface CachedEvent {
  event: string;
  date: string;  // YYYY-MM-DD in display timezone
  time: string;  // HH:MM in display timezone
  impact: string;
}

function readHighImpactEvents(): CachedEvent[] {
  try {
    const raw = localStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { events?: unknown[] };
    if (!Array.isArray(parsed.events)) return [];
    return (parsed.events as CachedEvent[]).filter(
      (e) => typeof e === 'object' && e !== null && e.impact === 'high',
    );
  } catch {
    return [];
  }
}

/**
 * Converts a wall-time string (YYYY-MM-DD + HH:MM in a given timezone) to a
 * UTC millisecond timestamp. Uses Intl to resolve the UTC offset correctly.
 */
function wallTimeToUtcMs(dateSlice: string, timeHHMM: string, tz: string): number | null {
  const local = new Date(`${dateSlice}T${timeHHMM}:00`);
  if (Number.isNaN(local.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(local);
    const get = (t: string) =>
      Number(parts.find((p) => p.type === t)?.value ?? 0);
    const zonedAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    const offsetMs = zonedAsUtc - local.getTime();
    return local.getTime() - offsetMs;
  } catch {
    return null;
  }
}

/**
 * Polls the economic calendar cache every minute and fires a single persistent
 * toast notification for the most recent high-impact event within 30 minutes.
 * The previous notification is dismissed before the new one appears, so only
 * one alert is ever visible at a time. It stays until the user closes it.
 *
 * @param displayTimezone  IANA timezone string used by the calendar (e.g. 'America/New_York').
 */
export function useHighImpactAlerts(displayTimezone: string) {
  const notifiedRef   = useRef<Set<string>>(new Set());
  const activeToastId = useRef<string | null>(null);

  useEffect(() => {
    function check() {
      const events = readHighImpactEvents();
      const now = Date.now();

      // Find the single most-imminent high-impact event that hasn't been shown yet.
      let bestKey: string | null = null;
      let bestDelta = Infinity;
      let bestLabel = '';

      for (const ev of events) {
        if (!ev.time || !ev.date) continue;

        const key = `${ev.date}|${ev.time}|${ev.event}`;
        if (notifiedRef.current.has(key)) continue;

        const utcMs = wallTimeToUtcMs(ev.date, ev.time, displayTimezone);
        if (utcMs === null) continue;

        const delta = utcMs - now; // positive = future, negative = past
        if (delta < -LOOKBACK_MS || delta > LOOKAHEAD_MS) continue;

        // Prefer events closest to firing (smallest absolute delta).
        if (Math.abs(delta) < Math.abs(bestDelta)) {
          bestDelta = delta;
          bestKey   = key;
          bestLabel = delta <= 0
            ? `${ev.event} — just released`
            : `${ev.event} — in ${Math.ceil(delta / 60_000)} min`;
        }
      }

      if (!bestKey) return;

      notifiedRef.current.add(bestKey);

      // Dismiss any previously active notification first so only one shows.
      if (activeToastId.current !== null) {
        dismissToast(activeToastId.current);
      }

      activeToastId.current = pushToast({
        message: `High impact: ${bestLabel}`,
        tone: 'red',
        durationMs: null, // persists until the user closes it
      });
    }

    check();
    const id = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [displayTimezone]);
}
