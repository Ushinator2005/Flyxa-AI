import { useEffect, useRef } from 'react';
import { pushToast, dismissToast } from '../store/toastStore.js';
import { CALENDAR_CACHE_KEY } from '../utils/calendarCache.js';
import { zonedWallTimeToDate } from '../utils/calendarTime.js';
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

        // zonedWallTimeToDate anchors the wall time on Date.UTC before applying
        // the target zone's offset. The local implementation this replaced built
        // the Date by parsing "YYYY-MM-DDTHH:MM", which the runtime reads in the
        // BROWSER's zone — so every alert drifted by the viewer's own UTC offset
        // and only came out right on a machine set to UTC. A São Paulo viewer was
        // told an event was "in 30 min" three hours after it had been released.
        const eventInstant = zonedWallTimeToDate(ev.date, ev.time, displayTimezone);
        if (!eventInstant) continue;
        const utcMs = eventInstant.getTime();

        const delta = utcMs - now; // positive = future, negative = past
        if (delta < -LOOKBACK_MS || delta > LOOKAHEAD_MS) continue;

        // Prefer events closest to firing (smallest absolute delta).
        if (Math.abs(delta) < Math.abs(bestDelta)) {
          bestDelta = delta;
          bestKey   = key;
          bestLabel = delta <= 0
            ? `${ev.event}, just released`
            : `${ev.event}, in ${Math.ceil(delta / 60_000)} min`;
        }
      }

      if (!bestKey) return;

      notifiedRef.current.add(bestKey);

      // Dismiss any previously active notification first so only one shows.
      if (activeToastId.current !== null) {
        dismissToast(activeToastId.current);
      }

      activeToastId.current = pushToast({
        message: bestLabel,
        kicker: 'HIGH IMPACT · ECON CALENDAR',
        tone: 'red',
        emphasis: true, // breaking-news treatment: solid red, pulsing, larger
        durationMs: null, // persists until the user closes it
        href: '/market-news',
      });
    }

    check();
    const id = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [displayTimezone]);
}
