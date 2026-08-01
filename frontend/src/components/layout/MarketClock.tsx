import { useEffect, useMemo, useState } from 'react';
import { useAppSettings } from '../../contexts/AppSettingsContext.js';
import { getMarketTiming, MARKET_CLOCK_OPTIONS } from '../../utils/marketHours.js';

type MarketClockProps = {
  displayTimezone: string;
};

function formatMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, totalMinutes);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDisplayTime(date: Date, timeZone: string, hour12: boolean): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: hour12 ? 'numeric' : '2-digit',
      minute: '2-digit',
      hour12,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: hour12 ? 'numeric' : '2-digit',
      minute: '2-digit',
      hour12,
    }).format(date);
  }
}

export default function MarketClock({ displayTimezone }: MarketClockProps) {
  const { preferences } = useAppSettings();
  const preset = preferences.marketClock ?? 'equities';
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(intervalId);
  }, []);

  const hour12 = (preferences.clockFormat ?? '12h') !== '24h';
  const timing = useMemo(() => getMarketTiming(now, preset), [now, preset]);
  const displayTime = useMemo(() => formatDisplayTime(now, displayTimezone, hour12), [displayTimezone, now, hour12]);
  const presetOption = MARKET_CLOCK_OPTIONS.find(option => option.value === preset);

  const tone = timing.marketOpenNow ? 'open' : 'pending';
  const detailMinutes = timing.marketOpenNow ? timing.minutesUntilClose : timing.minutesUntilOpen;
  const detail = formatMinutes(detailMinutes);

  // Countdown ring: full when the next state change is an hour or more away,
  // winding down to empty as open (or close) arrives.
  const RING_WINDOW = 60;
  const ringPct = Math.max(0, Math.min(1, detailMinutes / RING_WINDOW));
  const RADIUS = 7.5;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const accent = timing.marketOpenNow ? '#22c55e' : '#f59e0b';

  const title = presetOption
    ? `${presetOption.label} · ${timing.marketOpenNow ? `${detail} to close` : `opens in ${detail}`}, change in Settings`
    : undefined;

  return (
    <div className={`market-clock market-clock--${tone}`} title={title}>
      <span className="market-clock__time">{displayTime}</span>
      <span className="market-clock__ring" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r={RADIUS} fill="none" stroke="var(--app-border)" strokeWidth="2.4" />
          <circle
            cx="10" cy="10" r={RADIUS} fill="none"
            stroke={accent} strokeWidth="2.4" strokeLinecap="round"
            strokeDasharray={`${(CIRCUMFERENCE * ringPct).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
            transform="rotate(-90 10 10)"
            style={{ transition: 'stroke-dasharray 0.6s ease' }}
          />
        </svg>
      </span>
      <span className="market-clock__detail">{detail}</span>
    </div>
  );
}
