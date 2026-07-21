import { Clock3 } from 'lucide-react';
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

function formatDisplayTime(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
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

  const timing = useMemo(() => getMarketTiming(now, preset), [now, preset]);
  const displayTime = useMemo(() => formatDisplayTime(now, displayTimezone), [displayTimezone, now]);
  const presetOption = MARKET_CLOCK_OPTIONS.find(option => option.value === preset);

  const tone = timing.marketOpenNow ? 'open' : 'pending';
  const detail = timing.marketOpenNow
    ? `${formatMinutes(timing.minutesUntilClose)} left`
    : formatMinutes(timing.minutesUntilOpen);

  return (
    <div
      className={`market-clock market-clock--${tone}`}
      title={presetOption ? `${presetOption.label} · ${presetOption.detail} — change in Settings` : undefined}
    >
      <span className="market-clock__segment market-clock__segment--clock">
        <span className="market-clock__icon" aria-hidden="true">
          <Clock3 size={13} />
        </span>
        <span className="market-clock__time">{displayTime}</span>
      </span>
      <span className="market-clock__segment market-clock__segment--countdown">
        <span className="market-clock__pulse" aria-hidden="true" />
        <span className="market-clock__status">{timing.marketOpenNow ? 'MARKET OPEN' : 'OPENS IN'}</span>
        <span className="market-clock__detail">{detail}</span>
      </span>
    </div>
  );
}
