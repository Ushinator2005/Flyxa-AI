import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Filter,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
  Zap,
} from 'lucide-react';
import { aiApi, marketDataApi, NewsFilterItem } from '../services/api.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import Modal from '../components/common/Modal.js';
import {
  DEFAULT_CALENDAR_TIME_ZONE,
  FEED_CALENDAR_TIME_ZONE,
  convertCalendarWallTime,
  getTimeZoneParts,
  normalizeCalendarTimeZone,
  zonedWallTimeToDate,
} from '../utils/calendarTime.js';

const PAGE_BG = 'var(--app-panel)';
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
const CALENDAR_CACHE_KEY = 'flyxa_calendar_cache_v5';
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
  sourceKey?: string;
}

interface CalendarCache {
  events: CalendarEvent[];
  fetchedAt: number;
  isToday: boolean;
  timeZone: string;
}

interface XAccountPref {
  username: string;
  enabled: boolean;
}

interface SourcePrefs {
  finnhub: boolean;
  polygon: boolean;
  x: boolean;
  xUsernames: string;
  xAccounts: XAccountPref[];
  economicCalendar: boolean;
  aiFilter: boolean;
}

function normalizeXUsernameInput(value: string): string {
  return parseXUsernames(value).join(', ');
}

function parseXUsernames(value: string): string[] {
  return Array.from(new Set(
    value
      .split(',')
      .map(username => username.trim().replace(/^@/, '').toLowerCase())
      .filter(username => /^[a-z0-9_]{1,15}$/.test(username))
  )).slice(0, 10);
}

function normalizeXAccounts(value: unknown, fallbackUsernames = ''): XAccountPref[] {
  const fromObjects = Array.isArray(value)
    ? value
        .map(item => {
          if (!item || typeof item !== 'object') return null;
          const record = item as { username?: unknown; enabled?: unknown };
          const username = parseXUsernames(String(record.username ?? ''))[0];
          return username ? { username, enabled: record.enabled !== false } : null;
        })
        .filter((item): item is XAccountPref => item !== null)
    : [];

  const source = fromObjects.length
    ? fromObjects
    : parseXUsernames(fallbackUsernames).map(username => ({ username, enabled: true }));

  const seen = new Set<string>();
  return source.filter(account => {
    if (seen.has(account.username)) return false;
    seen.add(account.username);
    return true;
  }).slice(0, 10);
}

function getEnabledXUsernames(prefs: SourcePrefs): string {
  const accounts = prefs.xAccounts.length
    ? prefs.xAccounts
    : parseXUsernames(prefs.xUsernames).map(username => ({ username, enabled: true }));
  return accounts.filter(account => account.enabled).map(account => account.username).join(', ');
}

function getNewsSourceKey(prefs: SourcePrefs): string {
  return JSON.stringify({
    finnhub: prefs.finnhub,
    polygon: prefs.polygon,
    x: prefs.x,
    xUsernames: getEnabledXUsernames(prefs),
    aiFilter: prefs.aiFilter,
  });
}

function readCache(sourceKey: string): NewsCache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NewsCache;
    if (parsed.sourceKey !== sourceKey) return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL) return null;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(items: NewsFilterItem[], sourceKey: string) {
  if (!items.length) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items, fetchedAt: Date.now(), sourceKey }));
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
  const defaults: SourcePrefs = { finnhub: true, polygon: false, x: true, xUsernames: '', xAccounts: [], economicCalendar: true, aiFilter: true };
  try {
    const raw = localStorage.getItem(SOURCES_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<SourcePrefs> & { xAccounts?: unknown };
    const xUsernames = typeof parsed.xUsernames === 'string' ? normalizeXUsernameInput(parsed.xUsernames) : defaults.xUsernames;
    const xAccounts = normalizeXAccounts(parsed.xAccounts, xUsernames);
    return {
      finnhub: parsed.finnhub ?? defaults.finnhub,
      polygon: parsed.polygon ?? defaults.polygon,
      x: parsed.x ?? defaults.x,
      xUsernames,
      xAccounts,
      economicCalendar: parsed.economicCalendar ?? defaults.economicCalendar,
      aiFilter: parsed.aiFilter ?? defaults.aiFilter,
    };
  } catch {
    return defaults;
  }
}

