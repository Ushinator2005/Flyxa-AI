import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Filter,
  RefreshCw,
  Search,
  Settings2,
  X,
  Zap,
} from 'lucide-react';
import { aiApi, marketDataApi, NewsFilterItem } from '../services/api.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import {
  DEFAULT_CALENDAR_TIME_ZONE,
  FEED_CALENDAR_TIME_ZONE,
  convertCalendarWallTime,
  getTimeZoneParts,
  normalizeCalendarTimeZone,
  zonedWallTimeToDate,
} from '../utils/calendarTime.js';

const PAGE_BG = 'var(--app-bg)';
const S1 = 'var(--app-panel)';
const S2 = 'var(--app-panel-strong)';
const BORDER = 'var(--app-border)';
const AMBER = 'var(--amber)';
const AMBER_DIM = 'var(--amber-dim)';
const AMBER_BORDER = 'var(--amber-border)';
const GREEN = 'var(--green)';
const GREEN_DIM = 'var(--green-dim)';
const GREEN_BORDER = 'var(--green-border)';
const RED = 'var(--red)';
const RED_DIM = 'var(--red-dim)';
const RED_BORDER = 'var(--red-border)';
const COBALT = 'var(--cobalt)';
const COBALT_DIM = 'var(--cobalt-dim)';
const COBALT_BORDER = 'var(--cobalt-border)';
const T1 = 'var(--app-text)';
const T2 = 'var(--app-text-muted)';
const T3 = 'var(--app-text-subtle)';
const SANS = 'var(--font-sans)';
const MONO = 'var(--font-mono)';

const FINNHUB_KEY = import.meta.env.VITE_FINNHUB_KEY as string | undefined;
const POLYGON_KEY = import.meta.env.VITE_POLYGON_KEY as string | undefined;
const FMP_KEY = import.meta.env.VITE_FMP_KEY as string | undefined;
const CACHE_KEY = 'flyxa_news_cache_v2';
const CALENDAR_CACHE_KEY = 'flyxa_calendar_cache_v4';
const SOURCES_KEY = 'flyxa_news_sources';
const CACHE_TTL = 15 * 60 * 1000;
const CALENDAR_CACHE_TTL = 12 * 60 * 60 * 1000;
const REFRESH_INTERVAL = 3 * 60 * 1000;
type ImpactLevel = 'high' | 'medium' | 'low';
type ImpactFilter = 'all' | ImpactLevel;
type CalendarImpactSelection = Record<ImpactLevel, boolean>;

interface RawHeadline {
  headline: string;
  source: string;
  timestamp: string;
  summary?: string;
  url?: string;
}

interface CalendarEvent {
  event: string;
  date: string; // YYYY-MM-DD
  time: string;
  impact: ImpactLevel;
  country: string;
  actual?: string;
  forecast?: string;
  previous?: string;
}

interface NewsCache {
  items: NewsFilterItem[];
  fetchedAt: number;
}

interface CalendarCache {
  events: CalendarEvent[];
  fetchedAt: number;
  isToday: boolean;
  timeZone: string;
}

interface SourcePrefs {
  finnhub: boolean;
  polygon: boolean;
  x: boolean;
  economicCalendar: boolean;
  aiFilter: boolean;
}

function readCache(): NewsCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NewsCache;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL) return null;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(items: NewsFilterItem[]) {
  if (!items.length) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, fetchedAt: Date.now() }));
  } catch {
    // ignore storage failures
  }
}

function readCalendarCache(timeZone: string): CalendarResult | null {
  try {
    const raw = localStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CalendarCache>;
    if (parsed.timeZone !== timeZone) return null;
    if (typeof parsed.fetchedAt !== 'number' || Date.now() - parsed.fetchedAt > CALENDAR_CACHE_TTL) return null;
    if (!Array.isArray(parsed.events) || parsed.events.length === 0) return null;
    return { events: parsed.events as CalendarEvent[], isToday: parsed.isToday === true };
  } catch {
    return null;
  }
}

function writeCalendarCache(result: CalendarResult, timeZone: string) {
  if (!result.events.length) return;
  try {
    localStorage.setItem(CALENDAR_CACHE_KEY, JSON.stringify({
      events: result.events,
      fetchedAt: Date.now(),
      isToday: result.isToday,
      timeZone,
    }));
  } catch {
    // ignore storage failures
  }
}

function readSourcePrefs(): SourcePrefs {
  const defaults: SourcePrefs = { finnhub: true, polygon: false, x: true, economicCalendar: true, aiFilter: true };
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<SourcePrefs>;
    return {
      finnhub: parsed.finnhub ?? defaults.finnhub,
      polygon: parsed.polygon ?? defaults.polygon,
      x: parsed.x ?? defaults.x,
      economicCalendar: parsed.economicCalendar ?? defaults.economicCalendar,
      aiFilter: parsed.aiFilter ?? defaults.aiFilter,
    };
  } catch {
    return defaults;
  }
}

