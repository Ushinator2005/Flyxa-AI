import { AppPreferences, Trade } from '../types/index.js';

export type SessionBucketKey = 'asia' | 'london' | 'preMarket' | 'newYork' | 'other';
export type TradeSessionLabel = Trade['session'] | 'Pre Market';

export const DEFAULT_SESSION_TIMES: AppPreferences['sessionTimes'] = {
  asia: { start: '19:00', end: '04:00' },
  london: { start: '03:00', end: '11:30' },
  preMarket: { start: '07:00', end: '09:30' },
  newYork: { start: '09:30', end: '16:00' },
};

const SESSION_LABELS: Record<SessionBucketKey, TradeSessionLabel> = {
  asia: 'Asia',
  london: 'London',
  preMarket: 'Pre Market',
  newYork: 'New York',
  other: 'Other',
};

export function timeToMinutes(time?: string | null): number | null {
  if (!time || typeof time !== 'string') return null;
  const [hoursText, minutesText] = time.split(':');
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

export function isInSessionRange(minutes: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function normalizeSessionLabel(value: unknown): TradeSessionLabel {
  if (value === 'Asia' || value === 'London' || value === 'Pre Market' || value === 'New York') {
    return value;
  }
  return 'Other';
}

export function getSessionKeyForTime(
  time: string | undefined,
  sessionTimes: AppPreferences['sessionTimes']
): SessionBucketKey {
  const minutes = timeToMinutes(time);
  if (minutes === null) return 'other';

  // Priority order: most specific sessions first so they win overlaps.
  // New York beats London at 09:30-11:30; Pre Market beats London at 07:00-09:30.
  const windows: Array<{ key: Exclude<SessionBucketKey, 'other'>; start: number | null; end: number | null }> = [
    { key: 'newYork', start: timeToMinutes(sessionTimes.newYork.start), end: timeToMinutes(sessionTimes.newYork.end) },
    { key: 'preMarket', start: timeToMinutes(sessionTimes.preMarket.start), end: timeToMinutes(sessionTimes.preMarket.end) },
    { key: 'london', start: timeToMinutes(sessionTimes.london.start), end: timeToMinutes(sessionTimes.london.end) },
    { key: 'asia', start: timeToMinutes(sessionTimes.asia.start), end: timeToMinutes(sessionTimes.asia.end) },
  ];

  const match = windows.find(window => (
    window.start !== null
      && window.end !== null
      && isInSessionRange(minutes, window.start, window.end)
  ));

  return match?.key ?? 'other';
}

export function getSessionLabelForTime(
  time: string | undefined,
  sessionTimes: AppPreferences['sessionTimes'],
  fallback?: unknown
): TradeSessionLabel {
  const key = getSessionKeyForTime(time, sessionTimes);
  if (key === 'other') {
    return normalizeSessionLabel(fallback);
  }
  return SESSION_LABELS[key];
}

export function deriveTradeSessionLabel(
  // Structural minimum instead of Partial<Trade> so both the API-shape trade
  // and the journal-store trade (which lacks trade_time/session) are accepted.
  trade: { trade_time?: string; session?: unknown },
  sessionTimes: AppPreferences['sessionTimes']
): TradeSessionLabel {
  return getSessionLabelForTime(trade.trade_time, sessionTimes, trade.session);
}

