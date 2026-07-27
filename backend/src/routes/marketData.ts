import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { getTreeNewsItems, onTreeNewsItem } from '../services/treeNews';
import { archiveNewsItems, searchNewsArchive } from '../services/newsArchive';
import { AuthenticatedRequest } from '../types/index';

const router = Router();

const ALLOWED_INTERVALS = new Set(['1m', '5m', '15m', '1h', '1d']);
const ALLOWED_RANGES = new Set(['1d', '5d', '1mo', '3mo', '1y']);
const MAX_IMPORT_CANDLES = 50_000;
const CANDLE_UPSERT_CHUNK_SIZE = 1_000;
const DATABENTO_DATASET = process.env.DATABENTO_DATASET?.trim() || 'GLBX.MDP3';
const DATABENTO_HISTORICAL_URL = 'https://hist.databento.com/v0/timeseries.get_range';
const X_MAX_ACCOUNTS = 10;
const X_POSTS_PER_ACCOUNT = 10;

type MarketCandlePayload = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type YahooChartResponse = {
  chart?: {
    error?: { description?: string } | null;
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
};

type DatabentoRecord = {
  hd?: {
    ts_event?: string | number;
  };
  ts_event?: string | number;
  time?: string | number;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
};

type XUserLookupResponse = {
  data?: Array<{ id: string; username: string; name?: string }>;
};

type XUserPostsResponse = {
  data?: Array<{ id: string; text: string; created_at?: string }>;
};

function normalizeMarketSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().slice(0, 32);
}

function normalizeTimeframe(value: unknown): string {
  const raw = String(value ?? '').trim();
  return raw === '1H' ? '1h' : raw === '1D' ? '1d' : raw;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeMarketCandle(value: unknown): MarketCandlePayload | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MarketCandlePayload>;
  const time = Number(candidate.time);
  const open = Number(candidate.open);
  const high = Number(candidate.high);
  const low = Number(candidate.low);
  const close = Number(candidate.close);
  const volume = Number(candidate.volume ?? 0);

  if (
    !isFiniteNumber(time) ||
    !isFiniteNumber(open) ||
    !isFiniteNumber(high) ||
    !isFiniteNumber(low) ||
    !isFiniteNumber(close)
  ) {
    return null;
  }

  return {
    time: time > 10_000_000_000 ? Math.floor(time / 1000) : Math.floor(time),
    open,
    high,
    low,
    close,
    volume: isFiniteNumber(volume) ? volume : 0,
  };
}

function toUnixSeconds(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor(parsed.getTime() / 1000);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function getDefaultRangeWindow(range: string): { start: string; end: string } {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const days = range === '1d' ? 1 : range === '5d' ? 5 : range === '1mo' ? 31 : range === '3mo' ? 92 : 365;
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function getDatabentoSchema(timeframe: string): string {
  if (timeframe === '1h') return 'ohlcv-1h';
  if (timeframe === '1d') return 'ohlcv-1d';
  return 'ohlcv-1m';
}

function getAggregationMinutes(timeframe: string): number {
  if (timeframe === '5m') return 5;
  if (timeframe === '15m') return 15;
  return 1;
}

function normalizeDatabentoSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase();
  if (clean === 'NQ=F' || clean === 'NQ-F') return 'NQ';
  if (clean === 'ES=F' || clean === 'ES-F') return 'ES';
  return clean.replace(/[^A-Z0-9._-]/g, '');
}

function normalizeDatabentoPrice(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return Math.abs(numeric) > 1_000_000 ? numeric / 1_000_000_000 : numeric;
}

function normalizeDatabentoCandle(record: DatabentoRecord): MarketCandlePayload | null {
  const ts = record.ts_event ?? record.hd?.ts_event ?? record.time;
  const time = toUnixSeconds(ts);
  const open = normalizeDatabentoPrice(record.open);
  const high = normalizeDatabentoPrice(record.high);
  const low = normalizeDatabentoPrice(record.low);
  const close = normalizeDatabentoPrice(record.close);
  const volume = Number(record.volume ?? 0);

  if (
    time === null ||
    !isFiniteNumber(open) ||
    !isFiniteNumber(high) ||
    !isFiniteNumber(low) ||
    !isFiniteNumber(close)
  ) {
    return null;
  }

  return {
    time,
    open,
    high,
    low,
    close,
    volume: isFiniteNumber(volume) ? volume : 0,
  };
}

function parseDatabentoJsonLines(text: string): MarketCandlePayload[] {
  const candles: MarketCandlePayload[] = [];
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  for (const line of lines) {
    const parsed = JSON.parse(line);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      const candle = normalizeDatabentoCandle(record as DatabentoRecord);
      if (candle) candles.push(candle);
    }
  }

  return candles;
}

