import WebSocket from 'ws';

// Tree News (news.treeofalpha.com) — a free public WebSocket that pushes
// market headlines the moment they publish. The fastest free news source
// there is; crypto-heavy but carries the major macro headlines too.
//
// One persistent connection per backend process feeds a small in-memory
// ring buffer; /api/market-data/rss-news merges the buffer into its
// response, so headlines reach clients on their next refresh tick with
// zero polling latency on our side.
//
// Opt out with TREE_NEWS_ENABLED=false.

const TREE_NEWS_URL = 'wss://news.treeofalpha.com/ws';
const BUFFER_MAX = 60;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

export interface TreeNewsItem {
  headline: string;
  source: string;
  timestamp: string;
  summary: string;
  url: string;
}

const buffer: TreeNewsItem[] = [];
let socket: WebSocket | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let stopped = false;

// Live subscribers (SSE clients) — notified the instant a new item lands.
type TreeNewsListener = (item: TreeNewsItem) => void;
const listeners = new Set<TreeNewsListener>();

/** Subscribe to new items as they arrive; returns an unsubscribe function. */
export function onTreeNewsItem(listener: TreeNewsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function pushItem(item: TreeNewsItem): void {
  // Dedupe on headline — Tree occasionally re-sends.
  if (buffer.some(existing => existing.headline === item.headline)) return;
  buffer.unshift(item);
  if (buffer.length > BUFFER_MAX) buffer.length = BUFFER_MAX;
  for (const listener of listeners) {
    try { listener(item); } catch { /* one bad client must not break the rest */ }
  }
}

// Tree messages vary by origin (native, Twitter relay, Telegram relay).
// Parse defensively: take whatever title/body/link/time fields exist.
function parseMessage(raw: WebSocket.RawData): TreeNewsItem | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const title = typeof data.title === 'string' ? data.title.trim() : '';
  const body = typeof data.body === 'string' ? data.body.trim() : '';

  // Twitter-relayed messages put the author in `title` ("WOO X (@_WOO_X)")
  // and the actual tweet in `body` — show the tweet, credit the handle.
  const handleMatch = title.match(/^(.{0,60}?)\s*\(@([A-Za-z0-9_]{1,15})\)$/);
  const isTwitterRelay = Boolean(handleMatch && body);

  const headline = (isTwitterRelay ? body : title || body).replace(/\s+/g, ' ').slice(0, 300);
  if (!headline) return null;

  const source = isTwitterRelay && handleMatch ? `@${handleMatch[2]}` : 'Tree News';

  const url =
    (typeof data.url === 'string' && data.url) ||
    (typeof data.link === 'string' && data.link) ||
    '';

  const timeMs = typeof data.time === 'number' ? data.time : Date.now();
  const parsed = new Date(timeMs);

  return {
    headline,
    source,
    timestamp: Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString(),
    summary: body && body !== headline ? body.replace(/\s+/g, ' ').slice(0, 300) : headline,
    url,
  };
}

function connect(): void {
  if (stopped) return;
  try {
    socket = new WebSocket(TREE_NEWS_URL);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  socket.on('open', () => {
    reconnectDelay = RECONNECT_BASE_MS;
    console.log('Tree News: connected');
  });

  socket.on('message', (raw) => {
    const item = parseMessage(raw);
    if (item) pushItem(item);
  });

  socket.on('close', () => {
    socket = null;
    scheduleReconnect();
  });

  socket.on('error', (err) => {
    console.error('Tree News socket error:', err.message);
    socket?.close();
  });
}

function scheduleReconnect(): void {
  if (stopped) return;
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

export function startTreeNews(): void {
  if (process.env.TREE_NEWS_ENABLED === 'false') {
    console.log('Tree News: disabled via TREE_NEWS_ENABLED=false');
    return;
  }
  stopped = false;
  connect();
}

export function stopTreeNews(): void {
  stopped = true;
  socket?.close();
  socket = null;
}

/** Latest pushed headlines, newest first, capped for feed merging. */
export function getTreeNewsItems(limit = 20): TreeNewsItem[] {
  return buffer.slice(0, limit);
}