function writeSourcePrefs(prefs: SourcePrefs) {
  localStorage.setItem(SOURCES_KEY, JSON.stringify(prefs));
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function impactColor(impact: ImpactLevel) {
  if (impact === 'high') return RED;
  if (impact === 'medium') return AMBER;
  return T3;
}

function impactBorderColor(impact: ImpactLevel, breaking: boolean) {
  if (breaking) return RED;
  if (impact === 'high') return RED;
  if (impact === 'medium') return AMBER;
  return T3;
}

function impactRank(impact: ImpactLevel) {
  if (impact === 'high') return 0;
  if (impact === 'medium') return 1;
  return 2;
}

function sentimentTone(value: string | undefined) {
  if (!value) return { color: T2, bg: S2, border: BORDER };
  const normalized = value.toLowerCase();
  if (normalized.includes('bull')) return { color: GREEN, bg: GREEN_DIM, border: GREEN_BORDER };
  if (normalized.includes('bear')) return { color: RED, bg: RED_DIM, border: RED_BORDER };
  return { color: T2, bg: S2, border: BORDER };
}

function impactTagLabel(symbol: 'ES' | 'NQ', value: string | undefined) {
  if (!value) return `${symbol} neutral`;
  const normalized = value.toLowerCase();
  if (normalized.includes('bull')) return `${symbol} bullish`;
  if (normalized.includes('bear')) return `${symbol} bearish`;
  return `${symbol} neutral`;
}

function sidebarCardStyle(): React.CSSProperties {
  return {
    background: S1,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '12px 13px',
    minWidth: 0,
    overflow: 'hidden',
    boxSizing: 'border-box',
  };
}

function feedCardBaseStyle(item: NewsFilterItem): React.CSSProperties {
  return {
    background: S1,
    border: `1px solid ${BORDER}`,
    borderLeft: `3px solid ${impactBorderColor(item.impact, item.isBreaking)}`,
    borderRadius: 8,
    padding: '14px 14px 13px',
    transition: 'background 0.15s ease, transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease',
    cursor: item.url ? 'pointer' : 'default',
  };
}

function feedCardHoverStyle(item: NewsFilterItem): React.CSSProperties {
  return {
    ...feedCardBaseStyle(item),
    background: S2,
    borderColor: BORDER,
    transform: 'translateY(-1px)',
    boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
  };
}

function feedCardRestStyle(item: NewsFilterItem): React.CSSProperties {
  return {
    ...feedCardBaseStyle(item),
    background: item.isBreaking ? RED_DIM : S1,
    transform: 'none',
    boxShadow: 'none',
  };
}

function impactBadgeStyle(impact: ImpactLevel): React.CSSProperties {
  if (impact === 'high') {
    return { color: RED, background: RED_DIM, border: `1px solid ${RED_BORDER}` };
  }
  if (impact === 'medium') {
    return { color: AMBER, background: AMBER_DIM, border: `1px solid ${AMBER_BORDER}` };
  }
  return { color: T2, background: S2, border: `1px solid ${BORDER}` };
}

async function fetchFinnhubNews(): Promise<RawHeadline[]> {
  if (!FINNHUB_KEY) return [];
  const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`);
  if (!res.ok) return [];
  const data = await res.json() as Array<{ headline: string; source: string; datetime: number; summary?: string; url?: string }>;
  return data.slice(0, 50).map(item => ({
    headline: item.headline,
    source: item.source,
    timestamp: new Date(item.datetime * 1000).toISOString(),
    summary: item.summary,
    url: item.url,
  }));
}

async function fetchPolygonNews(): Promise<RawHeadline[]> {
  if (!POLYGON_KEY) return [];
  const url = `https://api.polygon.io/v2/reference/news?limit=25&order=desc&sort=published_utc&ticker=ES1!&apiKey=${POLYGON_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json() as { results?: Array<{ title: string; publisher: { name: string }; published_utc: string; description?: string; article_url?: string }> };
  return (data.results ?? []).map(item => ({
    headline: item.title,
    source: item.publisher?.name ?? 'Polygon',
    timestamp: item.published_utc,
    summary: item.description,
    url: item.article_url,
  }));
}

interface FMPCalEvent {
  event: string;
  date: string;
  country: string;
  actual: number | null;
  previous: number | null;
  change: number | null;
  changePercentage: number | null;
  estimate: number | null;
  impact: string;
  unit: string;
}

interface CalendarResult { events: CalendarEvent[]; isToday: boolean }

type ForexFactoryRawEvent = {
  title?: string;
  event?: string;
  country?: string;
  currency?: string;
  date?: string;
  time?: string;
  impact?: string;
  actual?: string | number | null;
  forecast?: string | number | null;
  previous?: string | number | null;
};

function normalizeImpact(value: unknown): ImpactLevel {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('high')) return 'high';
  if (text.includes('medium') || text.includes('med')) return 'medium';
  return 'low';
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text.length ? text : undefined;
}

function isUsCalendarCountry(value: unknown): boolean {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'us' || text === 'usa' || text === 'usd' || text === 'united states' || text === 'united states of america';
}

function getCalendarDateText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function calendarDateHasClock(value: unknown): boolean {
  return /[T\s]\d{1,2}:\d{2}/.test(getCalendarDateText(value).trim());
}


function convertFmpCalendarDateTime(event: FMPCalEvent, targetTimeZone: string): { date: string; time: string } {
  // FMP returns datetimes in US Eastern time (no timezone indicator).
  // Parse the date+time as ET wall-time, then convert to targetTimeZone.
  const raw = getCalendarDateText(event.date).trim();
  if (calendarDateHasClock(event.date)) {
    const normalized = raw.replace(' ', 'T');
    const dateSlice = normalized.slice(0, 10);
    const timePart = normalized.length > 11 ? normalized.slice(11, 16) : '00:00';
    const instant = zonedWallTimeToDate(dateSlice, timePart, 'America/New_York');
    if (instant) return getTimeZoneParts(instant, targetTimeZone);
  }

  // Separate time field fallback, also treat as ET.
  const separateRawTime = (event as unknown as { time?: unknown }).time;
  const normalizedSepTime = normalizeForexFactoryTime(separateRawTime);
  if (normalizedSepTime && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const instant = zonedWallTimeToDate(raw, normalizedSepTime, 'America/New_York');
    if (instant) return getTimeZoneParts(instant, targetTimeZone);
  }

  const fallbackDate = raw.slice(0, 10);
  // Date-only: midnight ET converted to the display timezone.
  const fallbackInstant = zonedWallTimeToDate(fallbackDate, '00:00', 'America/New_York');
  return getTimeZoneParts(fallbackInstant ?? new Date(), targetTimeZone);
}

function normalizeForexFactoryDate(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const dateOnly = raw.length >= 10 ? raw.slice(0, 10) : raw;
  const parsed = new Date(`${dateOnly}T00:00:00`);
  if (!Number.isNaN(parsed.getTime())) return dateOnly;
  const parsedLoose = new Date(raw);
  if (Number.isNaN(parsedLoose.getTime())) return '';
  return parsedLoose.toISOString().slice(0, 10);
}

function normalizeForexFactoryTime(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{2}:\d{2}/.test(raw)) return raw.slice(0, 5);
  const parsed = new Date(`1970-01-01T${raw}`);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(11, 16);
  }
  return raw;
}