function aggregateCandles(candles: MarketCandlePayload[], minutes: number): MarketCandlePayload[] {
  if (minutes <= 1) return candles;
  const bucketSeconds = minutes * 60;
  const buckets = new Map<number, MarketCandlePayload>();

  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / bucketSeconds) * bucketSeconds;
    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, { ...candle, time: bucketTime });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume = (existing.volume ?? 0) + (candle.volume ?? 0);
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

async function fetchDatabentoCandles(params: {
  symbol: string;
  timeframe: string;
  start: string;
  end: string;
}): Promise<MarketCandlePayload[]> {
  const apiKey = process.env.DATABENTO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Databento API key is not configured.');
  }

  const schema = getDatabentoSchema(params.timeframe);
  const body = new URLSearchParams({
    dataset: DATABENTO_DATASET,
    symbols: normalizeDatabentoSymbol(params.symbol),
    schema,
    start: params.start,
    end: params.end,
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
  });

  const response = await fetch(DATABENTO_HISTORICAL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'FlyxaAI/1.0',
    },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    const detail = text.trim().slice(0, 240);
    throw new Error(detail || `Databento request failed with status ${response.status}.`);
  }

  const parsed = parseDatabentoJsonLines(text);
  const deduped = Array.from(new Map(parsed.map(candle => [candle.time, candle])).values())
    .sort((a, b) => a.time - b.time);

  return aggregateCandles(deduped, getAggregationMinutes(params.timeframe));
}

async function upsertMarketCandles(params: {
  userId: string;
  symbol: string;
  timeframe: string;
  source: string;
  candles: MarketCandlePayload[];
}) {
  const rows = params.candles.map(candle => ({
    user_id: params.userId,
    symbol: params.symbol,
    timeframe: params.timeframe,
    time: new Date(candle.time * 1000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume ?? 0,
    source: params.source,
  }));

  for (const chunk of chunkArray(rows, CANDLE_UPSERT_CHUNK_SIZE)) {
    const { error } = await supabase
      .from('market_candles')
      .upsert(chunk, { onConflict: 'user_id,symbol,timeframe,time' });

    if (error) throw error;
  }

  return rows;
}

function parseXUsernames(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map(username => username.trim().replace(/^@/, '').toLowerCase())
    .filter(username => /^[a-z0-9_]{1,15}$/.test(username));
}

function getConfiguredXUsernames(extraUsernames?: unknown): string[] {
  return Array.from(new Set([
    ...parseXUsernames(process.env.X_MARKET_NEWS_USERNAMES),
    ...parseXUsernames(extraUsernames),
  ]))
    .slice(0, X_MAX_ACCOUNTS);
}

function cleanXPostText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^rt @[^:]+:\s*/i, '')
    .trim();
}

async function fetchJsonFromX<T>(url: string, bearerToken: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: 'application/json',
      'User-Agent': 'FlyxaAI/1.0',
    },
  });

  if (response.status === 429) {
    throw new Error('X API rate limit reached. Try again later.');
  }

  if (!response.ok) {
    throw new Error(`X API request failed with status ${response.status}.`);
  }

  return response.json() as Promise<T>;
}

function normalizeYahooResponse(payload: YahooChartResponse) {
  if (payload.chart?.error?.description) {
    throw new Error(payload.chart.error.description);
  }

  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) {
    throw new Error('No candle data returned for this symbol/timeframe/range.');
  }

  const candles = result.timestamp.reduce<Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>>((acc, timestamp, index) => {
    const open = quote.open?.[index];
    const high = quote.high?.[index];
    const low = quote.low?.[index];
    const close = quote.close?.[index];
    const volume = quote.volume?.[index] ?? 0;

    if (
      typeof timestamp !== 'number' ||
      typeof open !== 'number' ||
      typeof high !== 'number' ||
      typeof low !== 'number' ||
      typeof close !== 'number'
    ) {
      return acc;
    }

    acc.push({
      time: timestamp,
      open,
      high,
      low,
      close,
      volume: typeof volume === 'number' ? volume : 0,
    });

    return acc;
  }, []);

  if (candles.length === 0) {
    throw new Error('Not enough candle data returned for replay.');
  }

  return candles;
}

