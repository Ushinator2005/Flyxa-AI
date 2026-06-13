import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
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

function getCalendarEventKey(event: Record<string, unknown>): string {
  return [
    String(event.date ?? ''),
    String(event.time ?? ''),
    String(event.country ?? ''),
    String(event.title ?? event.event ?? ''),
  ].join('|').toLowerCase();
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
      return res.json(dedupeCalendarEvents(combinedJson));
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
      return res.json(dedupeCalendarEvents(combinedXml));
    }

    return res.json([]);
  } catch (error) {
    return next(error);
  }
});

router.get('/x-news', authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bearerToken = process.env.X_BEARER_TOKEN?.trim();
    const usernames = getConfiguredXUsernames(req.query.accounts);

    if (!bearerToken || usernames.length === 0) {
      return res.json([]);
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
    return res.json(combined.slice(0, 50));
  } catch (error) {
    return next(error);
  }
});

export default router;
