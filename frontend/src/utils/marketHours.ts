// Market clock (America/New_York wall time). Shared by the header clock, the
// pre-session flow, and the dashboard's pre-session prompt so they can never
// disagree. The preset is a user preference — index traders live on NYSE RTH,
// futures traders on Globex, gold/forex traders on the 24/5 session.

export const MARKET_OPEN_MINUTES = 9 * 60 + 30;
export const MARKET_CLOSE_MINUTES = 16 * 60;

export type MarketClockPreset = 'equities' | 'futures' | 'forex';

export const MARKET_CLOCK_OPTIONS: Array<{ value: MarketClockPreset; label: string; detail: string }> = [
  { value: 'equities', label: 'US Equities', detail: 'NYSE regular hours · 9:30–16:00 ET' },
  { value: 'futures', label: 'Futures (Globex)', detail: 'Sun 18:00 – Fri 17:00 ET, daily 17:00–18:00 break' },
  { value: 'forex', label: 'Forex & Metals', detail: '24/5 · Sun 17:00 – Fri 17:00 ET' },
];

export function getEtParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    weekday: byType.weekday ?? 'Mon',
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface MarketTiming {
  marketOpenToday: boolean;
  marketOpenNow: boolean;
  minutesUntilOpen: number;
  minutesUntilClose: number;
}

// Is the market open at (dayIndex, minutes) ET for the given preset?
function isOpenAt(preset: MarketClockPreset, dayIndex: number, minutes: number): boolean {
  if (preset === 'equities') {
    return dayIndex >= 1 && dayIndex <= 5 && minutes >= MARKET_OPEN_MINUTES && minutes < MARKET_CLOSE_MINUTES;
  }
  if (preset === 'futures') {
    if (dayIndex === 6) return false;                                   // Saturday
    if (dayIndex === 0) return minutes >= 18 * 60;                      // Sunday opens 18:00
    if (dayIndex === 5) return minutes < 17 * 60;                       // Friday closes 17:00
    return minutes < 17 * 60 || minutes >= 18 * 60;                     // Mon–Thu daily break 17–18
  }
  // forex: continuous Sun 17:00 → Fri 17:00
  if (dayIndex === 6) return false;
  if (dayIndex === 0) return minutes >= 17 * 60;
  if (dayIndex === 5) return minutes < 17 * 60;
  return true;
}

export function getMarketTiming(now: Date, preset: MarketClockPreset = 'equities'): MarketTiming {
  const et = getEtParts(now);
  const dayIndex = WEEKDAY_INDEX[et.weekday] ?? 1;
  const currentMinutes = (et.hour * 60) + et.minute;

  const marketOpenNow = isOpenAt(preset, dayIndex, currentMinutes);

  // Walk forward in 1-minute steps to the next state change. Cheap: at most
  // a week of minutes, and it stops at the first transition.
  const minutesUntilState = (target: boolean): number => {
    let day = dayIndex;
    let mins = currentMinutes;
    for (let step = 1; step <= 8 * 24 * 60; step++) {
      mins += 1;
      if (mins >= 24 * 60) { mins = 0; day = (day + 1) % 7; }
      if (isOpenAt(preset, day, mins) === target) return step;
    }
    return 0;
  };

  const minutesUntilOpen = marketOpenNow ? 0 : minutesUntilState(true);
  const minutesUntilClose = marketOpenNow ? minutesUntilState(false) : 0;

  const marketOpenToday = preset === 'equities'
    ? dayIndex >= 1 && dayIndex <= 5
    : dayIndex !== 6;

  return { marketOpenToday, marketOpenNow, minutesUntilOpen, minutesUntilClose };
}

// Back-compat: the original NYSE RTH clock.
export function getRthTiming(now: Date): MarketTiming {
  return getMarketTiming(now, 'equities');
}