function readXmlTag(block: string, tag: string): string {
  const cdataMatch = block.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'));
  if (cdataMatch?.[1]) return cdataMatch[1].trim();
  const plainMatch = block.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'i'));
  if (plainMatch?.[1]) return plainMatch[1].trim();
  const selfClosing = block.match(new RegExp(`<${tag}\\s*/>`, 'i'));
  if (selfClosing) return '';
  return '';
}

function normalizeXmlDate(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const mdy = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (mdy) {
    const [, mm, dd, yyyy] = mdy;
    return `${yyyy}-${mm}-${dd}`;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }
  return '';
}

function parseForexFactoryXml(xml: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  const matches = xml.matchAll(/<event>([\s\S]*?)<\/event>/gi);
  for (const match of matches) {
    const block = match[1] ?? '';
    const title = readXmlTag(block, 'title');
    const country = readXmlTag(block, 'country');
    const date = normalizeXmlDate(readXmlTag(block, 'date'));
    const time = readXmlTag(block, 'time');
    const impact = readXmlTag(block, 'impact');
    const actual = readXmlTag(block, 'actual');
    const forecast = readXmlTag(block, 'forecast');
    const previous = readXmlTag(block, 'previous');

    if (!date || !country) continue;
    events.push({
      title,
      country,
      date,
      time,
      impact,
      actual: actual || null,
      forecast: forecast || null,
      previous: previous || null,
    });
  }
  return events;
}

// FF's JSON feed dates events as ISO ("2026-07-24T08:30:00-04:00") while its
// XML fallback uses "07-24-2026" + "8:30am". The archive can hold either
// format, so dedupe must compare NORMALIZED values or the same event survives
// twice whenever both formats meet.
function normalizeEventDateSlice(event: Record<string, unknown>): string {
  const raw = String(event.date ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const usFormat = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (usFormat) return `${usFormat[3]}-${usFormat[1]}-${usFormat[2]}`;
  return raw.toLowerCase();
}

function normalizeEventTime(event: Record<string, unknown>): string {
  const rawDate = String(event.date ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(rawDate)) return rawDate.slice(11, 16);
  const rawTime = String(event.time ?? '').trim().toLowerCase();
  const twelveHour = rawTime.match(/^(\d{1,2}):(\d{2})(am|pm)$/);
  if (twelveHour) {
    let hours = Number(twelveHour[1]) % 12;
    if (twelveHour[3] === 'pm') hours += 12;
    return `${String(hours).padStart(2, '0')}:${twelveHour[2]}`;
  }
  if (/^\d{1,2}:\d{2}/.test(rawTime)) return rawTime.slice(0, 5).padStart(5, '0');
  return rawTime; // 'all day', 'tentative', ''
}

function getCalendarEventKey(event: Record<string, unknown>): string {
  return [
    normalizeEventDateSlice(event),
    normalizeEventTime(event),
    String(event.country ?? '').toUpperCase(),
    String(event.title ?? event.event ?? '').toLowerCase().replace(/\s+/g, ' ').trim(),
  ].join('|');
}

// Chronological order regardless of which source each event came from.
// All-day events lead their day; tentative/unknown times trail it.
function sortCalendarEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const sortKey = (event: Record<string, unknown>) => {
    const time = normalizeEventTime(event);
    const timeRank = /^\d{2}:\d{2}$/.test(time) ? time : time === 'all day' ? '00:00' : '99:99';
    return `${normalizeEventDateSlice(event)}|${timeRank}`;
  };
  return [...events].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

function dedupeCalendarEvents(events: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];

  for (const event of events) {
    const key = getCalendarEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }

  return deduped;
}

async function fetchForexFactoryJson(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!response.ok) return [];
  const payload = await response.json();
  return Array.isArray(payload) ? payload as Array<Record<string, unknown>> : [];
}

