import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Filter,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  X,
} from 'lucide-react';
import { aiApi, marketDataApi, supabase, NewsFilterItem } from '../services/api.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import Modal from '../components/common/Modal.js';
import {
  DEFAULT_CALENDAR_TIME_ZONE,
  FEED_CALENDAR_TIME_ZONE,
  calendarTimeZoneLabel,
  convertCalendarWallTime,
  getTimeZoneParts,
  normalizeCalendarTimeZone,
  zonedWallTimeToDate,
} from '../utils/calendarTime.js';
import { CALENDAR_CACHE_KEY } from '../utils/calendarCache.js';
import { DEFAULT_HOT_KEYWORDS, buildHotRegex, normalizeHotKeywords, parseHotKeywords } from '../utils/newsKeywords.js';

const PAGE_BG = 'var(--app-panel)';
const S1 = 'var(--app-panel)';
const S2 = 'var(--app-panel-strong)';
const BORDER = 'var(--app-border)';
const AMBER = 'var(--amber)';
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
const NEWS_API_URL = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:3001';

// Instant risk classification for live-pushed headlines — no waiting for the
// AI filter. Anything matching the user's breaking-keyword list (Sources
// panel; defaults in utils/newsKeywords.ts) gets BREAKING treatment the
// second it lands.
const POLYGON_KEY = import.meta.env.VITE_POLYGON_KEY as string | undefined;
// X posts need a funded X developer account (~$360/mo at current pricing).
// Locked in the UI until that ever makes sense — flip this to re-enable.
const X_SOURCE_ENABLED = false;
const CACHE_KEY = 'flyxa_news_cache_v2';
const SOURCES_KEY = 'flyxa_news_sources';
const CACHE_TTL = 15 * 60 * 1000;
const CALENDAR_CACHE_TTL = 12 * 60 * 60 * 1000;
// Same-minute headlines: the server's RSS cache holds ~55s, so each tick here
// can pick up a fresh batch. The AI filter is skipped when the headline set is
// unchanged, so the faster loop doesn't multiply Claude costs.
const REFRESH_INTERVAL = 60 * 1000;
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
  rss: boolean;
  xUsernames: string;
  xAccounts: XAccountPref[];
  economicCalendar: boolean;
  calendarCurrencies: string[];
  aiFilter: boolean;
  hotKeywords: string[];
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

function readCalendarCache(timeZone: string, currenciesKey = 'USD'): CalendarResult | null {
  try {
    const raw = localStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CalendarCache> & { currencies?: string };
    if (parsed.timeZone !== timeZone) return null;
    if ((parsed.currencies ?? 'USD') !== currenciesKey) return null;
    if (typeof parsed.fetchedAt !== 'number' || Date.now() - parsed.fetchedAt > CALENDAR_CACHE_TTL) return null;
    if (!Array.isArray(parsed.events) || parsed.events.length === 0) return null;
    return { events: parsed.events as CalendarEvent[], isToday: parsed.isToday === true, fullRange: (parsed as { fullRange?: boolean }).fullRange === true };
  } catch {
    return null;
  }
}

function writeCalendarCache(result: CalendarResult, timeZone: string, currenciesKey = 'USD') {
  if (!result.events.length) return;
  try {
    localStorage.setItem(CALENDAR_CACHE_KEY, JSON.stringify({
      events: result.events,
      fetchedAt: Date.now(),
      isToday: result.isToday,
      fullRange: result.fullRange === true,
      currencies: currenciesKey,
      timeZone,
    }));
  } catch {
    // ignore storage failures
  }
}