function normalizeForexFactoryEvents(
  raw: ForexFactoryRawEvent[],
  todaySlice: string,
  timeZone = DEFAULT_CALENDAR_TIME_ZONE,
  sourceTimeZone = FEED_CALENDAR_TIME_ZONE,
): CalendarResult {
  const events: CalendarEvent[] = [];
  let lastDate = '';
  let lastCurrency = '';

  raw.forEach((event) => {
    const rawCurrency = String(event.country ?? event.currency ?? '').trim().toUpperCase();
    if (rawCurrency) lastCurrency = rawCurrency;
    const cc = rawCurrency || lastCurrency;

    const parsedDate = normalizeForexFactoryDate(event.date);
    if (parsedDate) lastDate = parsedDate;
    const date = parsedDate || lastDate;

    if (!date) return;
    if (!isUsCalendarCountry(cc)) return;

    const normalizedTime = normalizeForexFactoryTime(event.time);
    const converted = normalizedTime
      ? convertCalendarWallTime(date, normalizedTime, timeZone, sourceTimeZone)
      : null;

    events.push({
      event: String(event.title ?? event.event ?? 'Event'),
      date: converted?.date ?? date,
      time: converted?.time ?? normalizedTime,
      impact: normalizeImpact(event.impact),
      country: 'USD',
      actual: toStringOrUndefined(event.actual),
      forecast: toStringOrUndefined(event.forecast),
      previous: toStringOrUndefined(event.previous),
    });
  });

  events.sort((a, b) => {
    const dateDiff = a.date.localeCompare(b.date);
    if (dateDiff !== 0) return dateDiff;
    return impactRank(a.impact) - impactRank(b.impact);
  });

  return {
    events,
    isToday: events.some(event => event.date === todaySlice),
  };
}
async function fetchForexFactoryCalendar(timeZone = DEFAULT_CALENDAR_TIME_ZONE, weeksAhead = 4): Promise<CalendarResult> {
  const safeTimeZone = normalizeCalendarTimeZone(timeZone);
  const now = new Date();
  const todaySlice = getTimeZoneParts(now, safeTimeZone).date;
  // Fetch from the start of last week through (weeksAhead) weeks ahead so
  // prev-week and multi-week-ahead navigation works without a re-fetch.
  const thisWeekStart = startOfWeekMonday(parseDateSlice(todaySlice));
  const fromSlice = toDateSlice(addDays(thisWeekStart, -7));                    // prev week Monday
  const endSlice  = toDateSlice(addDays(thisWeekStart, Math.max(28, weeksAhead * 7))); // at least 4 weeks

  if (FMP_KEY) {
    try {
      const res = await fetch(
        `https://financialmodelingprep.com/stable/economic-calendar?from=${fromSlice}&to=${endSlice}&apikey=${FMP_KEY}`
      );
      if (res.ok) {
        const raw = await res.json() as FMPCalEvent[];
        if (Array.isArray(raw)) {
          const rankImpact = (i: string) => {
            const lower = i.toLowerCase();
            return lower === 'high' ? 0 : lower === 'medium' ? 1 : 2;
          };

          const fmt = (v: number | null, unit: string): string | undefined => {
            if (v == null) return undefined;
            return unit ? `${v}${unit}` : String(v);
          };

          const events: CalendarEvent[] = raw
            .filter(e => isUsCalendarCountry(e.country))
            .sort((a, b) => {
              const dateDiff = getCalendarDateText(a.date).slice(0, 10).localeCompare(getCalendarDateText(b.date).slice(0, 10));
              if (dateDiff !== 0) return dateDiff;
              return rankImpact(a.impact) - rankImpact(b.impact);
            })
            .map(e => {
              const converted = convertFmpCalendarDateTime(e, safeTimeZone);
              return {
                event: e.event,
                date: converted.date,
                time: converted.time,
                country: 'USD',
                impact: (rankImpact(e.impact) === 0 ? 'high' : rankImpact(e.impact) === 1 ? 'medium' : 'low') as ImpactLevel,
                actual: fmt(e.actual, e.unit),
                forecast: fmt(e.estimate, e.unit),
                previous: fmt(e.previous, e.unit),
              };
            });

          const hasToday = events.some(e => e.date === todaySlice);
          if (events.length > 0) {
            return { events, isToday: hasToday };
          }
        }
      }
    } catch {
      // Fallbacks below
    }
  }

  try {
    const ffRaw = await marketDataApi.getFfCalendar();
    if (Array.isArray(ffRaw)) {
      const normalized = normalizeForexFactoryEvents(ffRaw as ForexFactoryRawEvent[], todaySlice, safeTimeZone);
      if (normalized.events.length > 0) return normalized;
    }
  } catch {
    // Fall through to direct fetch fallback below
  }

  try {
    const [thisWeek, nextWeek] = await Promise.allSettled([
      fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
        headers: { Accept: 'application/json' },
      }).then((response) => (response.ok ? response.json() : [])),
      fetch('https://nfs.faireconomy.media/ff_calendar_nextweek.json', {
        headers: { Accept: 'application/json' },
      }).then((response) => (response.ok ? response.json() : [])),
    ]);

    const combined = [
      ...(thisWeek.status === 'fulfilled' && Array.isArray(thisWeek.value) ? thisWeek.value : []),
      ...(nextWeek.status === 'fulfilled' && Array.isArray(nextWeek.value) ? nextWeek.value : []),
    ];

    if (combined.length > 0) {
      return normalizeForexFactoryEvents(combined as ForexFactoryRawEvent[], todaySlice, safeTimeZone);
    }
  } catch {
    // ignore
  }

  return { events: [], isToday: true };
}
function rawToNewsItem(raw: RawHeadline): NewsFilterItem {
  return {
    headline: raw.headline,
    summary: raw.summary || '',
    impact: 'low',
    category: 'Other',
    marketImpact: { es: 'neutral', nq: 'neutral' },
    isBreaking: false,
    source: raw.source,
    timestamp: raw.timestamp,
    url: raw.url,
  };
}