async function fetchForexFactoryXml(url: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/xml,text/xml,*/*' },
  });
  if (!response.ok) return [];
  return parseForexFactoryXml(await response.text());
}

router.post('/import-csv', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    const symbol = normalizeMarketSymbol(req.body?.symbol);
    const timeframe = normalizeTimeframe(req.body?.timeframe);
    const candlesRaw = Array.isArray(req.body?.candles) ? req.body.candles : [];

    if (!userId) {
      return res.status(401).json({ error: 'User is required.' });
    }

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required.' });
    }

    if (!ALLOWED_INTERVALS.has(timeframe)) {
      return res.status(400).json({ error: 'Unsupported timeframe.' });
    }

    if (candlesRaw.length === 0) {
      return res.status(400).json({ error: 'Candles are required.' });
    }

    if (candlesRaw.length > MAX_IMPORT_CANDLES) {
      return res.status(400).json({ error: `Import is limited to ${MAX_IMPORT_CANDLES.toLocaleString()} candles.` });
    }

    const deduped = new Map<number, MarketCandlePayload>();
    for (const raw of candlesRaw) {
      const candle = normalizeMarketCandle(raw);
      if (!candle) continue;
      deduped.set(candle.time, candle);
    }

    const candles = Array.from(deduped.values()).sort((a, b) => a.time - b.time);
    if (candles.length < 2) {
      return res.status(400).json({ error: 'Not enough valid candles to import.' });
    }

    const rows = await upsertMarketCandles({
      userId,
      symbol,
      timeframe,
      source: 'csv',
      candles,
    });

    return res.json({
      symbol,
      timeframe,
      imported: rows.length,
      start: rows[0]?.time ?? null,
      end: rows[rows.length - 1]?.time ?? null,
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/databento/import', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    const symbol = normalizeMarketSymbol(req.body?.symbol);
    const timeframe = normalizeTimeframe(req.body?.timeframe ?? req.body?.interval);
    const range = String(req.body?.range ?? '5d').trim();
    const requestedStart = toUnixSeconds(req.body?.start);
    const requestedEnd = toUnixSeconds(req.body?.end);

    if (!userId) {
      return res.status(401).json({ error: 'User is required.' });
    }

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required.' });
    }

    if (!ALLOWED_INTERVALS.has(timeframe)) {
      return res.status(400).json({ error: 'Unsupported timeframe.' });
    }

    if (!ALLOWED_RANGES.has(range)) {
      return res.status(400).json({ error: 'Unsupported range.' });
    }

    const defaultWindow = getDefaultRangeWindow(range);
    const start = requestedStart !== null ? new Date(requestedStart * 1000).toISOString() : defaultWindow.start;
    const end = requestedEnd !== null ? new Date(requestedEnd * 1000).toISOString() : defaultWindow.end;

    const candles = await fetchDatabentoCandles({ symbol, timeframe, start, end });
    if (candles.length < 2) {
      return res.status(404).json({
        error: 'Databento returned no candles for this symbol and date range. Try an exact futures contract like NQM6 or ESM6.',
      });
    }

    if (candles.length > MAX_IMPORT_CANDLES) {
      return res.status(400).json({ error: `Databento returned too many candles. Narrow the range below ${MAX_IMPORT_CANDLES.toLocaleString()} candles.` });
    }

    const rows = await upsertMarketCandles({
      userId,
      symbol,
      timeframe,
      source: 'databento',
      candles,
    });

    return res.json({
      symbol,
      timeframe,
      imported: rows.length,
      start: rows[0]?.time ?? null,
      end: rows[rows.length - 1]?.time ?? null,
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/candles', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    const symbol = normalizeMarketSymbol(req.query.symbol);
    const timeframe = normalizeTimeframe(req.query.timeframe ?? req.query.interval);
    const from = toUnixSeconds(req.query.from);
    const to = toUnixSeconds(req.query.to);

    if (!userId) {
      return res.status(401).json({ error: 'User is required.' });
    }

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required.' });
    }

    if (!ALLOWED_INTERVALS.has(timeframe)) {
      return res.status(400).json({ error: 'Unsupported timeframe.' });
    }

    let query = supabase
      .from('market_candles')
      .select('time, open, high, low, close, volume')
      .eq('user_id', userId)
      .eq('symbol', symbol)
      .eq('timeframe', timeframe)
      .order('time', { ascending: true })
      .limit(50_000);

    if (from !== null) query = query.gte('time', new Date(from * 1000).toISOString());
    if (to !== null) query = query.lte('time', new Date(to * 1000).toISOString());

    const { data, error } = await query;
    if (error) throw error;

    const candles = (data ?? []).map(row => ({
      time: Math.floor(new Date(row.time as string).getTime() / 1000),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume ?? 0),
    }));

    return res.json(candles);
  } catch (error) {
    return next(error);
  }
});

router.get('/symbols', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'User is required.' });
    }

    const { data, error } = await supabase
      .from('market_candles')
      .select('symbol, timeframe')
      .eq('user_id', userId)
      .order('symbol', { ascending: true });

    if (error) throw error;

    const seen = new Set<string>();
    const symbols = (data ?? []).reduce<Array<{ symbol: string; timeframe: string }>>((acc, row) => {
      const key = `${row.symbol}:${row.timeframe}`;
      if (seen.has(key)) return acc;
      seen.add(key);
      acc.push({ symbol: String(row.symbol), timeframe: String(row.timeframe) });
      return acc;
    }, []);

    return res.json(symbols);
  } catch (error) {
    return next(error);
  }
});

router.get('/chart', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const symbol = String(req.query.symbol ?? '').trim();
    const interval = String(req.query.interval ?? '').trim();
    const range = String(req.query.range ?? '').trim();

    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required.' });
    }

    if (!ALLOWED_INTERVALS.has(interval)) {
      return res.status(400).json({ error: 'Unsupported interval.' });
    }

    if (!ALLOWED_RANGES.has(range)) {
      return res.status(400).json({ error: 'Unsupported range.' });
    }

    const query = new URLSearchParams({
      interval,
      range,
      includePrePost: 'false',
      events: 'div,splits',
    });

    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query.toString()}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Yahoo Finance request failed with status ${response.status}.`);
    }

    const payload = await response.json() as YahooChartResponse;
    const candles = normalizeYahooResponse(payload);

    return res.json(candles);
  } catch (error) {
    return next(error);
  }
});

// ── Econ calendar archive ──────────────────────────────────────────
// The FF feed only publishes this week + next, so every USD event we see is
// upserted into Supabase (re-upserts capture actuals as they fill in) and
// past weeks are served from the archive. History accumulates from ship day.

interface EconArchiveRow {
  title: string;
  country: string;
  date_text: string;
  time_text: string;
  impact: string;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  date_slice: string;
  time_key: string;
}

function econEventToRow(event: Record<string, unknown>): EconArchiveRow | null {
  const title = String(event.title ?? event.event ?? '').trim();
  const dateText = String(event.date ?? '').trim();
  const country = String(event.country ?? '').trim();
  if (!title || !dateText) return null;
  // Archive the currencies the calendar can be personalized to.
  const ARCHIVED = ['USD', 'US', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD', 'CNY'];
  if (!ARCHIVED.includes(country.toUpperCase())) return null;
  const dateSlice = dateText.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateSlice)) return null;
  const timeText = String(event.time ?? '').trim();
  const clean = (value: unknown) => {
    const text = String(value ?? '').trim();
    return text || null;
  };
  return {
    title,
    country,
    date_text: dateText,
    time_text: timeText,
    impact: String(event.impact ?? '').trim(),
    actual: clean(event.actual),
    forecast: clean(event.forecast),
    previous: clean(event.previous),
    date_slice: dateSlice,
    // Normalized so the JSON and XML variants of the same event share one
    // archive row instead of upserting under two different keys.
    time_key: normalizeEventTime(event),
  };
}

async function archiveEconEvents(events: Array<Record<string, unknown>>): Promise<void> {
  const byKey = new Map<string, EconArchiveRow>();
  for (const event of events) {
    const row = econEventToRow(event);
    if (row) byKey.set(`${row.title}|${row.date_slice}|${row.time_key}`, row);
  }
  if (byKey.size === 0) return;
  const { error } = await supabase
    .from('econ_calendar_events')
    .upsert(Array.from(byKey.values()), { onConflict: 'title,date_slice,time_key' });
  if (error) throw error;
}

const ECON_ARCHIVE_LOOKBACK_DAYS = 180;

async function readArchivedEconEvents(): Promise<Array<Record<string, unknown>>> {
  try {
    const since = new Date(Date.now() - ECON_ARCHIVE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('econ_calendar_events')
      .select('title, country, date_text, time_text, impact, actual, forecast, previous')
      .gte('date_slice', since)
      .order('date_slice', { ascending: true })
      .limit(4000);
    if (error || !Array.isArray(data)) return [];
    return data.map(row => ({
      title: row.title,
      country: row.country,
      date: row.date_text,
      ...(row.time_text ? { time: row.time_text } : {}),
      impact: row.impact,
      actual: row.actual ?? undefined,
      forecast: row.forecast ?? undefined,
      previous: row.previous ?? undefined,
    }));
  } catch {
    return [];
  }
}

router.get('/ff-calendar', authMiddleware, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const jsonSources = [
      'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
      'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
      'http://nfs.faireconomy.media/ff_calendar_thisweek.json',
      'http://nfs.faireconomy.media/ff_calendar_nextweek.json',
    ];

    const settled = await Promise.allSettled(
      jsonSources.map(fetchForexFactoryJson)
    );

    const combinedJson = settled.flatMap((result) => (
      result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
    ));

    if (combinedJson.length > 0) {
      const live = dedupeCalendarEvents(combinedJson);
      void archiveEconEvents(live).catch(err => console.error('Econ archive write failed:', err));
      // Live events first so dedupe prefers the fresher copy over the archive.
      return res.json(sortCalendarEvents(dedupeCalendarEvents([...live, ...await readArchivedEconEvents()])));
    }

    // Fallback: XML export is often available even when JSON is rate-limited.
    const xmlSources = [
      'https://nfs.faireconomy.media/ff_calendar_thisweek.xml',
      'https://nfs.faireconomy.media/ff_calendar_nextweek.xml',
      'http://nfs.faireconomy.media/ff_calendar_thisweek.xml',
      'http://nfs.faireconomy.media/ff_calendar_nextweek.xml',
    ];
    const settledXml = await Promise.allSettled(xmlSources.map(fetchForexFactoryXml));
    const combinedXml = settledXml.flatMap((result) => (
      result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
    ));
    if (combinedXml.length > 0) {
      const live = dedupeCalendarEvents(combinedXml);
      void archiveEconEvents(live).catch(err => console.error('Econ archive write failed:', err));
      return res.json(sortCalendarEvents(dedupeCalendarEvents([...live, ...await readArchivedEconEvents()])));
    }

    // Both feeds down or rate-limited — the archive still covers past weeks.
    return res.json(sortCalendarEvents(dedupeCalendarEvents(await readArchivedEconEvents())));
  } catch (error) {
    return next(error);
  }
});

// Shared server-side cache for X posts. X bills per read, so one fetch per
// half hour serves every user; without this, each user's 3-minute feed
// refresh would hit X directly and multiply the bill by the user count.
interface XNewsItem {
  headline: string;
  source: string;
  timestamp: string;
  summary: string;
  url: string;
}
const X_NEWS_CACHE_TTL_MS = 30 * 60 * 1000;
const X_NEWS_CACHE_MAX_KEYS = 30;
const xNewsCache = new Map<string, { fetchedAt: number; items: XNewsItem[] }>();

router.get('/x-news', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  const usernames = getConfiguredXUsernames(req.query.accounts);
  const cacheKey = usernames.join(',');
  try {
    const bearerToken = process.env.X_BEARER_TOKEN?.trim();

    if (!bearerToken || usernames.length === 0) {
      return res.json([]);
    }

    const cached = xNewsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < X_NEWS_CACHE_TTL_MS) {
      return res.json(cached.items);
    }

    const userQuery = new URLSearchParams({
      usernames: usernames.join(','),
      'user.fields': 'name,username',
    });
    const usersPayload = await fetchJsonFromX<XUserLookupResponse>(
      `https://api.x.com/2/users/by?${userQuery.toString()}`,
      bearerToken,
    );

    const users = usersPayload?.data ?? [];
    if (users.length === 0) return res.json([]);

    const settledPosts = await Promise.allSettled(
      users.map(async (user) => {
        const postQuery = new URLSearchParams({
          max_results: String(X_POSTS_PER_ACCOUNT),
          exclude: 'retweets,replies',
          'tweet.fields': 'created_at',
        });
        const postsPayload = await fetchJsonFromX<XUserPostsResponse>(
          `https://api.x.com/2/users/${encodeURIComponent(user.id)}/tweets?${postQuery.toString()}`,
          bearerToken,
        );

        return (postsPayload?.data ?? []).map(post => {
          const headline = cleanXPostText(post.text);
          return {
            headline,
            source: `X @${user.username}`,
            timestamp: post.created_at ?? new Date().toISOString(),
            summary: headline,
            url: `https://x.com/${user.username}/status/${post.id}`,
          };
        }).filter(item => item.headline.length > 0);
      })
    );

    const combined = settledPosts.flatMap(result => (
      result.status === 'fulfilled' ? result.value : []
    ));

    combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const items = combined.slice(0, 50);

    if (xNewsCache.size >= X_NEWS_CACHE_MAX_KEYS && !xNewsCache.has(cacheKey)) {
      const oldestKey = xNewsCache.keys().next().value;
      if (oldestKey !== undefined) xNewsCache.delete(oldestKey);
    }
    xNewsCache.set(cacheKey, { fetchedAt: Date.now(), items });

    return res.json(items);
  } catch (error) {
    // Serve stale posts rather than an error when X rate-limits or hiccups.
    const stale = xNewsCache.get(cacheKey);
    if (stale) return res.json(stale.items);
    return next(error);
  }
});

// ── Economic calendar proxy — FMP key stays server-side, one shared cache ──
// The free FF feeds only cover this week + next; FMP takes date ranges, so
// past and future weeks work. Returns [] when unconfigured and the frontend
// falls back to the FF feeds.
const FMP_API_KEY = process.env.FMP_API_KEY?.trim();
const ECON_CAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const econCalendarCache = new Map<string, { fetchedAt: number; payload: unknown[] }>();

router.get('/econ-calendar', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!FMP_API_KEY) return res.json([]);

    const from = String(req.query.from ?? '').trim();
    const to = String(req.query.to ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    }

    const cacheKey = `${from}|${to}`;
    const cached = econCalendarCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ECON_CAL_CACHE_TTL_MS) {
      return res.json(cached.payload);
    }

    const response = await fetch(
      `https://financialmodelingprep.com/stable/economic-calendar?from=${from}&to=${to}&apikey=${FMP_API_KEY}`
    );
    if (!response.ok) {
      return res.json(cached?.payload ?? []);
    }
    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) {
      return res.json(cached?.payload ?? []);
    }

    if (econCalendarCache.size >= 20 && !econCalendarCache.has(cacheKey)) {
      const oldestKey = econCalendarCache.keys().next().value;
      if (oldestKey !== undefined) econCalendarCache.delete(oldestKey);
    }
    econCalendarCache.set(cacheKey, { fetchedAt: Date.now(), payload });
    return res.json(payload);
  } catch (error) {
    return next(error);
  }
});

// ── RSS market news — free fast-headline sources, no keys, no billing ──
const RSS_FEEDS: Array<{ source: string; url: string }> = [
  { source: 'ForexLive', url: 'https://www.forexlive.com/feed/news' },
  { source: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114' },
  { source: 'FXStreet', url: 'https://www.fxstreet.com/rss/news' },
  { source: 'Investing.com', url: 'https://www.investing.com/rss/news_25.rss' },
  // Bulletins wire — MarketWatch's fastest-headline feed (Dow Jones).
  { source: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  // Primary sources — the release IS the news for FOMC statements, CPI/NFP
  // prints, and Treasury actions. Slow-moving feeds, but zero-spin.
  { source: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { source: 'BLS', url: 'https://www.bls.gov/feed/news_release.rss' },
];
// Just under the news page's 60-second refresh loop, so every client tick can
// get a fresh batch. Polling this fast stays polite because fetchRssFeed uses
// conditional requests — unchanged feeds answer 304 with no body.
const RSS_NEWS_CACHE_TTL_MS = 55 * 1000;
const RSS_ITEMS_PER_FEED = 20;
let rssNewsCache: { fetchedAt: number; items: XNewsItem[] } | null = null;

// Per-feed ETag/Last-Modified state for conditional GETs.
interface RssFeedState {
  etag?: string;
  lastModified?: string;
  items: XNewsItem[];
}
const rssFeedState = new Map<string, RssFeedState>();

function decodeRssText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return ''; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      try { return String.fromCodePoint(parseInt(code, 16)); } catch { return ''; }
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchRssFeed(feed: { source: string; url: string }): Promise<XNewsItem[]> {
  const state = rssFeedState.get(feed.url);
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (compatible; FlyxaAI/1.0; +https://flyxa.app)',
    Accept: 'application/rss+xml,application/xml,text/xml,*/*',
  };
  if (state?.etag) headers['If-None-Match'] = state.etag;
  if (state?.lastModified) headers['If-Modified-Since'] = state.lastModified;

  const response = await fetch(feed.url, { headers });
  // 304 = nothing changed since last poll; reuse the parsed items for free.
  if (response.status === 304 && state) return state.items;
  if (!response.ok) return state?.items ?? [];
  const xml = await response.text();

  const items: XNewsItem[] = [];
  for (const match of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? '';
    const headline = decodeRssText(readXmlTag(block, 'title'));
    if (!headline) continue;
    const link = decodeRssText(readXmlTag(block, 'link'));
    const pubDate = readXmlTag(block, 'pubDate') || readXmlTag(block, 'dc:date');
    const parsed = pubDate ? new Date(pubDate) : null;
    items.push({
      headline,
      source: feed.source,
      timestamp: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString(),
      summary: headline,
      url: link,
    });
    if (items.length >= RSS_ITEMS_PER_FEED) break;
  }

  rssFeedState.set(feed.url, {
    etag: response.headers.get('etag') ?? undefined,
    lastModified: response.headers.get('last-modified') ?? undefined,
    items,
  });
  return items;
}