function writeSourcePrefs(prefs: SourcePrefs) {
  const xAccounts = normalizeXAccounts(prefs.xAccounts, prefs.xUsernames);
  const nextPrefs = {
    ...prefs,
    xAccounts,
    xUsernames: xAccounts.filter(account => account.enabled).map(account => account.username).join(', '),
  };
  localStorage.setItem(SOURCES_KEY, JSON.stringify(nextPrefs));
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

function combinedSentiment(es: string | undefined, nq: string | undefined): { label: string; color: string } {
  const eNorm = (es ?? 'neutral').toLowerCase().trim();
  const nNorm = (nq ?? 'neutral').toLowerCase().trim();
  const isBull = eNorm.includes('bull') || nNorm.includes('bull');
  const isBear = eNorm.includes('bear') || nNorm.includes('bear');
  const color = isBull && !isBear ? GREEN : isBear && !isBull ? RED : T2;
  const label = eNorm === nNorm ? eNorm : 'mixed';
  return { label, color };
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
    let converted = normalizedTime
      ? convertCalendarWallTime(date, normalizedTime, timeZone, sourceTimeZone)
      : null;

    // Newer FF JSON feeds embed the event time in an ISO `date`
    // ("2026-07-06T10:00:00-04:00") with no separate `time` field.
    if (!converted) {
      const rawDateText = String(event.date ?? '');
      const clockMatch = rawDateText.match(/[T\s](\d{1,2}:\d{2})/);
      // Exact midnight is FF's placeholder for all-day/TBD events — leave those blank.
      if (clockMatch && clockMatch[1] !== '0:00' && clockMatch[1] !== '00:00') {
        if (/(Z|[+-]\d{2}:?\d{2})$/.test(rawDateText)) {
          const instant = new Date(rawDateText);
          if (!Number.isNaN(instant.getTime())) {
            converted = getTimeZoneParts(instant, timeZone);
          }
        } else {
          converted = convertCalendarWallTime(date, clockMatch[1].padStart(5, '0'), timeZone, sourceTimeZone);
        }
      }
    }

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
  const combined = combinedSentiment(item.marketImpact?.es, item.marketImpact?.nq);
  const dotColor = item.isBreaking ? RED : item.impact === 'high' ? RED : item.impact === 'medium' ? AMBER : T3;

  return (
    <article
      style={{ padding: '11px 14px', borderBottom: `1px solid rgba(255,255,255,0.09)`, cursor: item.url ? 'pointer' : 'default', transition: 'background .1s', background: item.isBreaking ? 'rgba(239,68,68,0.05)' : 'transparent' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = item.isBreaking ? 'rgba(239,68,68,0.09)' : 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = item.isBreaking ? 'rgba(239,68,68,0.05)' : 'transparent'; }}
      onClick={() => { if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer'); }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        {/* Impact indicator */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 4, flexShrink: 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0, boxShadow: item.impact === 'high' || item.isBreaking ? `0 0 6px ${dotColor}` : 'none' }} />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45, color: item.isBreaking ? '#fff' : T1, fontWeight: item.isBreaking ? 600 : 450, flex: 1, minWidth: 0 }}>
              {item.isBreaking && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 7, fontSize: 9, fontWeight: 800, letterSpacing: '0.1em', color: RED, fontFamily: MONO }}>⚡ BREAKING</span>}
              {item.headline}
            </p>
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                style={{ color: T3, lineHeight: 0, flexShrink: 0, marginTop: 2 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = COBALT; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = T3; }}>
                <ExternalLink size={12} />
              </a>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{fmtRelative(item.timestamp)}</span>
            <span style={{ fontSize: 10, color: T3, opacity: 0.4 }}>·</span>
            <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{item.source}</span>
            {item.category && item.category !== 'Other' && (
              <>
                <span style={{ fontSize: 10, color: T3, opacity: 0.4 }}>·</span>
                <span style={{ fontSize: 9, color: T3, fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '.05em' }}>{item.category}</span>
              </>
            )}
            <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
              <span style={{ fontSize: 9, fontFamily: MONO, color: combined.color, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 700 }}>
                {combined.label}
              </span>
            </span>
          </div>

          {hasDetail && (
            <button onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
              style={{ marginTop: 5, background: 'transparent', border: 'none', color: COBALT, fontSize: 10, fontWeight: 600, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', fontFamily: SANS }}>
              {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {expanded ? 'Hide' : 'Details'}
            </button>
          )}

          {expanded && hasDetail && (
            <div style={{ marginTop: 7, paddingTop: 7, borderTop: `1px solid rgba(255,255,255,0.06)` }}>
              {item.summary && <p style={{ margin: 0, color: T2, fontSize: 12, lineHeight: 1.55 }}>{item.summary}</p>}
              {item.marketImpact?.note && (
                <p style={{ margin: item.summary ? '6px 0 0' : 0, color: AMBER, fontSize: 11, lineHeight: 1.5 }}>{item.marketImpact.note}</p>
              )}
            </div>
          )}
        </div>
      </div>
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
          border: `1px solid ${open ? AMBER : BORDER}`,
          borderRadius: 6,
          background: open ? AMBER : S2,
          color: open ? '#000' : T2,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          fontSize: 10,
          fontWeight: 700,
          cursor: 'pointer',
          maxWidth: 118,
          transition: 'background .12s, color .12s',
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

  const todayRef = useRef<HTMLDivElement>(null);
  const calendarScrollRef = useRef<HTMLDivElement>(null);
  const hasAutoScrolled = useRef(false);

  const byDate = weekEvents.reduce<Record<string, CalendarEvent[]>>((acc, e) => {
    (acc[e.date] ??= []).push(e);
    return acc;
  }, {});
  const dates = Object.keys(byDate).sort();

  // Auto-scroll to today's date section when events first load on the current week.
  useEffect(() => {
    if (weekOffset !== 0) return;
    if (!dates.includes(todaySlice)) return;
    if (hasAutoScrolled.current) return;
    if (!todayRef.current) return;
    hasAutoScrolled.current = true;
    const timer = setTimeout(() => {
      const container = calendarScrollRef.current;
      const todayEl = todayRef.current;
      if (!container || !todayEl) return;
      const containerRect = container.getBoundingClientRect();
      const todayRect = todayEl.getBoundingClientRect();
      const offset = todayRect.top - containerRect.top + container.scrollTop;
      container.scrollTo({ top: offset, behavior: 'smooth' });
    }, 120);
    return () => clearTimeout(timer);
  }, [dates, todaySlice, weekOffset]);

  return (
    <section style={{ paddingTop: 4 }}>
      {/* Calendar header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10, padding: '0 14px 0 12px', borderLeft: `2px solid ${COBALT}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: T2 }}>Econ Calendar</span>
          <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{subtitle}</span>
          {weekOffset === 0 && <span style={{ fontSize: 9, color: isToday ? GREEN : T3, fontFamily: MONO }}>{isToday ? '● live' : '○ missing'}</span>}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <CalendarImpactFilterButton value={impactSelection} onChange={onImpactSelectionChange} />
        </div>
      </div>

      {/* Week nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, padding: '0 14px' }}>
        <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{formatWeekRange(weekStart)}</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {[
            { label: '‹', action: () => setWeekOffset(c => c - 1), active: false },
            { label: 'Now', action: () => setWeekOffset(0), active: weekOffset === 0 },
            { label: '›', action: () => setWeekOffset(c => c + 1), active: false },
          ].map(btn => (
            <button key={btn.label} type="button" onClick={btn.action} style={{ height: 22, borderRadius: 4, border: `1px solid ${btn.active ? AMBER : BORDER}`, background: btn.active ? AMBER : S2, color: btn.active ? '#000' : T3, padding: '0 7px', fontSize: 11, fontWeight: 700, cursor: 'pointer', lineHeight: 1, transition: 'background .12s, color .12s' }}>
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {events.length === 0 ? (
        <p style={{ margin: 0, color: T3, fontSize: 11, padding: '0 14px' }}>No USD events available.</p>
      ) : filteredEvents.length === 0 ? (
        <p style={{ margin: 0, color: T3, fontSize: 11, padding: '0 14px' }}>No events for selected impacts.</p>
      ) : weekEvents.length === 0 ? (
        <p style={{ margin: 0, color: T3, fontSize: 11, padding: '0 14px' }}>No events this week.</p>
      ) : (
        <div
          ref={calendarScrollRef}
          style={{ maxHeight: 'min(60vh, 640px)', overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}
        >
          {dates.map(date => (
            <div key={date} ref={date === todaySlice ? todayRef : undefined} style={{ minWidth: 0 }}>
              {/* Date header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 4px', position: 'sticky', top: 0, background: S2, zIndex: 2, borderBottom: `1px solid ${BORDER}` }}>
                <span style={{ width: 3, height: 12, borderRadius: 2, background: date === todaySlice ? COBALT : AMBER, flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontWeight: 800, color: date === todaySlice ? COBALT : AMBER, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {fmtCalendarDate(date, safeDisplayTimezone)}
                </span>
                {date === todaySlice && <span style={{ fontSize: 9, color: COBALT, fontFamily: MONO, opacity: .7 }}>today</span>}
              </div>

              {/* Events table */}
              {byDate[date].map((event, index) => {
                  const hasActual = Boolean(event.actual);
                  const aColor = actualColor(event.actual, event.forecast);
                  const isHigh = event.impact === 'high';
                  const isMed = event.impact === 'medium';
                  const impDot = isHigh ? RED : isMed ? AMBER : T3;
                  return (
                    <div
                      key={`${event.event}-${index}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '44px 8px 1fr auto',
                        alignItems: 'center',
                        gap: 8,
                        padding: '7px 14px',
                        borderBottom: `1px solid ${BORDER}`,
                        background: isHigh ? 'rgba(239,68,68,0.04)' : 'transparent',
                        transition: 'background .1s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = isHigh ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isHigh ? 'rgba(239,68,68,0.04)' : 'transparent'; }}
                    >
                      <span style={{ fontFamily: MONO, fontSize: 12, color: T2, fontWeight: 700 }}>{fmtFFTime(event.time)}</span>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: impDot, flexShrink: 0, boxShadow: isHigh ? `0 0 5px ${RED}` : 'none' }} />
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 12, color: isHigh ? '#fff' : T1, fontWeight: isHigh ? 600 : 450, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', display: 'block' }}>{event.event}</span>
                        {(event.forecast || event.previous) && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                            {event.forecast && <span style={{ fontSize: 9, color: T3, fontFamily: MONO }}>F: <span style={{ color: T2 }}>{event.forecast}</span></span>}
                            {event.previous && <span style={{ fontSize: 9, color: T3, fontFamily: MONO }}>P: <span style={{ color: T2 }}>{event.previous}</span></span>}
                            {!hasActual && <span style={{ fontSize: 9, color: T3, fontFamily: MONO }}>pending</span>}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        {hasActual && <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: aColor }}>{event.actual}</span>}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SourcesPanel({
  prefs,
  onChange,
  onOpenXAccounts,
}: {
  prefs: SourcePrefs;
  onChange: (value: SourcePrefs) => void;
  onOpenXAccounts: () => void;
}) {
  const xAccounts = prefs.xAccounts;
  const enabledCount = xAccounts.filter(account => account.enabled).length;

  return (
    <section style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 14, marginTop: 14 }}>
      <p
        style={{
          margin: '0 0 10px',
          fontSize: 10,
          color: T2,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 700,
          display: 'inline-flex',
          gap: 5,
          alignItems: 'center',
          padding: '0 14px 0 12px',
          borderLeft: `2px solid ${AMBER}`,
        }}
      >
        <Settings2 size={10} />
        Sources
      </p>
      <div style={{ padding: '0 14px', display: 'grid', gap: 7 }}>
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
      <div style={{ marginTop: 12, borderTop: `1px solid ${BORDER}`, paddingTop: 10, padding: '10px 14px 0' }}>
        <button
          type="button"
          onClick={onOpenXAccounts}
          style={{
            width: '100%',
            minHeight: 42,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            borderRadius: 8,
            border: `1px solid ${AMBER_BORDER}`,
            background: `linear-gradient(180deg, ${AMBER_DIM}, rgba(251, 146, 60, 0.07))`,
            color: AMBER,
            padding: '0 11px',
            cursor: 'pointer',
            fontFamily: SANS,
            boxShadow: '0 0 0 1px rgba(251, 146, 60, 0.08), 0 10px 24px rgba(0, 0, 0, 0.18)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <span
              style={{
                width: 22,
                height: 22,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 7,
                border: `1px solid ${AMBER_BORDER}`,
                background: 'rgba(251, 146, 60, 0.16)',
                flexShrink: 0,
              }}
            >
              <Plus size={13} />
            </span>
            <span style={{ display: 'grid', gap: 2, minWidth: 0, textAlign: 'left' }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: T1 }}>Add X accounts</span>
              <span style={{ color: T3, fontSize: 10, fontWeight: 650 }}>{enabledCount} of {xAccounts.length || 0} active</span>
            </span>
          </span>
          <ChevronDown size={14} />
        </button>
      </div>
    </section>
  );
}

function TwitterXLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M17.9 3h3.1l-6.8 7.8 8 10.2h-6.3l-5-6.5-5.7 6.5H2.1l7.3-8.3L1.8 3h6.5l4.5 5.9L17.9 3Zm-1.1 16.2h1.7L7.4 4.7H5.6l11.2 14.5Z"
      />
    </svg>
  );
}

function XAccountsModal({
  isOpen,
  onClose,
  prefs,
  xDraft,
  onXDraftChange,
  onXAdd,
  onXToggle,
  onXRemove,
}: {
  isOpen: boolean;
  onClose: () => void;
  prefs: SourcePrefs;
  xDraft: string;
  onXDraftChange: (value: string) => void;
  onXAdd: () => void;
  onXToggle: (username: string, enabled: boolean) => void;
  onXRemove: (username: string) => void;
}) {
  const xAccounts = normalizeXAccounts(prefs.xAccounts, prefs.xUsernames);
  const enabledCount = xAccounts.filter(account => account.enabled).length;
  const parsedDraftCount = parseXUsernames(xDraft).filter(username => !xAccounts.some(account => account.username === username)).length;
  const canAdd = prefs.x && xAccounts.length < 10 && parsedDraftCount > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <div style={{ display: 'grid', gap: 14, fontFamily: SANS, padding: '2px 2px 0' }}>
        <div style={{ display: 'grid', gap: 12, paddingRight: 34 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minWidth: 0 }}>
            <span
              style={{
                width: 36,
                height: 36,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 7,
                border: `1px solid ${BORDER}`,
                background: S2,
                color: T1,
                flexShrink: 0,
              }}
            >
              <TwitterXLogo size={17} />
            </span>
            <div style={{ minWidth: 0 }}>
              <p style={{ margin: 0, color: T1, fontSize: 17, fontWeight: 800 }}>X accounts</p>
              <p style={{ margin: '4px 0 0', color: T2, fontSize: 12, lineHeight: 1.45 }}>
                Add the accounts you want Flyxa to monitor in Market News.
              </p>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {[
              { label: 'Active', value: enabledCount },
              { label: 'Added', value: `${xAccounts.length} / 10` },
            ].map(stat => (
              <div
                key={stat.label}
                style={{
                  minHeight: 42,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 8,
                  padding: '8px 10px',
                  background: S1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <span style={{ color: T3, fontSize: 11, fontWeight: 700 }}>{stat.label}</span>
                <span style={{ color: T1, fontSize: 13, fontWeight: 800 }}>{stat.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 9, background: S1, padding: 10, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <label style={{ color: T2, fontSize: 11, fontWeight: 750 }}>Add account handles</label>
            <span style={{ color: T3, fontSize: 10 }}>{xAccounts.length >= 10 ? 'Limit reached' : 'Comma separated'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 86px', gap: 8, minWidth: 0 }}>
            <input
              value={xDraft}
              onChange={event => onXDraftChange(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && canAdd) onXAdd();
              }}
              disabled={!prefs.x || xAccounts.length >= 10}
              placeholder="@financialjuice, @unusual_whales"
              style={{
                minWidth: 0,
                height: 38,
                borderRadius: 8,
                border: `1px solid ${BORDER}`,
                background: S2,
                color: T1,
                padding: '0 12px',
                outline: 'none',
                fontSize: 13,
                fontFamily: SANS,
                opacity: prefs.x && xAccounts.length < 10 ? 1 : 0.5,
              }}
            />
            <button
              type="button"
              onClick={onXAdd}
              disabled={!canAdd}
              style={{
                height: 38,
                borderRadius: 8,
                border: `1px solid ${canAdd ? AMBER_BORDER : BORDER}`,
                background: canAdd ? AMBER : S2,
                color: canAdd ? '#111111' : T3,
                cursor: canAdd ? 'pointer' : 'not-allowed',
                fontWeight: 800,
                fontSize: 12,
                fontFamily: SANS,
              }}
            >
              Add
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 7 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <p style={{ margin: 0, color: T2, fontSize: 11, fontWeight: 750 }}>Saved accounts</p>
            <p style={{ margin: 0, color: T3, fontSize: 11 }}>{xAccounts.length === 0 ? 'None yet' : `${enabledCount} active`}</p>
          </div>
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 9, overflow: 'hidden', background: S1, minHeight: 116 }}>
            {xAccounts.length === 0 ? (
              <div style={{ minHeight: 116, padding: '18px', color: T3, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 13 }}>
                <span
                  style={{
                    width: 32,
                    height: 32,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 7,
                    border: `1px solid ${BORDER}`,
                    background: S2,
                    color: T1,
                  }}
                >
                  <TwitterXLogo size={15} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, color: T2, fontSize: 13, fontWeight: 750 }}>No accounts added yet</p>
                  <p style={{ margin: '4px 0 0', maxWidth: 310, lineHeight: 1.45 }}>
                    Add handles above to include their latest posts in your refresh.
                  </p>
                </div>
              </div>
            ) : (
              xAccounts.map((account, index) => (
                <div
                  key={account.username}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto auto',
                    alignItems: 'center',
                    gap: 10,
                    padding: '11px 12px',
                    borderTop: index === 0 ? 'none' : `1px solid ${BORDER}`,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, color: T1, fontSize: 13, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      @{account.username}
                    </p>
                    <p style={{ margin: '3px 0 0', color: account.enabled ? GREEN : T3, fontSize: 11 }}>
                      {account.enabled ? 'Included in refreshes' : 'Saved but paused'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onXToggle(account.username, !account.enabled)}
                    style={{
                      minWidth: 76,
                      height: 30,
                      borderRadius: 999,
                      border: `1px solid ${account.enabled ? GREEN_BORDER : BORDER}`,
                      background: account.enabled ? GREEN_DIM : S2,
                      color: account.enabled ? GREEN : T2,
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 800,
                      fontFamily: SANS,
                    }}
                  >
                    {account.enabled ? 'On' : 'Off'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove @${account.username}`}
                    onClick={() => onXRemove(account.username)}
                    style={{
                      width: 30,
                      height: 30,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 8,
                      border: `1px solid ${BORDER}`,
                      background: 'transparent',
                      color: T3,
                      cursor: 'pointer',
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <p style={{ margin: 0, color: T3, fontSize: 11, lineHeight: 1.45 }}>
          X accounts require the backend bearer token. Toggled-off accounts stay saved but are excluded from refreshes.
        </p>
      </div>
    </Modal>
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
  const [xAccountDraft, setXAccountDraft] = useState('');
  const [xAccountsModalOpen, setXAccountsModalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'impact' | 'newest'>('impact');
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNews = useCallback(async (force = false) => {
    const sourceKey = getNewsSourceKey(prefs);
    if (!force) {
      const cached = readCache(sourceKey);
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
        prefs.x ? marketDataApi.getXNews(getEnabledXUsernames(prefs)) : Promise.resolve([]),
      ]);

      const combined: RawHeadline[] = [
        ...(finnhubRaw.status === 'fulfilled' ? finnhubRaw.value : []),
        ...(polygonRaw.status === 'fulfilled' ? polygonRaw.value : []),
        ...(xRaw.status === 'fulfilled' ? xRaw.value : []),
      ];

      if (combined.length === 0) {
        setError(
          !FINNHUB_KEY && !POLYGON_KEY
            ? 'Add a news source key, or configure X_BEARER_TOKEN and add X accounts.'
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
      writeCache(finalItems, sourceKey);
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

    // Serve from cache immediately so the calendar shows without waiting for network
    const cached = readCalendarCache(safeTimeZone);
    if (cached) {
      setCalendar(cached.events);
      setCalendarIsToday(cached.isToday);
    }

    try {
      const calendarResult = await fetchForexFactoryCalendar(safeTimeZone, weeksAhead);
      if (calendarResult.events.length > 0) {
        writeCalendarCache(calendarResult, safeTimeZone);
        setCalendar(calendarResult.events);
        setCalendarIsToday(calendarResult.isToday);
      }
    } catch {
      // Network failed — cached data already applied above
      if (!cached) {
        setCalendar([]);
        setCalendarIsToday(true);
      }
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

  // When the user navigates forward, re-fetch on the first visit to each new
  // week offset. Starting at 0 ensures offset=1 (next week) always triggers a
  // fresh pull — the FF feeds often don't publish next week's data until
  // Saturday, so the initial 4-week load may return empty for next week.
  const loadedWeeksAheadRef = useRef(0);
  useEffect(() => {
    if (calendarWeekOffset <= 0) return;
    const neededWeeks = calendarWeekOffset + 2; // pad by 2 extra weeks
    if (neededWeeks <= loadedWeeksAheadRef.current) return;
    loadedWeeksAheadRef.current = neededWeeks;
    fetchSidebar(neededWeeks);
  }, [calendarWeekOffset, fetchSidebar]);

  const handlePrefsChange = (next: SourcePrefs) => {
    const normalized = {
      ...next,
      xAccounts: normalizeXAccounts(next.xAccounts, next.xUsernames),
    };
    normalized.xUsernames = getEnabledXUsernames(normalized);
    setPrefs(normalized);
    writeSourcePrefs(normalized);
  };

  const addXAccountsFromDraft = () => {
    const currentAccounts = normalizeXAccounts(prefs.xAccounts, prefs.xUsernames);
    const existingEnabledByUsername = new Map(currentAccounts.map(account => [account.username, account.enabled] as const));
    const nextAccounts = Array.from(new Set([
      ...currentAccounts.map(account => account.username),
      ...parseXUsernames(xAccountDraft),
    ])).slice(0, 10).map(username => ({
      username,
      enabled: existingEnabledByUsername.get(username) ?? true,
    }));
    if (nextAccounts.length !== currentAccounts.length) {
      handlePrefsChange({ ...prefs, xAccounts: nextAccounts });
    }
    setXAccountDraft('');
  };

  const toggleXAccount = (username: string, enabled: boolean) => {
    handlePrefsChange({
      ...prefs,
      xAccounts: normalizeXAccounts(prefs.xAccounts, prefs.xUsernames).map(account => (
        account.username === username ? { ...account, enabled } : account
      )),
    });
  };

  const removeXAccount = (username: string) => {
    const nextAccounts = normalizeXAccounts(prefs.xAccounts, prefs.xUsernames).filter(account => account.username !== username);
    handlePrefsChange({ ...prefs, xAccounts: nextAccounts });
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
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0, overflow: 'hidden', fontFamily: SANS, background: PAGE_BG }}>
      <div style={{ padding: '10px 16px 8px', borderBottom: `1px solid ${BORDER}`, background: PAGE_BG, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.1em', color: AMBER, fontFamily: MONO }}>FLYXA</span>
            <span style={{ width: 1, height: 14, background: BORDER, flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: T1 }}>Market Intelligence</span>
            {!isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 8 }}>
                {[
                  { label: 'BREAK', value: breakingCount, color: RED },
                  { label: 'HIGH', value: highCount, color: AMBER },
                  { label: 'CAL', value: highCalendarCount, color: COBALT },
                ].map((stat) => (
                  <span key={stat.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: T3, fontFamily: MONO }}>
                    {stat.label}
                    <span style={{ color: stat.value > 0 ? stat.color : T3, fontWeight: 700, fontSize: 11 }}>{stat.value}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            {!isMobile && lastRefresh && <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>↻ {fmtRelative(lastRefresh.toISOString())}</span>}
            <button
              onClick={() => { void fetchNews(true); void fetchSidebar(); }}
              disabled={loading}
              style={{
                height: 26,
                borderRadius: 4,
                border: `1px solid ${loading ? COBALT_BORDER : BORDER}`,
                background: 'transparent',
                color: loading ? COBALT : T3,
                padding: '0 8px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 10,
                fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: MONO,
              }}
            >
              <RefreshCw size={11} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
              {loading ? 'LOADING' : 'REFRESH'}
            </button>
          </div>
        </div>

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: isMobile ? 'nowrap' : 'wrap' }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
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

      {isMobile && (
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setSidebarOpen(o => !o)}
            style={{ height: 28, borderRadius: 6, border: `1px solid ${sidebarOpen ? AMBER : BORDER}`, background: sidebarOpen ? AMBER : S2, color: sidebarOpen ? '#000' : T2, padding: '0 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5, transition: 'background .12s, color .12s' }}
          >
            <Filter size={11} />
            {sidebarOpen ? 'Hide calendar' : 'Calendar & Sources'}
          </button>
        </div>
      )}

      <div
        className="mn-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(360px, 0.68fr) minmax(380px, 0.32fr)',
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          maxWidth: '100%',
          width: '100%',
          overflow: isMobile ? 'auto' : 'hidden',
          gap: 0,
        }}
      >
        <main className="mn-feed" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 10px 14px' }}>
          <div style={{ padding: '10px 14px 8px', borderBottom: `1px solid rgba(255,255,255,0.09)`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: T3, borderLeft: `2px solid ${AMBER}`, paddingLeft: 10 }}>News Feed</span>
            {displayed.length > 0 && <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{displayed.length} {displayed.length === 1 ? 'story' : 'stories'}</span>}
          </div>
          {topBreaking && (
            <div style={{ margin: '8px 0 0', padding: '8px 14px', borderBottom: `1px solid ${RED_BORDER}`, background: 'rgba(239,68,68,0.07)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.1em', color: RED, fontFamily: MONO, flexShrink: 0, paddingTop: 2 }}>⚡ BREAKING</span>
              <span style={{ fontSize: 13, color: '#fff', fontWeight: 600, flex: 1 }}>{topBreaking.headline}</span>
              <span style={{ fontSize: 9, color: T3, fontFamily: MONO, flexShrink: 0, paddingTop: 2 }}>{fmtRelative(topBreaking.timestamp)}</span>
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

          <div style={{ marginTop: 10 }}>
            {displayed.map((item, index) => (
              <NewsCard key={`${item.headline}-${index}`} item={item} />
            ))}
          </div>
          </div>
        </main>

        {/* Mobile backdrop */}
        {isMobile && sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 199, background: 'rgba(0,0,0,0.45)' }}
          />
        )}

        <aside
          className="mn-sidebar"
          style={isMobile ? {
            position: 'fixed',
            right: 0,
            top: 0,
            bottom: 0,
            width: 'min(320px, 92vw)',
            zIndex: 200,
            background: S2,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: 16,
            borderLeft: `1px solid rgba(255,255,255,0.10)`,
            transform: sidebarOpen ? 'translateX(0)' : 'translateX(100%)',
            transition: 'transform 0.22s ease',
          } : {
            width: '100%',
            minWidth: 0,
            borderLeft: `1px solid rgba(255,255,255,0.10)`,
            background: S2,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: 16,
          }}
        >
          {isMobile && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: `1px solid ${BORDER}`, background: 'transparent', color: T2, cursor: 'pointer' }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <div style={{ display: 'grid', gap: 0 }}>
            <CalendarPanel
                events={calendar}
                isToday={calendarIsToday}
                impactSelection={calendarImpactSelection}
                onImpactSelectionChange={setCalendarImpactSelection}
                displayTimezone={preferences.timezone}
                weekOffset={calendarWeekOffset}
                onWeekOffsetChange={setCalendarWeekOffset}
              />
            <SourcesPanel
              prefs={prefs}
              onChange={handlePrefsChange}
              onOpenXAccounts={() => setXAccountsModalOpen(true)}
            />
          </div>
        </aside>
      </div>

      <XAccountsModal
        isOpen={xAccountsModalOpen}
        onClose={() => setXAccountsModalOpen(false)}
        prefs={prefs}
        xDraft={xAccountDraft}
        onXDraftChange={setXAccountDraft}
        onXAdd={addXAccountsFromDraft}
        onXToggle={toggleXAccount}
        onXRemove={removeXAccount}
      />

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @media (max-width: 1200px) {
          .mn-grid {
            grid-template-columns: 1fr !important;
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
              background: active ? AMBER : 'transparent',
              color: active ? '#000' : T2,
              padding: '0 9px',
              fontSize: 11,
              fontWeight: active ? 700 : 600,
              cursor: 'pointer',
              transition: 'background .12s, color .12s',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}









