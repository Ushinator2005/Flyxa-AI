import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';

const router = Router();

const ALLOWED_INTERVALS = new Set(['1m', '5m', '15m', '1h', '1d']);
const ALLOWED_RANGES = new Set(['1d', '5d', '1mo', '3mo', '1y']);
const X_MAX_ACCOUNTS = 10;
const X_POSTS_PER_ACCOUNT = 10;

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

type XUserLookupResponse = {
  data?: Array<{ id: string; username: string; name?: string }>;
};

type XUserPostsResponse = {
  data?: Array<{ id: string; text: string; created_at?: string }>;
};

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