router.get('/rss-news', authMiddleware, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Pushed Tree News headlines are merged fresh on every request — they
    // arrive over a live socket, so they bypass the RSS poll cache entirely.
    if (rssNewsCache && Date.now() - rssNewsCache.fetchedAt < RSS_NEWS_CACHE_TTL_MS) {
      return res.json(mergeWithTreeNews(rssNewsCache.items));
    }

    const settled = await Promise.allSettled(RSS_FEEDS.map(fetchRssFeed));
    const combined = settled.flatMap(result => (result.status === 'fulfilled' ? result.value : []));

    combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const items = combined.slice(0, 60);

    if (items.length > 0) {
      rssNewsCache = { fetchedAt: Date.now(), items };
      archiveNewsItems(items);
    }
    return res.json(mergeWithTreeNews(items));
  } catch (error) {
    if (rssNewsCache) return res.json(mergeWithTreeNews(rssNewsCache.items));
    return next(error);
  }
});

function mergeWithTreeNews(rssItems: XNewsItem[]): XNewsItem[] {
  const tree = getTreeNewsItems();
  if (tree.length === 0) return rssItems;
  const merged = [...tree, ...rssItems];
  merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return merged.slice(0, 70);
}

// Server-Sent Events: pushes Tree News headlines to open clients the moment
// they arrive, so market-moving news (war, tariffs, presidential posts) hits
// the screen in seconds instead of on the next polling tick.
// EventSource can't send an Authorization header, so the Supabase JWT rides
// as a query param and is verified the same way authMiddleware does it.
// Every pushed Tree News headline lands in the archive the moment it
// arrives, regardless of whether any client is connected.
onTreeNewsItem(item => archiveNewsItems([item]));

// Searchable headline history. Fail-open: if migration 026 hasn't been
// applied yet, returns an empty list with available:false instead of a 500.
router.get('/news-archive', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await searchNewsArchive({
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      from: typeof req.query.from === 'string' ? req.query.from : undefined,
      to: typeof req.query.to === 'string' ? req.query.to : undefined,
      limit: Number(req.query.limit) || undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/news-stream', async (req: Request, res: Response) => {
  const token = String(req.query.token ?? '').trim();
  if (!token) return res.status(401).json({ error: 'Token required' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = onTreeNewsItem(item => {
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  });
  // Heartbeat comment keeps proxies from killing the idle connection.
  const heartbeat = setInterval(() => res.write(': hb\n\n'), 25_000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

export default router;