function ImpactBadge({ impact }: { impact: ImpactLevel }) {
  const style = impactBadgeStyle(impact);
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 4,
        ...style,
      }}
    >
      {impact}
    </span>
  );
}

function BreakingBadge() {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 4,
        background: RED,
        color: '#fff',
        border: `1px solid ${RED_BORDER}`,
        boxShadow: `0 0 0 1px ${RED_BORDER} inset`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
      }}
    >
      <Zap size={8} strokeWidth={2.4} />
      Breaking
    </span>
  );
}

function NewsCard({ item }: { item: NewsFilterItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = Boolean(item.summary || item.marketImpact?.note);
  const esTone = sentimentTone(item.marketImpact?.es);
  const nqTone = sentimentTone(item.marketImpact?.nq);

  return (
    <article
      style={feedCardRestStyle(item)}
      onMouseEnter={event => {
        Object.assign(event.currentTarget.style, feedCardHoverStyle(item));
      }}
      onMouseLeave={event => {
        Object.assign(event.currentTarget.style, feedCardRestStyle(item));
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {item.isBreaking && <BreakingBadge />}
            <ImpactBadge impact={item.impact} />
            <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{item.category}</span>
          </div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.48, color: T1, fontWeight: 500 }}>
            {item.headline}
          </p>
        </div>

        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: T3, lineHeight: 0, marginTop: 2 }}
            onMouseEnter={event => {
              event.currentTarget.style.color = COBALT;
            }}
            onMouseLeave={event => {
              event.currentTarget.style.color = T3;
            }}
          >
            <ExternalLink size={13} />
          </a>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, color: T2, fontFamily: MONO }}>{item.source}</span>
        <span style={{ fontSize: 10, color: T3 }}>•</span>
        <span style={{ fontSize: 10, color: T2, fontFamily: MONO }}>{fmtRelative(item.timestamp)}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 10,
              fontFamily: MONO,
              color: esTone.color,
              background: esTone.bg,
              borderRadius: 3,
              border: `1px solid ${esTone.border}`,
              padding: '2px 6px',
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
            }}
          >
            {impactTagLabel('ES', item.marketImpact?.es)}
          </span>
          <span
            style={{
              fontSize: 10,
              fontFamily: MONO,
              color: nqTone.color,
              background: nqTone.bg,
              borderRadius: 3,
              border: `1px solid ${nqTone.border}`,
              padding: '2px 6px',
              textTransform: 'uppercase',
              letterSpacing: '0.03em',
            }}
          >
            {impactTagLabel('NQ', item.marketImpact?.nq)}
          </span>
        </span>
      </div>

      {hasDetail && (
        <button
          onClick={() => setExpanded(value => !value)}
          style={{
            marginTop: 8,
            background: 'transparent',
            border: 'none',
            color: COBALT,
            fontSize: 11,
            fontWeight: 600,
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide details' : 'Show details'}
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      )}

      {expanded && hasDetail && (
        <div
          style={{
            marginTop: 9,
            borderRadius: 6,
            border: `1px solid ${BORDER}`,
            background: S2,
            padding: '10px 12px',
          }}
        >
          {item.summary && <p style={{ margin: 0, color: T2, fontSize: 12, lineHeight: 1.55 }}>{item.summary}</p>}
          {item.marketImpact?.note && (
            <p style={{ margin: item.summary ? '8px 0 0' : 0, color: AMBER, fontSize: 11, lineHeight: 1.5 }}>
              {item.marketImpact.note}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function fmtFFTime(raw: string): string {
  // Forex Factory sends times like "8:30am", "12:00pm", "All Day", "Tentative"
  if (!raw) return 'Time TBD';
  if (raw === 'All Day' || raw === 'Tentative') return raw;
  if (/^\d{2}:\d{2}$/.test(raw)) return raw;

  const twelveHourMatch = raw.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (twelveHourMatch) {
    const h = Number(twelveHourMatch[1]);
    const m = Number(twelveHourMatch[2]);
    const meridiem = twelveHourMatch[3].toLowerCase();
    const hours24 = meridiem === 'pm' && h !== 12 ? h + 12 : meridiem === 'am' && h === 12 ? 0 : h;
    return `${String(hours24).padStart(2, '0')}:${String(Number.isFinite(m) ? m : 0).padStart(2, '0')}`;
  }

  try {
    const parsed = new Date(`1970-01-01T${raw}`);
    if (!Number.isNaN(parsed.getTime())) {
      return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
    }
  } catch {
    // fall through
  }

  return raw;
}
function actualColor(actual: string | undefined, forecast: string | undefined): string {
  if (!actual || !forecast) return GREEN;
  const a = parseFloat(actual.replace(/[^0-9.-]/g, ''));
  const f = parseFloat(forecast.replace(/[^0-9.-]/g, ''));
  if (isNaN(a) || isNaN(f)) return GREEN;
  return a >= f ? GREEN : RED;
}

function fmtCalendarDate(dateSlice: string, timeZone = DEFAULT_CALENDAR_TIME_ZONE): string {
  const now = new Date();
  const todaySlice = getTimeZoneParts(now, timeZone).date;
  if (dateSlice === todaySlice) return 'Today';
  const tomorrow = addDays(parseDateSlice(todaySlice), 1);
  const tomorrowSlice = toDateSlice(tomorrow);
  if (dateSlice === tomorrowSlice) return 'Tomorrow';
  return new Date(dateSlice + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function parseDateSlice(dateSlice: string): Date {
  const [year, month, day] = dateSlice.split('-').map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function toDateSlice(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeekMonday(date: Date): Date {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
}

function formatWeekRange(start: Date): string {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  if (sameMonth) {
    return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { day: 'numeric' })}`;
  }
  return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function selectedCalendarImpactLabel(selection: CalendarImpactSelection): string {
  const active = (['high', 'medium', 'low'] as ImpactLevel[]).filter((impact) => selection[impact]);
  if (active.length === 3) return 'All';
  if (active.length === 0) return 'None';
  return active.map((impact) => (impact === 'medium' ? 'Med' : impact[0].toUpperCase() + impact.slice(1))).join(' + ');
}

function CalendarImpactFilterButton({
  value,
  onChange,
}: {
  value: CalendarImpactSelection;
  onChange: (value: CalendarImpactSelection) => void;
}) {
  const [open, setOpen] = useState(false);
  const options: Array<{ key: ImpactLevel; label: string }> = [
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
  ];

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        aria-label="Filter economic calendar impact"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          height: 28,
          border: `1px solid ${BORDER}`,
          borderRadius: 6,
          background: open ? COBALT_DIM : S2,
          color: open ? COBALT : T2,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          fontSize: 10,
          fontWeight: 700,
          cursor: 'pointer',
          maxWidth: 118,
        }}
      >
        <Filter size={12} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selectedCalendarImpactLabel(value)}
        </span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 32,
            right: 0,
            zIndex: 20,
            width: 150,
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            background: S1,
            boxShadow: '0 12px 28px rgba(0,0,0,0.35)',
            padding: 6,
          }}
        >
          {options.map((option) => {
            const checked = value[option.key];
            return (
              <label
                key={option.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 6px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: checked ? T1 : T2,
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => onChange({ ...value, [option.key]: event.target.checked })}
                  style={{ accentColor: impactColor(option.key) }}
                />
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    background: impactColor(option.key),
                    flexShrink: 0,
                  }}
                />
                {option.label}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CalendarPanel({
  events,
  isToday,
  impactSelection,
  onImpactSelectionChange,
  displayTimezone,
  weekOffset,
  onWeekOffsetChange: setWeekOffset,
}: {
  events: CalendarEvent[];
  isToday: boolean;
  impactSelection: CalendarImpactSelection;
  onImpactSelectionChange: (value: CalendarImpactSelection) => void;
  displayTimezone: string;
  weekOffset: number;
  onWeekOffsetChange: (offset: number | ((prev: number) => number)) => void;
}) {
  const safeDisplayTimezone = normalizeCalendarTimeZone(displayTimezone);
  const todaySlice = getTimeZoneParts(new Date(), safeDisplayTimezone).date;
  const subtitle = events.length === 0 ? 'USD' : 'USD weekly view';
  const filteredEvents = events.filter((event) => impactSelection[event.impact]);
  const weekStart = useMemo(() => {
    const currentWeek = startOfWeekMonday(parseDateSlice(todaySlice));
    return addDays(currentWeek, weekOffset * 7);
  }, [todaySlice, weekOffset]);
  const weekStartSlice = toDateSlice(weekStart);
  const weekEndSlice = toDateSlice(addDays(weekStart, 6));
  const weekEvents = filteredEvents.filter((event) => event.date >= weekStartSlice && event.date <= weekEndSlice);

  // Auto-navigate to the first week with events when weekOffset is 0 and current week is empty.
  useEffect(() => {
    if (weekOffset !== 0) return;
    if (weekEvents.length > 0) return;
    if (filteredEvents.length === 0) return;

    const nextEvent = filteredEvents.find((event) => event.date > weekEndSlice);
    if (!nextEvent) return;
    const daysToNext = Math.floor((parseDateSlice(nextEvent.date).getTime() - weekStart.getTime()) / 86400000);
    const offsetToNext = Math.max(1, Math.floor(daysToNext / 7));
    setWeekOffset(offsetToNext);
  }, [filteredEvents, weekEndSlice, weekEvents.length, weekOffset, weekStart, setWeekOffset]);

  const byDate = weekEvents.reduce<Record<string, CalendarEvent[]>>((acc, e) => {
    (acc[e.date] ??= []).push(e);
    return acc;
  }, {});
  const dates = Object.keys(byDate).sort();

  return (
    <section style={{ ...sidebarCardStyle(), padding: '16px', borderColor: AMBER_BORDER, background: S1 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 13, color: T1, textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 800, minWidth: 0 }}>
          Economic Calendar
        </p>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: T3 }}>{subtitle}</span>
          <CalendarImpactFilterButton value={impactSelection} onChange={onImpactSelectionChange} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: T2, fontFamily: MONO, letterSpacing: '0.03em' }}>
          {formatWeekRange(weekStart)}
          {weekOffset === 0 && (
            <span style={{ marginLeft: 6, color: isToday ? GREEN : T3 }}>{isToday ? 'today loaded' : 'today missing'}</span>
          )}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <button
            type="button"
            onClick={() => setWeekOffset((current) => current - 1)}
            style={{
              height: 25,
              borderRadius: 6,
              border: `1px solid ${BORDER}`,
              background: S2,
              color: T2,
              padding: '0 8px',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => setWeekOffset(0)}
            style={{
              height: 25,
              borderRadius: 6,
              border: `1px solid ${weekOffset === 0 ? COBALT_BORDER : BORDER}`,
              background: weekOffset === 0 ? COBALT_DIM : S2,
              color: weekOffset === 0 ? COBALT : T2,
              padding: '0 8px',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            This week
          </button>
          <button
            type="button"
            onClick={() => setWeekOffset((current) => current + 1)}
            style={{
              height: 25,
              borderRadius: 6,
              border: `1px solid ${AMBER_BORDER}`,
              background: AMBER_DIM,
              color: AMBER,
              padding: '0 8px',
              fontSize: 10,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Next
          </button>
        </div>
      </div>
      {events.length === 0 ? (
        <p style={{ margin: 0, color: T3, fontSize: 11 }}>No USD events available.</p>
      ) : filteredEvents.length === 0 ? (
        <p style={{ margin: 0, color: T3, fontSize: 11 }}>No selected USD events in the current range.</p>
      ) : weekEvents.length === 0 ? (
        <p style={{ margin: 0, color: T3, fontSize: 11 }}>No selected USD events for this week.</p>
      ) : (
        <div
          style={{
            display: 'grid',
            gap: 14,
            width: '100%',
            maxWidth: '100%',
            maxHeight: 'min(68vh, 720px)',
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '0 3px 0 2px',
            minWidth: 0,
            boxSizing: 'border-box',
          }}
        >
          {dates.map(date => (
            <div key={date} style={{ minWidth: 0, width: '100%', maxWidth: '100%', overflow: 'hidden' }}>
              <p style={{ margin: '0 0 7px', paddingLeft: 2, fontSize: 11, fontWeight: 800, color: date === todaySlice ? COBALT : AMBER, letterSpacing: '0.04em', textTransform: 'uppercase', lineHeight: 1.2 }}>
                {fmtCalendarDate(date, safeDisplayTimezone)}
              </p>
              <div style={{ display: 'grid', gap: 5, minWidth: 0, width: '100%' }}>
                {byDate[date].map((event, index) => {
                  const hasActual = Boolean(event.actual);
                  const aColor = actualColor(event.actual, event.forecast);
                  const isHigh = event.impact === 'high';
                  return (
                    <div
                      key={`${event.event}-${index}`}
                      style={{
                        padding: '9px 10px',
                        borderRadius: 7,
                        background: isHigh
                          ? `linear-gradient(90deg, rgba(240,82,82,0.16) 0%, rgba(240,82,82,0.08) 35%, ${S2} 100%)`
                          : S2,
                        border: isHigh ? `1px solid ${RED_BORDER}` : `1px solid ${BORDER}`,
                        borderLeft: `4px solid ${impactColor(event.impact)}`,
                        minWidth: 0,
                        maxWidth: '100%',
                        overflow: 'hidden',
                        boxSizing: 'border-box',
                        boxShadow: isHigh ? '0 8px 16px rgba(240,82,82,0.16)' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: (event.forecast || event.previous) ? 5 : 0 }}>
                        <span style={{ fontFamily: MONO, fontSize: 12, color: T1, minWidth: 44, flexShrink: 0, fontWeight: 600 }}>{fmtFFTime(event.time)}</span>
                        <span style={{ fontSize: 12, color: isHigh ? RED : T1, flex: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', fontWeight: 700 }}>{event.event}</span>
                        {isHigh && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 800,
                              letterSpacing: '0.08em',
                              textTransform: 'uppercase',
                              padding: '2px 5px',
                              borderRadius: 4,
                              color: RED,
                              background: RED_DIM,
                              border: `1px solid ${RED_BORDER}`,
                              flexShrink: 0,
                            }}
                          >
                            High
                          </span>
                        )}
                        {hasActual && (
                          <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: aColor, flexShrink: 0 }}>{event.actual}</span>
                        )}
                      </div>
                      {(event.forecast || event.previous) && (
                        <div style={{ display: 'flex', gap: 10, paddingLeft: 50, minWidth: 0, maxWidth: '100%', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap', boxSizing: 'border-box' }}>
                          {event.forecast && (
                            <span style={{ fontSize: 10, color: T3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
                              F: <span style={{ color: T2, fontFamily: MONO }}>{event.forecast}</span>
                            </span>
                          )}
                          {event.previous && (
                            <span style={{ fontSize: 10, color: T3, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>
                              P: <span style={{ color: T2, fontFamily: MONO }}>{event.previous}</span>
                            </span>
                          )}
                          {!hasActual && <span style={{ fontSize: 10, color: T3, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1 }}>pending</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
function SourcesPanel({ prefs, onChange }: { prefs: SourcePrefs; onChange: (value: SourcePrefs) => void }) {
  return (
    <section style={sidebarCardStyle()}>
      <p
        style={{
          margin: '0 0 8px',
          fontSize: 10,
          color: T3,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 700,
          display: 'inline-flex',
          gap: 5,
          alignItems: 'center',
        }}
      >
        <Settings2 size={10} />
        Sources
      </p>
      <div style={{ display: 'grid', gap: 7 }}>
        {([
          { key: 'finnhub', label: 'Finnhub', note: 'Requires VITE_FINNHUB_KEY' },
          { key: 'polygon', label: 'Polygon.io', note: 'Requires VITE_POLYGON_KEY' },
          { key: 'x', label: 'X accounts', note: 'Requires backend X_BEARER_TOKEN' },
          { key: 'economicCalendar', label: 'Economic Calendar', note: '' },
          { key: 'aiFilter', label: 'AI Filter', note: '' },
        ] as const).map(source => {
          const available =
            source.key === 'finnhub'
              ? Boolean(FINNHUB_KEY)
              : source.key === 'polygon'
                ? Boolean(POLYGON_KEY)
                : true;
          const active = prefs[source.key] && available;
          return (
            <label
              key={source.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: available ? 'pointer' : 'not-allowed',
                opacity: available ? 1 : 0.45,
              }}
            >
              <input
                type="checkbox"
                checked={active}
                disabled={!available}
                onChange={event => onChange({ ...prefs, [source.key]: event.target.checked })}
                style={{ accentColor: AMBER }}
              />
              <span style={{ fontSize: 11, color: T2 }}>{source.label}</span>
              {!available && source.note && <span style={{ fontSize: 9, color: T3 }}>({source.note})</span>}
            </label>
          );
        })}
      </div>
    </section>
  );
}

export default function MarketNews() {
  const { preferences } = useAppSettings();
  const [items, setItems] = useState<NewsFilterItem[]>([]);
  const [calendar, setCalendar] = useState<CalendarEvent[]>([]);
  const [calendarIsToday, setCalendarIsToday] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRawFallback, setIsRawFallback] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [filter, setFilter] = useState<ImpactFilter>('all');
  const [calendarImpactSelection, setCalendarImpactSelection] = useState<CalendarImpactSelection>({
    high: true,
    medium: true,
    low: true,
  });
  const [prefs, setPrefs] = useState<SourcePrefs>(readSourcePrefs);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'impact' | 'newest'>('impact');
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNews = useCallback(async (force = false) => {
    if (!force) {
      const cached = readCache();
      if (cached) {
        setItems(cached.items);
        setLastRefresh(new Date(cached.fetchedAt));
        return;
      }
    }

    setLoading(true);
    setError(null);
    try {
      const [finnhubRaw, polygonRaw, xRaw] = await Promise.allSettled([
        prefs.finnhub ? fetchFinnhubNews() : Promise.resolve([]),
        prefs.polygon ? fetchPolygonNews() : Promise.resolve([]),
        prefs.x ? marketDataApi.getXNews() : Promise.resolve([]),
      ]);

      const combined: RawHeadline[] = [
        ...(finnhubRaw.status === 'fulfilled' ? finnhubRaw.value : []),
        ...(polygonRaw.status === 'fulfilled' ? polygonRaw.value : []),
        ...(xRaw.status === 'fulfilled' ? xRaw.value : []),
      ];

      if (combined.length === 0) {
        setError(
          !FINNHUB_KEY && !POLYGON_KEY
            ? 'Add a news source key, or configure X_BEARER_TOKEN and X_MARKET_NEWS_USERNAMES in backend/.env.'
            : 'No headlines returned. Restart the dev server to pick up API keys, then refresh.',
        );
        setLoading(false);
        return;
      }

      const dedupedMap = new Map<string, RawHeadline>();
      for (const headline of combined) dedupedMap.set(headline.headline.slice(0, 100), headline);
      const deduped = Array.from(dedupedMap.values()).slice(0, 40);

      let finalItems: NewsFilterItem[] = [];
      let rawFallback = false;
      if (prefs.aiFilter) {
        try {
          const { items: filtered } = await aiApi.filterNews(deduped);
          if (filtered.length > 0) {
            finalItems = filtered;
          } else {
            finalItems = deduped.slice(0, 20).map(rawToNewsItem);
            rawFallback = true;
          }
        } catch {
          finalItems = deduped.slice(0, 20).map(rawToNewsItem);
          rawFallback = true;
        }
      } else {
        finalItems = deduped.slice(0, 20).map(rawToNewsItem);
      }

      finalItems.sort((a, b) => {
        const impactDiff = impactRank(a.impact) - impactRank(b.impact);
        if (impactDiff !== 0) return impactDiff;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      setItems(finalItems);
      setIsRawFallback(rawFallback);
      writeCache(finalItems);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load news');
    } finally {
      setLoading(false);
    }
  }, [prefs]);

  const fetchSidebar = useCallback(async (weeksAhead = 4) => {
    const safeTimeZone = normalizeCalendarTimeZone(preferences.timezone);
    if (!prefs.economicCalendar) {
      setCalendar([]);
      setCalendarIsToday(true);
      return;
    }

    try {
      const calendarResult = await fetchForexFactoryCalendar(safeTimeZone, weeksAhead);
      if (calendarResult.events.length > 0) {
        writeCalendarCache(calendarResult, safeTimeZone);
        setCalendar(calendarResult.events);
        setCalendarIsToday(calendarResult.isToday);
        return;
      }

      const cached = readCalendarCache(safeTimeZone);
      setCalendar(cached?.events ?? []);
      setCalendarIsToday(cached?.isToday ?? true);
    } catch {
      const cached = readCalendarCache(safeTimeZone);
      setCalendar(cached?.events ?? []);
      setCalendarIsToday(cached?.isToday ?? true);
    }
  }, [prefs.economicCalendar, preferences.timezone]);

  useEffect(() => {
    fetchNews();
    fetchSidebar();
    const scheduleNext = () => {
      timerRef.current = setTimeout(() => {
        fetchNews(true);
        fetchSidebar();
        scheduleNext();
      }, REFRESH_INTERVAL);
    };
    scheduleNext();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [fetchNews, fetchSidebar]);

  // When the user navigates forward, check if we have events for that week.
  // If not, re-fetch with a wider range so FMP can cover it.
  const loadedWeeksAheadRef = useRef(4);
  useEffect(() => {
    if (calendarWeekOffset <= 0) return;
    const neededWeeks = calendarWeekOffset + 2; // pad by 2 extra weeks
    if (neededWeeks <= loadedWeeksAheadRef.current) return;
    loadedWeeksAheadRef.current = neededWeeks;
    fetchSidebar(neededWeeks);
  }, [calendarWeekOffset, fetchSidebar]);

  const handlePrefsChange = (next: SourcePrefs) => {
    setPrefs(next);
    writeSourcePrefs(next);
  };

  const breakingCount = useMemo(() => items.filter(item => item.isBreaking).length, [items]);
  const highCount = useMemo(() => items.filter(item => item.impact === 'high').length, [items]);
  const highCalendarCount = useMemo(() => calendar.filter(event => event.impact === 'high').length, [calendar]);

  const displayed = useMemo(() => {
    const filtered = (filter === 'all' ? items : items.filter(item => item.impact === filter)).filter(item => {
      if (!query.trim()) return true;
      const haystack = `${item.headline} ${item.summary ?? ''} ${item.source} ${item.category}`.toLowerCase();
      return haystack.includes(query.trim().toLowerCase());
    });

    if (sortBy === 'newest') {
      return [...filtered].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
    return [...filtered].sort((a, b) => {
      const impactDiff = impactRank(a.impact) - impactRank(b.impact);
      if (impactDiff !== 0) return impactDiff;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }, [filter, items, query, sortBy]);

  const topBreaking = useMemo(() => items.find(item => item.isBreaking), [items]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, overflow: 'hidden', fontFamily: SANS, background: PAGE_BG }}>
      <div style={{ padding: '12px 18px 10px', borderBottom: `1px solid ${BORDER}`, background: S1, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ margin: 0, fontSize: 18, letterSpacing: '-0.01em', fontWeight: 650 }}>Market News</h1>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
              {[
                { label: 'Breaking', value: breakingCount, color: RED },
                { label: 'High', value: highCount, color: AMBER },
                { label: 'Calendar', value: highCalendarCount, color: COBALT },
              ].map((stat) => (
                <span
                  key={stat.label}
                  style={{
                    height: 24,
                    border: `1px solid ${BORDER}`,
                    borderRadius: 6,
                    background: S2,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '0 8px',
                    fontSize: 10,
                    color: T3,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    fontWeight: 700,
                  }}
                >
                  {stat.label}
                  <span style={{ color: stat.color, fontFamily: MONO, fontSize: 12, fontWeight: 800 }}>{stat.value}</span>
                </span>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {lastRefresh && <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>Updated {fmtRelative(lastRefresh.toISOString())}</span>}
            <button
              onClick={() => { void fetchNews(true); void fetchSidebar(); }}
              disabled={loading}
              style={{
                height: 30,
                borderRadius: 6,
                border: `1px solid ${loading ? COBALT_BORDER : BORDER}`,
                background: loading ? COBALT_DIM : S2,
                color: loading ? COBALT : T2,
                padding: '0 10px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}
            >
              <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
              {loading ? 'Refreshing' : 'Refresh'}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div
            style={{
              flex: 1,
              minWidth: 220,
              borderRadius: 6,
              border: `1px solid ${BORDER}`,
              background: S2,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '0 10px',
              height: 32,
            }}
          >
            <Search size={13} color={T3} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search headlines, source, category..."
              style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: T1, fontSize: 12 }}
            />
          </div>

          <InlineToggle
            label="Sort"
            value={sortBy}
            options={[
              { key: 'impact', label: 'Impact' },
              { key: 'newest', label: 'Newest' },
            ]}
            onChange={value => setSortBy(value as 'impact' | 'newest')}
          />

          <InlineToggle
            label="Impact"
            value={filter}
            options={[
              { key: 'all', label: 'All' },
              { key: 'high', label: 'High' },
              { key: 'medium', label: 'Med' },
              { key: 'low', label: 'Low' },
            ]}
            onChange={value => setFilter(value as ImpactFilter)}
          />
        </div>
      </div>

      <div
        className="mn-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(360px, 0.68fr) minmax(380px, 0.32fr)',
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          maxWidth: '100%',
          width: '100%',
          overflow: 'hidden',
          gap: 0,
        }}
      >
        <main className="mn-feed" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 10px 14px' }}>
          {topBreaking && (
            <div
              style={{
                margin: '12px 0 0',
                borderRadius: 8,
                border: `1px solid ${RED_BORDER}`,
                background: RED_DIM,
                padding: '10px 12px',
              }}
            >
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <BreakingBadge />
                <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{fmtRelative(topBreaking.timestamp)}</span>
              </div>
              <div style={{ fontSize: 13, color: T1, fontWeight: 500 }}>{topBreaking.headline}</div>
            </div>
          )}

          {error && !loading && (
            <div
              style={{
                margin: '12px 0 0',
                padding: '11px 14px',
                borderRadius: 8,
                background: RED_DIM,
                border: `1px solid ${RED_BORDER}`,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <AlertTriangle size={15} color={RED} />
              <span style={{ fontSize: 12, color: RED }}>{error}</span>
              <button
                onClick={() => setError(null)}
                style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: RED, cursor: 'pointer', lineHeight: 0 }}
              >
                <X size={13} />
              </button>
            </div>
          )}

          {loading && items.length === 0 && (
            <div style={{ height: 250, display: 'grid', placeItems: 'center', color: T3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite' }} />
                Fetching and scoring headlines...
              </div>
            </div>
          )}

          {!loading && !error && displayed.length === 0 && items.length > 0 && (
            <div style={{ padding: 32, textAlign: 'center', color: T3, fontSize: 12 }}>
              No stories match the current filters.
            </div>
          )}

          {!loading && !error && items.length === 0 && !FINNHUB_KEY && !POLYGON_KEY && (
            <div style={{ padding: '42px 32px', textAlign: 'center' }}>
              <p style={{ fontSize: 14, color: T2, marginBottom: 8 }}>No API keys configured.</p>
              <p style={{ fontSize: 12, color: T3 }}>
                Add <code style={{ background: S2, padding: '1px 5px', borderRadius: 3 }}>VITE_FINNHUB_KEY</code> in{' '}
                <code style={{ background: S2, padding: '1px 5px', borderRadius: 3 }}>frontend/.env</code> and restart.
              </p>
            </div>
          )}

          {!loading && isRawFallback && items.length > 0 && (
            <div
              style={{
                margin: '12px 0 0',
                padding: '8px 12px',
                borderRadius: 6,
                border: `1px solid ${AMBER_BORDER}`,
                background: AMBER_DIM,
                color: T2,
                fontSize: 11,
              }}
            >
              <span style={{ color: AMBER, fontWeight: 700 }}>Fallback Mode:</span> AI filter did not return ES/NQ-specific items, so latest raw
              headlines are shown.
            </div>
          )}

          <div style={{ marginTop: 10, display: 'grid', gap: 10, padding: '0 4px' }}>
            {displayed.map((item, index) => (
              <NewsCard key={`${item.headline}-${index}`} item={item} />
            ))}
          </div>
          </div>
        </main>

        <aside
          className="mn-sidebar"
          style={{
            width: '100%',
            minWidth: 0,
            borderLeft: `1px solid ${BORDER}`,
            background: PAGE_BG,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: 16,
          }}
        >
          <div style={{ display: 'grid', gap: 10 }}>
            <CalendarPanel
                events={calendar}
                isToday={calendarIsToday}
                impactSelection={calendarImpactSelection}
                onImpactSelectionChange={setCalendarImpactSelection}
                displayTimezone={preferences.timezone}
                weekOffset={calendarWeekOffset}
                onWeekOffsetChange={setCalendarWeekOffset}
              />
            <SourcesPanel prefs={prefs} onChange={handlePrefsChange} />
          </div>
        </aside>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @media (max-width: 1024px) {
          .mn-grid {
            display: block !important;
            overflow: auto !important;
          }
          .mn-feed {
            overflow: visible !important;
          }
          .mn-sidebar {
            width: 100% !important;
            border-left: none !important;
            border-top: 1px solid ${BORDER} !important;
            overflow: visible !important;
          }
        }
      `}</style>
    </div>
  );
}

function InlineToggle({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ key: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${BORDER}`, borderRadius: 6, overflow: 'hidden' }}>
      <span style={{ fontSize: 10, color: T3, padding: '0 8px', height: 32, display: 'inline-flex', alignItems: 'center', background: S2 }}>
        {label}
      </span>
      {options.map(option => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            onClick={() => onChange(option.key)}
            style={{
              height: 32,
              border: 'none',
              borderLeft: `1px solid ${BORDER}`,
              background: active ? COBALT_DIM : 'transparent',
              color: active ? COBALT : T2,
              padding: '0 9px',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}