function readSourcePrefs(): SourcePrefs {
  const defaults: SourcePrefs = { finnhub: true, polygon: false, x: true, rss: true, xUsernames: '', xAccounts: [], economicCalendar: true, calendarCurrencies: ['USD'], aiFilter: true, hotKeywords: [...DEFAULT_HOT_KEYWORDS] };
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
      rss: parsed.rss ?? defaults.rss,
      calendarCurrencies: normalizeCalendarCurrencies(parsed.calendarCurrencies),
      xUsernames,
      xAccounts,
      economicCalendar: parsed.economicCalendar ?? defaults.economicCalendar,
      aiFilter: parsed.aiFilter ?? defaults.aiFilter,
      hotKeywords: parsed.hotKeywords === undefined ? defaults.hotKeywords : normalizeHotKeywords(parsed.hotKeywords),
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

interface CalendarResult { events: CalendarEvent[]; isToday: boolean; fullRange?: boolean }

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

// Currencies the calendar can be personalized to — matches what the FF feed tags.
const CALENDAR_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY'] as const;

function normalizeCurrencyCode(value: unknown): string {
  const text = String(value ?? '').trim().toUpperCase();
  if (['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'].includes(text)) return 'USD';
  return text;
}

function normalizeCalendarCurrencies(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.map(normalizeCurrencyCode).filter(code => (CALENDAR_CURRENCIES as readonly string[]).includes(code))
    : [];
  return list.length > 0 ? Array.from(new Set(list)) : ['USD'];
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
  allowedCurrencies: string[] = ['USD'],
): CalendarResult {
  const events: CalendarEvent[] = [];
  const allowed = new Set(allowedCurrencies.map(normalizeCurrencyCode));
  let lastDate = '';
  let lastCurrency = '';

  raw.forEach((event) => {
    const rawCurrency = String(event.country ?? event.currency ?? '').trim().toUpperCase();
    if (rawCurrency) lastCurrency = rawCurrency;
    const cc = normalizeCurrencyCode(rawCurrency || lastCurrency);

    const parsedDate = normalizeForexFactoryDate(event.date);
    if (parsedDate) lastDate = parsedDate;
    const date = parsedDate || lastDate;

    if (!date) return;
    if (!allowed.has(cc)) return;

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
      country: cc,
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
async function fetchForexFactoryCalendar(
  timeZone = DEFAULT_CALENDAR_TIME_ZONE,
  weeksAhead = 4,
  currencies: string[] = ['USD'],
): Promise<CalendarResult> {
  const safeTimeZone = normalizeCalendarTimeZone(timeZone);
  const usdOnly = currencies.length === 1 && currencies[0] === 'USD';
  const now = new Date();
  const todaySlice = getTimeZoneParts(now, safeTimeZone).date;
  // Fetch from the start of last week through (weeksAhead) weeks ahead so
  // prev-week and multi-week-ahead navigation works without a re-fetch.
  const thisWeekStart = startOfWeekMonday(parseDateSlice(todaySlice));
  const fromSlice = toDateSlice(addDays(thisWeekStart, -7));                    // prev week Monday
  const endSlice  = toDateSlice(addDays(thisWeekStart, Math.max(28, weeksAhead * 7))); // at least 4 weeks

  // Full-range calendar via the backend proxy (FMP key lives server-side).
  // Empty response = proxy unconfigured or FMP down — fall through to FF feeds.
  // FMP path is USD-only, so it's skipped when the user personalizes currencies.
  if (usdOnly) {
    try {
      const raw = await marketDataApi.getEconCalendar(fromSlice, endSlice) as unknown as FMPCalEvent[];
      if (Array.isArray(raw) && raw.length > 0) {
        {
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
            return { events, isToday: hasToday, fullRange: true };
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
      const normalized = normalizeForexFactoryEvents(ffRaw as ForexFactoryRawEvent[], todaySlice, safeTimeZone, FEED_CALENDAR_TIME_ZONE, currencies);
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
      return normalizeForexFactoryEvents(combined as ForexFactoryRawEvent[], todaySlice, safeTimeZone, FEED_CALENDAR_TIME_ZONE, currencies);
    }
  } catch {
    // ignore
  }

  return { events: [], isToday: true };
}
// Keyword floor for severity — keeps the tape's ticks meaningful even when
// the AI filter is skipped or returns nothing (raw fallback mode).
const MED_NEWS_RE = /\b(oil|crude|opec|earnings|stocks?|shares|indexes?|market|yields?|treasury|dollar|euro|gold|bitcoin|gdp|jobs|unemployment|blockade|ceasefire|troops|houthis?|iran|china|recession|deficit|bond)\b/i;

function keywordImpact(headline: string, hotRe: RegExp | null): ImpactLevel {
  if (hotRe?.test(headline)) return 'high';
  if (MED_NEWS_RE.test(headline)) return 'medium';
  return 'low';
}

const IMPACT_ORDER: Record<ImpactLevel, number> = { high: 2, medium: 1, low: 0 };

function maxImpact(a: ImpactLevel, b: ImpactLevel): ImpactLevel {
  return IMPACT_ORDER[a] >= IMPACT_ORDER[b] ? a : b;
}

function rawToNewsItem(raw: RawHeadline, hotRe: RegExp | null): NewsFilterItem {
  return {
    headline: raw.headline,
    summary: raw.summary || '',
    impact: keywordImpact(raw.headline, hotRe),
    category: 'Other',
    marketImpact: { es: 'neutral', nq: 'neutral' },
    isBreaking: false,
    source: raw.source,
    timestamp: raw.timestamp,
    url: raw.url,
  };
}

// Tape-row source colors — deterministic per source name so the eye can
// pattern-match a feed the way Tree News readers do.
const TAPE_SOURCE_PALETTE = ['#7db8ff', '#f5c86e', '#8de0b7', '#c8a6ff', '#7fd8e0', '#f0a3a3'];
function tapeSourceColor(source: string): string {
  let hash = 0;
  for (let i = 0; i < source.length; i++) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  return TAPE_SOURCE_PALETTE[hash % TAPE_SOURCE_PALETTE.length];
}

// Tape timestamps render in market time (ET) so they line up with the
// header market clock instead of the viewer's local timezone, and follow
// the same 12h/24h preference as that clock.
function fmtClock(timestamp: string, format: '12h' | '24h' = '12h'): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return '--:--:--';
  const hour12 = format !== '24h';
  try {
    return parsed.toLocaleTimeString(hour12 ? 'en-US' : 'en-GB', {
      timeZone: 'America/New_York',
      hour12,
      hour: hour12 ? 'numeric' : '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    const two = (n: number) => String(n).padStart(2, '0');
    return `${two(parsed.getHours())}:${two(parsed.getMinutes())}:${two(parsed.getSeconds())}`;
  }
}

// ET calendar date for a timestamp — used to group the tape by trading day.
function etDateSlice(timestamp: string): string | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  try {
    return parsed.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

// TODAY / YESTERDAY / "MON JUL 21" labels for the tape's day separators.
function etDayLabel(slice: string): string {
  const today = etDateSlice(new Date().toISOString());
  if (slice === today) return 'TODAY';
  const yesterday = etDateSlice(new Date(Date.now() - 86400000).toISOString());
  if (slice === yesterday) return 'YESTERDAY';
  const parsed = new Date(`${slice}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return slice;
  return parsed
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .toUpperCase();
}

// Wall-clock time in a timezone -> UTC epoch ms (same math as the dashboard's
// calendar snippet, so both agree on when an event has passed).
function wallTimeToUtcMs(dateSlice: string, timeHHMM: string, tz: string): number | null {
  try {
    const [yearS, monthS, dayS] = dateSlice.split('-');
    const [hourS, minuteS] = timeHHMM.split(':');
    const year = Number(yearS), month = Number(monthS), day = Number(dayS);
    const hour = Number(hourS), minute = Number(minuteS);
    if ([year, month, day, hour, minute].some(Number.isNaN)) return null;
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcGuess));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
    const shownAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return utcGuess - (shownAsUtc - utcGuess);
  } catch {
    return null;
  }
}

// Re-render a normalized 24h HH:MM string per the clock-format preference.
function applyClockFormat(hhmm: string, format: '12h' | '24h'): string {
  if (format === '24h' || !/^\d{2}:\d{2}$/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  const meridiem = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${meridiem}`;
}

// Wire headlines often end in "– Reuters" while the source tag already says
// REUTERS — strip the redundant suffix for display.
function stripSourceSuffix(headline: string, source: string): string {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return headline.replace(new RegExp(`\\s*[–—-]\\s*${escaped}\\s*$`, 'i'), '');
}

const normalizeForCompare = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

// One dense tape row — time, source, headline. The Tree News idiom:
// chronology is the layout, impact is the color.
function NewsCard({ item }: { item: NewsFilterItem }) {
  const { preferences } = useAppSettings();
  const clockFormat = preferences.clockFormat ?? '12h';
  const [expanded, setExpanded] = useState(false);
  // A summary only counts as detail when it genuinely says more than the
  // headline — wire summaries are frequently the headline minus punctuation.
  const summaryAddsInfo = Boolean(
    item.summary
    && !normalizeForCompare(item.headline).includes(normalizeForCompare(item.summary))
    && !normalizeForCompare(item.summary).includes(normalizeForCompare(item.headline))
  );
  const hasDetail = Boolean(item.marketImpact?.note || summaryAddsInfo);
  const combined = combinedSentiment(item.marketImpact?.es, item.marketImpact?.nq);
  const hot = item.isBreaking || item.impact === 'high';
  const headlineColor = item.isBreaking ? RED : item.impact === 'high' ? '#ffffff' : item.impact === 'medium' ? T1 : T2;
  const displayHeadline = stripSourceSuffix(item.headline, item.source);

  // Left-edge severity tick — scannable down the whole tape at a glance:
  // red = breaking, amber = high impact, faint amber = medium, none = low.
  const impactTick = item.isBreaking ? RED
    : item.impact === 'high' ? AMBER
    : item.impact === 'medium' ? 'rgba(245,158,11,0.45)'
    : 'transparent';

  return (
    <article
      style={{
        padding: '6px 14px 6px 11px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        borderLeft: `3px solid ${impactTick}`,
        cursor: item.url || hasDetail ? 'pointer' : 'default',
        transition: 'background .08s',
        background: item.isBreaking ? 'rgba(239,68,68,0.06)' : 'transparent',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = item.isBreaking ? 'rgba(239,68,68,0.10)' : 'rgba(255,255,255,0.03)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = item.isBreaking ? 'rgba(239,68,68,0.06)' : 'transparent'; }}
      onClick={() => {
        if (hasDetail) setExpanded(v => !v);
        else if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <span style={{ flexShrink: 0, fontFamily: MONO, fontSize: 10.5, color: hot ? T1 : T3, fontVariantNumeric: 'tabular-nums' }}>
          {fmtClock(item.timestamp, clockFormat)}
        </span>
        {/* Explicit impact word — no color-decoding required */}
        <span style={{
          flexShrink: 0, width: 34, fontFamily: MONO, fontSize: 8.5, fontWeight: 500,
          letterSpacing: '0.08em',
          color: item.isBreaking ? RED : item.impact === 'high' ? AMBER : item.impact === 'medium' ? 'rgba(245,158,11,0.55)' : 'transparent',
        }}>
          {item.isBreaking ? 'BRK' : item.impact === 'high' ? 'HIGH' : item.impact === 'medium' ? 'MED' : '·'}
        </span>
        <span style={{
          flexShrink: 0, fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: tapeSourceColor(item.source), minWidth: 74,
        }}>
          {item.source}
        </span>
        <p style={{
          margin: 0, flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5,
          color: headlineColor, fontWeight: hot ? 500 : 400, letterSpacing: '0.01em',
        }}>
          {item.isBreaking && <span style={{ marginRight: 6, fontSize: 9, fontWeight: 500, letterSpacing: '0.1em', color: RED }}>BREAKING</span>}
          {displayHeadline}
        </p>
        {/* Sentiment only when there IS one — a terminal doesn't print "neutral" */}
        {(combined.label === 'bullish' || combined.label === 'bearish' || combined.label === 'mixed') && (
          <span style={{ flexShrink: 0, fontSize: 9, fontFamily: MONO, color: combined.color, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 500 }}>
            {combined.label}
          </span>
        )}
        {item.url && (
          <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
            style={{ color: T3, lineHeight: 0, flexShrink: 0, alignSelf: 'center' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = COBALT; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = T3; }}>
            <ExternalLink size={11} />
          </a>
        )}
      </div>

      {expanded && hasDetail && (
        <div style={{ margin: '6px 0 2px 66px', paddingLeft: 10, borderLeft: '2px solid rgba(255,255,255,0.08)' }}>
          {summaryAddsInfo && (
            <p style={{ margin: 0, color: T2, fontSize: 11.5, lineHeight: 1.55 }}>{item.summary}</p>
          )}
          {item.marketImpact?.note && (
            <p style={{ margin: summaryAddsInfo ? '5px 0 0' : 0, color: AMBER, fontSize: 11, lineHeight: 1.5 }}>{item.marketImpact.note}</p>
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
  const containerRef = useRef<HTMLDivElement>(null);
  const options: Array<{ key: ImpactLevel; label: string }> = [
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
  ];

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
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
          fontWeight: 600,
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

// Currency personalization — pick which economies' events the calendar tracks.
function CalendarCurrencyButton({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = new Set(value);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        aria-label="Choose calendar currencies"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
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
          fontFamily: MONO,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.05em',
          cursor: 'pointer',
        }}
      >
        {value.length <= 2 ? value.join(' ') : `${value[0]} +${value.length - 1}`}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 32,
            right: 0,
            zIndex: 20,
            width: 132,
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            background: S1,
            boxShadow: '0 12px 28px rgba(0,0,0,0.35)',
            padding: 6,
          }}
        >
          {CALENDAR_CURRENCIES.map(code => {
            const checked = selected.has(code);
            return (
              <label
                key={code}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '6px 6px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: checked ? T1 : T2,
                  fontFamily: MONO,
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.05em',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={event => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(code);
                    else next.delete(code);
                    // Never allow zero currencies — the calendar would go blank.
                    const list = CALENDAR_CURRENCIES.filter(c => next.has(c));
                    onChange(list.length > 0 ? list : ['USD']);
                  }}
                  style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
                />
                <span aria-hidden style={{
                  width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                  border: `1px solid ${checked ? AMBER : BORDER}`,
                  background: checked ? AMBER : 'transparent',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {checked && <span style={{ fontSize: 8, lineHeight: 1, color: '#161310', fontWeight: 700 }}>✓</span>}
                </span>
                {code}
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
  currencies,
  onCurrenciesChange,
  displayTimezone,
  weekOffset,
  onWeekOffsetChange: setWeekOffset,
}: {
  events: CalendarEvent[];
  isToday: boolean;
  impactSelection: CalendarImpactSelection;
  onImpactSelectionChange: (value: CalendarImpactSelection) => void;
  currencies: string[];
  onCurrenciesChange: (value: string[]) => void;
  displayTimezone: string;
  weekOffset: number;
  onWeekOffsetChange: (offset: number | ((prev: number) => number)) => void;
}) {
  const { preferences } = useAppSettings();
  const clockFormat = preferences.clockFormat ?? '12h';
  const safeDisplayTimezone = normalizeCalendarTimeZone(displayTimezone);
  const todaySlice = getTimeZoneParts(new Date(), safeDisplayTimezone).date;
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
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.12em', color: T1 }}>
            Economic Calendar
          </span>
          {weekOffset === 0 && (
            <span style={{ fontSize: 8.5, letterSpacing: '.1em', color: isToday ? GREEN : T3, fontFamily: MONO }}>
              {isToday ? '● LIVE' : '○ STALE'}
            </span>
          )}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <CalendarCurrencyButton value={currencies} onChange={onCurrenciesChange} />
          <CalendarImpactFilterButton value={impactSelection} onChange={onImpactSelectionChange} />
        </div>
      </div>

      {/* Week nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, padding: '0 14px' }}>
        <span style={{ fontSize: 9.5, letterSpacing: '.06em', color: T3, fontFamily: MONO, textTransform: 'uppercase' }}>
          {formatWeekRange(weekStart)} · {currencies.length <= 3 ? currencies.join(' ') : `${currencies.length} currencies`}
          {' · '}
          <span title={`Event times are shown in ${safeDisplayTimezone}`}>
            {calendarTimeZoneLabel(safeDisplayTimezone)}
          </span>
        </span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          {[
            { label: '‹', action: () => setWeekOffset(c => c - 1), active: false },
            { label: 'TODAY', action: () => setWeekOffset(0), active: weekOffset === 0 },
            { label: '›', action: () => setWeekOffset(c => c + 1), active: false },
          ].map(btn => (
            <button
              key={btn.label}
              type="button"
              onClick={btn.action}
              style={{
                height: 21,
                borderRadius: 4,
                border: `1px solid ${btn.active ? AMBER : BORDER}`,
                background: btn.active ? AMBER : 'transparent',
                color: btn.active ? '#161310' : T3,
                padding: '0 7px',
                fontFamily: MONO,
                fontSize: btn.label.length > 1 ? 8.5 : 11,
                letterSpacing: btn.label.length > 1 ? '0.08em' : undefined,
                fontWeight: 500,
                cursor: 'pointer',
                lineHeight: 1,
                transition: 'border-color .12s, color .12s, background .12s',
              }}
            >
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
        <p style={{ margin: 0, color: T3, fontSize: 11, lineHeight: 1.6, padding: '0 14px' }}>
          {weekOffset > 0 ? 'Not published yet.' : 'No events for this week.'}
        </p>
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
                <span style={{ fontSize: 10, fontWeight: 600, color: date === todaySlice ? COBALT : AMBER, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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
                  // Released or past its scheduled time -> struck out and dimmed,
                  // matching the dashboard's calendar treatment.
                  const normTime = fmtFFTime(event.time);
                  const eventMs = /^\d{2}:\d{2}$/.test(normTime)
                    ? wallTimeToUtcMs(event.date, normTime, safeDisplayTimezone)
                    : null;
                  const hasPassed = hasActual || (eventMs !== null ? eventMs <= Date.now() : event.date < todaySlice);
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
                        background: isHigh && !hasPassed ? 'rgba(239,68,68,0.04)' : 'transparent',
                        opacity: hasPassed ? 0.42 : 1,
                        transition: 'background .1s, opacity .2s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = isHigh && !hasPassed ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isHigh && !hasPassed ? 'rgba(239,68,68,0.04)' : 'transparent'; }}
                    >
                      <span style={{ fontFamily: MONO, fontSize: 12, color: T2, fontWeight: 500 }}>{applyClockFormat(normTime, clockFormat)}</span>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: impDot, flexShrink: 0, boxShadow: isHigh && !hasPassed ? `0 0 5px ${RED}` : 'none' }} />
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: 12, color: isHigh ? '#fff' : T1, fontWeight: isHigh ? 600 : 450, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', display: 'block', textDecoration: hasPassed ? 'line-through' : 'none', textDecorationColor: 'rgba(255,255,255,0.25)' }}>
                          {currencies.length > 1 && event.country && (
                            <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 500, letterSpacing: '0.06em', color: T3, marginRight: 6 }}>
                              {event.country}
                            </span>
                          )}
                          {event.event}
                        </span>
                        {(event.forecast || event.previous) && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                            {event.forecast && <span style={{ fontSize: 9, color: T3, fontFamily: MONO }}>F: <span style={{ color: T2 }}>{event.forecast}</span></span>}
                            {event.previous && <span style={{ fontSize: 9, color: T3, fontFamily: MONO }}>P: <span style={{ color: T2 }}>{event.previous}</span></span>}
                            {!hasActual && <span style={{ fontSize: 9, color: T3, fontFamily: MONO }}>pending</span>}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        {hasActual && <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 500, color: aColor }}>{event.actual}</span>}
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
  // Local draft so typing a keyword list doesn't rewrite prefs per keystroke.
  const [keywordsDraft, setKeywordsDraft] = useState(prefs.hotKeywords.join(', '));
  const [keywordsOpen, setKeywordsOpen] = useState(false);
  useEffect(() => { setKeywordsDraft(prefs.hotKeywords.join(', ')); }, [prefs.hotKeywords]);
  const commitKeywords = () => {
    const parsed = parseHotKeywords(keywordsDraft);
    onChange({ ...prefs, hotKeywords: parsed });
  };

  return (
    <section style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 14, marginTop: 14 }}>
      <p
        style={{
          margin: '0 0 10px',
          fontSize: 10,
          color: T2,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontWeight: 600,
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
          { key: 'rss', label: 'Live Wire', note: 'Tree News push · ForexLive · MarketWatch · CNBC · FXStreet · Investing.com · Fed · BLS' },
          { key: 'finnhub', label: 'Finnhub', note: 'Requires VITE_FINNHUB_KEY' },
          { key: 'x', label: 'X accounts', note: 'Not available yet' },
          { key: 'economicCalendar', label: 'Economic Calendar', note: '' },
          { key: 'aiFilter', label: 'AI Filter', note: '' },
        ] as const).map(source => {
          const available =
            source.key === 'finnhub'
              ? Boolean(FINNHUB_KEY)
              : source.key === 'x'
                ? X_SOURCE_ENABLED
                : true;
          const active = prefs[source.key] && available;
          return (
            <label
              key={source.key}
              title={!available && source.note ? source.note : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 9,
                padding: '3px 0',
                cursor: available ? 'pointer' : 'not-allowed',
                opacity: available ? 1 : 0.45,
              }}
            >
              <input
                type="checkbox"
                checked={active}
                disabled={!available}
                onChange={event => onChange({ ...prefs, [source.key]: event.target.checked })}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }}
              />
              <span aria-hidden style={{
                width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                border: `1px solid ${active ? AMBER : BORDER}`,
                background: active ? AMBER : 'transparent',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                transition: 'border-color .12s, background .12s',
              }}>
                {active && <span style={{ fontSize: 9, lineHeight: 1, color: '#161310', fontWeight: 700 }}>✓</span>}
              </span>
              <span style={{ fontSize: 11.5, color: active ? T1 : T2 }}>{source.label}</span>
              {!available && (
                <span style={{ marginLeft: 'auto', fontSize: 8.5, color: T3, fontFamily: MONO, letterSpacing: '0.08em' }}>
                  {source.key === 'x' ? 'COMING SOON' : 'KEY REQUIRED'}
                </span>
              )}
            </label>
          );
        })}
      </div>

      {/* Breaking keywords — the instant-BREAKING trigger list. Headlines
          matching any of these go red the moment they land, before the AI
          filter returns. */}
      <div style={{ marginTop: 12, borderTop: `1px solid ${BORDER}`, padding: '10px 14px 0' }}>
        <button
          type="button"
          onClick={() => setKeywordsOpen(open => !open)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          }}
        >
          <span style={{ fontSize: 11.5, color: T1 }}>Breaking keywords</span>
          <span style={{ fontSize: 8.5, color: T3, fontFamily: MONO, letterSpacing: '0.08em' }}>
            {prefs.hotKeywords.length === 0 ? 'OFF' : `${prefs.hotKeywords.length} TERMS`} {keywordsOpen ? '▾' : '▸'}
          </span>
        </button>
        {keywordsOpen && (
          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            <textarea
              value={keywordsDraft}
              onChange={event => setKeywordsDraft(event.target.value)}
              onBlur={commitKeywords}
              rows={4}
              spellCheck={false}
              placeholder="fed, cpi, tariff, opec…"
              style={{
                width: '100%', resize: 'vertical', borderRadius: 6,
                border: `1px solid ${BORDER}`, background: S2, color: T1,
                fontSize: 11, fontFamily: MONO, lineHeight: 1.6, padding: '8px 10px',
                outline: 'none',
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 9.5, color: T3, lineHeight: 1.5 }}>
                Comma-separated. Matching headlines turn red instantly, ahead of the AI filter.
              </span>
              <button
                type="button"
                onClick={() => onChange({ ...prefs, hotKeywords: [...DEFAULT_HOT_KEYWORDS] })}
                style={{
                  flexShrink: 0, background: 'none', border: `1px solid ${BORDER}`, borderRadius: 5,
                  color: T2, fontSize: 9.5, padding: '3px 8px', cursor: 'pointer',
                }}
              >
                Reset defaults
              </button>
            </div>
          </div>
        )}
      </div>
      {X_SOURCE_ENABLED && (
        <div style={{ marginTop: 12, borderTop: `1px solid ${BORDER}`, paddingTop: 10, padding: '10px 14px 0' }}>
          <button
            type="button"
            onClick={onOpenXAccounts}
            style={{
              width: '100%',
              minHeight: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              borderRadius: 7,
              border: `1px solid ${BORDER}`,
              background: S2,
              padding: '0 11px',
              cursor: 'pointer',
              fontFamily: SANS,
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <Plus size={12} style={{ color: T3, flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, fontWeight: 600, color: T1 }}>Manage X accounts</span>
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
              <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.08em', color: T3 }}>{enabledCount} ACTIVE</span>
              <ChevronDown size={13} style={{ color: T3 }} />
            </span>
          </button>
        </div>
      )}
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
              <p style={{ margin: 0, color: T1, fontSize: 17, fontWeight: 600 }}>X accounts</p>
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
                <span style={{ color: T3, fontSize: 11, fontWeight: 600 }}>{stat.label}</span>
                <span style={{ color: T1, fontSize: 13, fontWeight: 600 }}>{stat.value}</span>
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
                fontWeight: 600,
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
                      fontWeight: 600,
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
  // Headline fingerprint of the last processed batch — lets the 60s refresh
  // loop skip the AI filter (and a re-render) when nothing actually changed.
  const lastBatchKeyRef = useRef('');
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
  // The SSE handler lives in a []-dep effect; a ref keeps its keyword regex
  // current without tearing the socket down on every prefs edit.
  const hotRegexRef = useRef<RegExp | null>(buildHotRegex(prefs.hotKeywords));
  useEffect(() => { hotRegexRef.current = buildHotRegex(prefs.hotKeywords); }, [prefs.hotKeywords]);
  const [xAccountDraft, setXAccountDraft] = useState('');
  const [xAccountsModalOpen, setXAccountsModalOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Archive search — a query also hits the server-side headline archive so
  // results reach past the ~60-item live tape ("what did Powell say Tuesday").
  const [archiveResults, setArchiveResults] = useState<NewsFilterItem[]>([]);
  const [archiveState, setArchiveState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle');
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setArchiveResults([]);
      setArchiveState('idle');
      return;
    }
    setArchiveState('loading');
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const { items: rows, available } = await marketDataApi.searchNewsArchive(q, 80);
        if (cancelled) return;
        if (!available) {
          setArchiveResults([]);
          setArchiveState('unavailable');
          return;
        }
        setArchiveResults(rows.map(row => ({
          headline: row.headline,
          summary: '',
          impact: row.impact === 'high' || row.impact === 'medium' || row.impact === 'low' ? row.impact : 'low',
          category: 'Archive',
          marketImpact: { es: 'neutral', nq: 'neutral' },
          isBreaking: row.is_breaking,
          source: row.source,
          timestamp: row.published_at,
          url: row.url ?? undefined,
        })));
        setArchiveState('ready');
      } catch {
        if (!cancelled) {
          setArchiveResults([]);
          setArchiveState('unavailable');
        }
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);
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
      const [finnhubRaw, polygonRaw, xRaw, rssRaw] = await Promise.allSettled([
        prefs.finnhub ? fetchFinnhubNews() : Promise.resolve([]),
        prefs.polygon ? fetchPolygonNews() : Promise.resolve([]),
        X_SOURCE_ENABLED && prefs.x ? marketDataApi.getXNews(getEnabledXUsernames(prefs)) : Promise.resolve([]),
        prefs.rss ? marketDataApi.getRssNews() : Promise.resolve([]),
      ]);

      const combined: RawHeadline[] = [
        ...(finnhubRaw.status === 'fulfilled' ? finnhubRaw.value : []),
        ...(polygonRaw.status === 'fulfilled' ? polygonRaw.value : []),
        ...(xRaw.status === 'fulfilled' ? xRaw.value : []),
        ...(rssRaw.status === 'fulfilled' ? rssRaw.value : []),
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

      const batchKey = `${sourceKey}::${Array.from(dedupedMap.keys()).join('|')}`;
      if (batchKey === lastBatchKeyRef.current) {
        setLastRefresh(new Date());
        setLoading(false);
        return;
      }
      lastBatchKeyRef.current = batchKey;

      const hotRe = buildHotRegex(prefs.hotKeywords);
      let finalItems: NewsFilterItem[] = [];
      let rawFallback = false;
      if (prefs.aiFilter) {
        try {
          const { items: filtered } = await aiApi.filterNews(deduped);
          if (filtered.length > 0) {
            finalItems = filtered;
          } else {
            finalItems = deduped.slice(0, 40).map(item => rawToNewsItem(item, hotRe));
            rawFallback = true;
          }
        } catch {
          finalItems = deduped.slice(0, 40).map(item => rawToNewsItem(item, hotRe));
          rawFallback = true;
        }
      } else {
        finalItems = deduped.slice(0, 40).map(item => rawToNewsItem(item, hotRe));
      }

      // Keyword floor on top of the AI's call — a war or Fed headline never
      // renders as noise, even when the AI underrates or skips it.
      finalItems = finalItems.map(item => ({ ...item, impact: maxImpact(item.impact, keywordImpact(item.headline, hotRe)) }));

      // Tape ordering: strict chronology, newest first. Impact shows as
      // color on the row, never as position — a tape that reorders lies.
      finalItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

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
    const currenciesKey = prefs.calendarCurrencies.join(',');
    const cached = readCalendarCache(safeTimeZone, currenciesKey);
    if (cached) {
      setCalendar(cached.events);
      setCalendarIsToday(cached.isToday);
    }

    try {
      const calendarResult = await fetchForexFactoryCalendar(safeTimeZone, weeksAhead, prefs.calendarCurrencies);
      if (calendarResult.events.length > 0) {
        writeCalendarCache(calendarResult, safeTimeZone, currenciesKey);
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
  }, [prefs.economicCalendar, prefs.calendarCurrencies, preferences.timezone]);

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

  // Live push channel — Tree News headlines stream in over SSE and hit the
  // tape immediately, classified by keyword so war/tariff/Fed headlines get
  // BREAKING treatment without waiting for the AI filter or the next tick.
  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let closed = false;

    const connect = async () => {
      if (closed) return;
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token || closed) return;

      source = new EventSource(`${NEWS_API_URL}/api/market-data/news-stream?token=${encodeURIComponent(token)}`);
      source.onmessage = event => {
        try {
          const raw = JSON.parse(event.data) as { headline?: string; source?: string; timestamp?: string; summary?: string; url?: string };
          if (!raw.headline) return;
          const hot = hotRegexRef.current?.test(raw.headline) ?? false;
          const live: NewsFilterItem = {
            headline: raw.headline,
            summary: raw.summary ?? raw.headline,
            impact: hot ? 'high' : 'medium',
            category: 'Live',
            marketImpact: { es: '—', nq: '—' },
            isBreaking: hot,
            source: raw.source ?? 'Tree News',
            timestamp: raw.timestamp ?? new Date().toISOString(),
            url: raw.url,
          };
          setItems(prev => {
            if (prev.some(existing => existing.headline === live.headline)) return prev;
            return [live, ...prev].slice(0, 60);
          });
          setLastRefresh(new Date());
        } catch { /* malformed event, ignore */ }
      };
      // Recreate with a fresh token instead of letting EventSource retry a stale one.
      source.onerror = () => {
        source?.close();
        source = null;
        if (!closed) retryTimer = window.setTimeout(() => { void connect(); }, 5000);
      };
    };

    void connect();
    return () => {
      closed = true;
      source?.close();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, []);

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

    // Tape order is always chronological — the impact chips filter, never reorder.
    return [...filtered].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }, [filter, items, query]);

  const topBreaking = useMemo(() => items.find(item => item.isBreaking), [items]);

  // Archive matches not already on the live tape — rendered below it.
  const archiveOnly = useMemo(() => {
    const liveKeys = new Set(items.map(item => item.headline.slice(0, 100)));
    return archiveResults.filter(item => !liveKeys.has(item.headline.slice(0, 100)));
  }, [archiveResults, items]);
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 650, letterSpacing: '-0.01em', color: T1, whiteSpace: 'nowrap' }}>
              Market News
            </span>
            {!isMobile && (
              <>
                <span style={{ width: 1, height: 15, background: BORDER, flexShrink: 0 }} />
                <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.08em', color: T3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span style={{ color: breakingCount > 0 ? RED : T3, fontWeight: breakingCount > 0 ? 700 : 400 }}>{breakingCount} BREAKING</span>
                  {' · '}
                  <span style={{ color: highCount > 0 ? AMBER : T3, fontWeight: highCount > 0 ? 700 : 400 }}>{highCount} HIGH IMPACT</span>
                  {' · '}
                  <span style={{ color: highCalendarCount > 0 ? COBALT : T3, fontWeight: highCalendarCount > 0 ? 700 : 400 }}>{highCalendarCount} EVENTS AHEAD</span>
                </span>
              </>
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
                fontWeight: 500,
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
          <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 10px 14px' }}>
          <div style={{ padding: '10px 14px 8px', borderBottom: `1px solid rgba(255,255,255,0.09)`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '.12em', color: T1, borderLeft: `2px solid ${AMBER}`, paddingLeft: 10 }}>
              Live Wire
            </span>
            <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: '.06em', color: T3, textTransform: 'uppercase' }}>
              {displayed.length > 0 && <>{displayed.length} stories · </>}
              {lastRefresh ? <>upd {fmtClock(lastRefresh.toISOString())}</> : 'connecting'}
            </span>
          </div>
          {topBreaking && (
            <div style={{ margin: '8px 0 0', padding: '8px 14px', borderBottom: `1px solid ${RED_BORDER}`, background: 'rgba(239,68,68,0.07)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <span style={{ fontSize: 9, fontWeight: 500, letterSpacing: '.1em', color: RED, fontFamily: MONO, flexShrink: 0, paddingTop: 2 }}>⚡ BREAKING</span>
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
            <div style={{ padding: '6px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontFamily: MONO, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: T3 }}>
              <span style={{ color: AMBER }}>raw wire</span> · unfiltered headlines, ai found nothing es/nq-specific this batch
            </div>
          )}

          <div>
            {displayed.map((item, index) => {
              const daySlice = etDateSlice(item.timestamp);
              const prevSlice = index > 0 ? etDateSlice(displayed[index - 1].timestamp) : null;
              return (
                <Fragment key={`${item.headline}-${index}`}>
                  {daySlice !== prevSlice && daySlice && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px 5px',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                      position: 'sticky', top: 0, zIndex: 2, background: S1,
                    }}>
                      <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '0.12em', color: etDayLabel(daySlice) === 'TODAY' ? AMBER : T3 }}>
                        {etDayLabel(daySlice)}
                      </span>
                      <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
                    </div>
                  )}
                  <NewsCard item={item} />
                </Fragment>
              );
            })}
          </div>

          {/* Archive results — server-side history search below the live tape. */}
          {query.trim().length >= 3 && (
            <div style={{ borderTop: `1px solid ${BORDER}` }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px 6px',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
              }}>
                <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '0.12em', color: COBALT }}>
                  FROM THE ARCHIVE
                </span>
                <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.08em', color: T3 }}>
                  {archiveState === 'loading' ? 'searching…'
                    : archiveState === 'unavailable' ? 'unavailable, apply migration 026'
                    : `${archiveOnly.length} older match${archiveOnly.length === 1 ? '' : 'es'}`}
                </span>
                <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
              </div>
              {archiveState === 'ready' && archiveOnly.map((item, index) => (
                <NewsCard key={`archive-${item.headline}-${index}`} item={item} />
              ))}
            </div>
          )}
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
                currencies={prefs.calendarCurrencies}
                onCurrenciesChange={value => handlePrefsChange({ ...prefs, calendarCurrencies: value })}
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









