import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  BarChart3,
  ChevronLeft,
  Clock3,
  DollarSign,
  Download,
  ExternalLink,
  Filter,
  FileUp,
  Layers3,
  Minus,
  MousePointer2,
  Pause,
  Play,
  PlayCircle,
  Plus,
  Search,
  Square,
  StepForward,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { format } from 'date-fns';
import Modal from '../components/common/Modal.js';
import { lookupContract } from '../constants/futuresContracts.js';
import { marketDataApi } from '../services/api.js';
import { Trade } from '../types/index.js';
import { formatCurrency, formatDuration, getSession } from '../utils/calculations.js';
import { formatRiskRewardRatio } from '../utils/riskReward.js';
import useFlyxaStore from '../store/flyxaStore.js';

declare global {
  interface Window {
    LightweightCharts?: {
      createChart: (container: HTMLElement, options: Record<string, unknown>) => {
        addCandlestickSeries: (options?: Record<string, unknown>) => {
          setData: (data: Array<Record<string, unknown>>) => void;
          priceToCoordinate: (price: number) => number | null;
          coordinateToPrice: (coordinate: number) => number | null;
          createPriceLine: (options: Record<string, unknown>) => unknown;
          removePriceLine: (line: unknown) => void;
        };
        applyOptions: (options: Record<string, unknown>) => void;
        remove: () => void;
        timeScale: () => {
          fitContent?: () => void;
          logicalToCoordinate: (logical: number) => number | null;
          coordinateToLogical: (coordinate: number) => number | null;
        };
      };
    };
  }
}

type ReplayTimeframe = '1m' | '5m' | '15m' | '1H' | '1D';
type ReplayRange = '1D' | '5D' | '1M' | '3M' | '1Y';
type ToolMode = 'cursor' | 'horizontal' | 'trendline' | 'rectangle';
type TradeDirection = 'Long' | 'Short';
type ExitReason = 'TP' | 'SL';

interface ReplayCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ReplaySession {
  symbol: string;
  timeframe: ReplayTimeframe;
  range: ReplayRange;
  timeframeMinutes: number;
  candles: ReplayCandle[];
  pointValue: number;
  tickSize: number;
}

interface TradeDraft {
  direction: TradeDirection | null;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  quantity: string;
  notes: string;
}

interface TradeIntent {
  id: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  notes: string;
  pointValue: number;
  placedIndex: number;
  placedTime: number;
}

interface ActiveReplayTrade extends TradeIntent {
  currentPrice: number;
  pnlPoints: number;
  pnlDollars: number;
  durationSeconds: number;
  candlesHeld: number;
}

interface ClosedReplayTrade extends TradeIntent {
  exitPrice: number;
  exitReason: ExitReason;
  exitIndex: number;
  exitTime: number;
  pnlPoints: number;
  pnlDollars: number;
  candlesHeld: number;
  durationSeconds: number;
  outcome: 'Win' | 'Loss';
  rAchieved: number;
}

interface ReplaySimulation {
  activeTrade: ActiveReplayTrade | null;
  closedTrades: ClosedReplayTrade[];
  placedTrades: number;
}

interface PlacementPoint {
  index: number;
  price: number;
}

interface HorizontalDrawing {
  id: string;
  type: 'horizontal';
  price: number;
}

interface TrendlineDrawing {
  id: string;
  type: 'trendline';
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
}

interface RectangleDrawing {
  id: string;
  type: 'rectangle';
  startIndex: number;
  endIndex: number;
  topPrice: number;
  bottomPrice: number;
}

type ReplayDrawing = HorizontalDrawing | TrendlineDrawing | RectangleDrawing;

type ProjectedDrawing =
  | { id: string; type: 'horizontal' | 'trendline'; x1: number; y1: number; x2: number; y2: number }
  | { id: string; type: 'rectangle'; x: number; y: number; width: number; height: number };

interface ReplaySymbolSuggestion {
  symbol: string;
  label: string;
  description: string;
}

interface SavedSession {
  id: string;
  symbol: string;
  timeframe: ReplayTimeframe;
  range: ReplayRange;
  startDate: string;
  endDate: string;
  balance: number;
  openedAt: string;
  isActive: boolean;
}

const CHART_SCRIPT_SRC = 'https://unpkg.com/lightweight-charts@4.1.1/dist/lightweight-charts.standalone.production.js';
const BACKTEST_PREFILL_KEY = 'tw_backtest_trade_prefill';

const BACKTEST_LIBRARY_THEME = {
  '--bg': 'var(--app-bg)',
  '--surface-1': 'var(--app-panel)',
  '--surface-2': 'var(--app-panel-strong)',
  '--border': 'var(--app-border)',
  '--border-sub': 'rgba(255,255,255,0.05)',
  '--txt': 'var(--app-text)',
  '--txt-2': 'var(--app-text-muted)',
  '--txt-3': 'var(--app-text-subtle)',
  '--amber': 'var(--accent)',
  '--amber-dim': 'var(--accent-dim)',
  '--amber-border': 'var(--accent-border)',
  '--cobalt': '#6EA8FE',
  '--cobalt-dim': 'rgba(110,168,254,0.14)',
  '--green': '#34D399',
  '--green-dim': 'rgba(52,211,153,0.14)',
  '--danger': '#F87171',
} as React.CSSProperties;

const TIMEFRAME_OPTIONS: Array<{ label: ReplayTimeframe; interval: string; minutes: number }> = [
  { label: '1m', interval: '1m', minutes: 1 },
  { label: '5m', interval: '5m', minutes: 5 },
  { label: '15m', interval: '15m', minutes: 15 },
  { label: '1H', interval: '1h', minutes: 60 },
  { label: '1D', interval: '1d', minutes: 1440 },
];

const RANGE_OPTIONS: Array<{ label: ReplayRange; range: string }> = [
  { label: '1D', range: '1d' },
  { label: '5D', range: '5d' },
  { label: '1M', range: '1mo' },
  { label: '3M', range: '3mo' },
  { label: '1Y', range: '1y' },
];

const QUICK_SYMBOLS = ['NQM6', 'ESM6', 'NQ=F', 'ES=F'];
const REPLAY_SYMBOL_SUGGESTIONS: ReplaySymbolSuggestion[] = [
  { symbol: 'NQM6', label: 'NQM6', description: 'Nasdaq futures Jun 2026 contract' },
  { symbol: 'ESM6', label: 'ESM6', description: 'S&P futures Jun 2026 contract' },
  { symbol: 'NQ=F', label: 'NQ=F', description: 'Nasdaq futures continuous contract' },
  { symbol: 'ES=F', label: 'ES=F', description: 'S&P futures continuous contract' },
  { symbol: 'YM=F', label: 'YM=F', description: 'Dow futures continuous contract' },
  { symbol: 'RTY=F', label: 'RTY=F', description: 'Russell futures continuous contract' },
  { symbol: 'GC=F', label: 'GC=F', description: 'Gold futures continuous contract' },
  { symbol: 'CL=F', label: 'CL=F', description: 'Crude oil futures continuous contract' },
  { symbol: 'EURUSD=X', label: 'EURUSD=X', description: 'Euro / US Dollar' },
  { symbol: 'GBPUSD=X', label: 'GBPUSD=X', description: 'British Pound / US Dollar' },
  { symbol: 'USDJPY=X', label: 'USDJPY=X', description: 'US Dollar / Japanese Yen' },
  { symbol: 'AAPL', label: 'AAPL', description: 'Apple' },
  { symbol: 'NVDA', label: 'NVDA', description: 'NVIDIA' },
  { symbol: 'MSFT', label: 'MSFT', description: 'Microsoft' },
  { symbol: 'TSLA', label: 'TSLA', description: 'Tesla' },
];

let chartsLoaderPromise: Promise<void> | null = null;

function loadLightweightChartsScript() {
  if (window.LightweightCharts) return Promise.resolve();
  if (chartsLoaderPromise) return chartsLoaderPromise;

  chartsLoaderPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHART_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load Lightweight Charts.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = CHART_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Lightweight Charts.'));
    document.body.appendChild(script);
  });

  return chartsLoaderPromise;
}

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function inferInstrumentMeta(symbol: string, fallbackPrice = 0) {
  const normalized = symbol.toUpperCase();
  if (normalized.endsWith('=F')) {
    const contract = lookupContract(normalized.replace('=F', ''));
    if (contract) return { pointValue: contract.point_value, tickSize: contract.tick_size };
  }
  if (normalized.endsWith('=X')) return { pointValue: 100000, tickSize: 0.0001 };
  const contract = lookupContract(normalized);
  if (contract) return { pointValue: contract.point_value, tickSize: contract.tick_size };
  return { pointValue: 1, tickSize: fallbackPrice < 10 ? 0.0001 : 0.01 };
}

function getPricePrecision(tickSize: number) {
  if (tickSize <= 0) return 2;
  const decimals = tickSize.toString().split('.')[1]?.length ?? 0;
  return Math.min(Math.max(decimals, 2), 5);
}

function formatPrice(value: number, tickSize: number) {
  return value.toFixed(getPricePrecision(tickSize));
}

function formatPoints(value: number, tickSize: number) {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(getPricePrecision(tickSize))}`;
}

function normalizeJournalSymbol(symbol: string) {
  if (symbol.endsWith('=F')) return symbol.replace('=F', '');
  if (symbol.endsWith('=X')) return symbol.replace('=X', '');
  return symbol;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseCsvTimestamp(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }

  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor(parsed.getTime() / 1000);
}

function parseCandleCsv(csv: string): ReplayCandle[] {
  const lines = csv
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error('CSV needs a header row and at least one candle row.');
  }

  const headers = parseCsvLine(lines[0]).map(header => header.trim().toLowerCase());
  const indexFor = (...names: string[]) => names.map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1;
  const timeIndex = indexFor('time', 'timestamp', 'date', 'datetime');
  const openIndex = indexFor('open', 'o');
  const highIndex = indexFor('high', 'h');
  const lowIndex = indexFor('low', 'l');
  const closeIndex = indexFor('close', 'c');
  const volumeIndex = indexFor('volume', 'vol', 'v');

  if ([timeIndex, openIndex, highIndex, lowIndex, closeIndex].some(index => index < 0)) {
    throw new Error('CSV must include time, open, high, low, and close columns.');
  }

  const candles: ReplayCandle[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const time = parseCsvTimestamp(cells[timeIndex] ?? '');
    const open = Number(cells[openIndex]);
    const high = Number(cells[highIndex]);
    const low = Number(cells[lowIndex]);
    const close = Number(cells[closeIndex]);
    const volume = volumeIndex >= 0 ? Number(cells[volumeIndex]) : 0;

    if (
      time === null ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }

    candles.push({
      time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }

  const unique = new Map<number, ReplayCandle>();
  candles.forEach(candle => unique.set(candle.time, candle));
  const sorted = Array.from(unique.values()).sort((a, b) => a.time - b.time);

  if (sorted.length < 2) {
    throw new Error('CSV did not contain enough valid candle rows.');
  }

  return sorted;
}

function createInitialDraft(price: number, tickSize: number, quantity = '1'): TradeDraft {
  return {
    direction: null,
    entryPrice: formatPrice(price, tickSize),
    stopLoss: '',
    takeProfit: '',
    quantity,
    notes: '',
  };
}

function calculatePnL(direction: TradeDirection, entry: number, exit: number, quantity: number, pointValue: number) {
  const pnlPoints = direction === 'Long' ? exit - entry : entry - exit;
  return { pnlPoints, pnlDollars: pnlPoints * quantity * pointValue };
}

function simulateTrades(candles: ReplayCandle[], revealedCount: number, intents: TradeIntent[]): ReplaySimulation {
  const closedTrades: ClosedReplayTrade[] = [];
  let activeTrade: ActiveReplayTrade | null = null;

  intents
    .filter(intent => intent.placedIndex < revealedCount)
    .forEach(intent => {
      let closedTrade: ClosedReplayTrade | null = null;

      for (let index = intent.placedIndex + 1; index < revealedCount; index++) {
        const candle = candles[index];
        const hitStop = intent.direction === 'Long' ? candle.low <= intent.stopLoss : candle.high >= intent.stopLoss;
        const hitTarget = intent.direction === 'Long' ? candle.high >= intent.takeProfit : candle.low <= intent.takeProfit;

        if (!hitStop && !hitTarget) continue;

        const exitReason: ExitReason = hitStop ? 'SL' : 'TP';
        const exitPrice = exitReason === 'SL' ? intent.stopLoss : intent.takeProfit;
        const { pnlPoints, pnlDollars } = calculatePnL(intent.direction, intent.entryPrice, exitPrice, intent.quantity, intent.pointValue);
        const riskPoints = Math.abs(intent.entryPrice - intent.stopLoss) || 1;

        closedTrade = {
          ...intent,
          exitPrice,
          exitReason,
          exitIndex: index,
          exitTime: candle.time,
          pnlPoints,
          pnlDollars,
          candlesHeld: Math.max(index - intent.placedIndex, 1),
          durationSeconds: Math.max(candle.time - intent.placedTime, 60),
          outcome: pnlDollars >= 0 ? 'Win' : 'Loss',
          rAchieved: pnlPoints / riskPoints,
        };
        break;
      }

      if (closedTrade) { closedTrades.push(closedTrade); return; }

      const currentCandle = candles[revealedCount - 1];
      const { pnlPoints, pnlDollars } = calculatePnL(intent.direction, intent.entryPrice, currentCandle.close, intent.quantity, intent.pointValue);
      activeTrade = {
        ...intent,
        currentPrice: currentCandle.close,
        pnlPoints,
        pnlDollars,
        candlesHeld: Math.max((revealedCount - 1) - intent.placedIndex, 0),
        durationSeconds: Math.max(currentCandle.time - intent.placedTime, 0),
      };
    });

  return { activeTrade, closedTrades, placedTrades: intents.filter(intent => intent.placedIndex < revealedCount).length };
}

function buildSessionCsv(closedTrades: ClosedReplayTrade[]) {
  const header = ['symbol','direction','entry_time','exit_time','entry_price','exit_price','stop_loss','take_profit','quantity','outcome','exit_reason','pnl_points','pnl_dollars','r_achieved','candles_held','duration_seconds','notes'];
  const rows = closedTrades.map(trade => ([
    trade.symbol, trade.direction,
    new Date(trade.placedTime * 1000).toISOString(),
    new Date(trade.exitTime * 1000).toISOString(),
    trade.entryPrice, trade.exitPrice, trade.stopLoss, trade.takeProfit,
    trade.quantity, trade.outcome, trade.exitReason, trade.pnlPoints,
    trade.pnlDollars, trade.rAchieved, trade.candlesHeld, trade.durationSeconds,
    trade.notes.replace(/\r?\n/g, ' '),
  ]));
  return [header, ...rows].map(cols => cols.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

function getTradePrefill(session: ReplaySession, trade: ClosedReplayTrade): Partial<Trade> {
  const entryDate = new Date(trade.placedTime * 1000);
  const exitDate = new Date(trade.exitTime * 1000);
  return {
    symbol: normalizeJournalSymbol(session.symbol),
    direction: trade.direction,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    sl_price: trade.stopLoss,
    tp_price: trade.takeProfit,
    exit_reason: trade.exitReason,
    contract_size: trade.quantity,
    point_value: trade.pointValue,
    trade_date: format(entryDate, 'yyyy-MM-dd'),
    trade_time: format(entryDate, 'HH:mm'),
    trade_length_seconds: trade.durationSeconds,
    candle_count: trade.candlesHeld,
    timeframe_minutes: session.timeframeMinutes,
    emotional_state: 'Calm',
    confidence_level: 7,
    pre_trade_notes: trade.notes,
    post_trade_notes: `${trade.outcome} via ${trade.exitReason} after ${trade.candlesHeld} candles in replay.`,
    followed_plan: true,
    pnl: trade.pnlDollars,
    session: getSession(format(exitDate, 'HH:mm')) as Trade['session'],
  };
}

function getProjectedPoint(
  chart: ReturnType<NonNullable<typeof window.LightweightCharts>['createChart']>,
  series: ReturnType<ReturnType<NonNullable<typeof window.LightweightCharts>['createChart']>['addCandlestickSeries']>,
  index: number,
  price: number
) {
  const x = chart.timeScale().logicalToCoordinate(index);
  const y = series.priceToCoordinate(price);
  if (x === null || y === null) return null;
  return { x, y };
}

export default function Backtest() {
  const navigate = useNavigate();
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const symbolSearchRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ReturnType<NonNullable<typeof window.LightweightCharts>['createChart']> | null>(null);
  const seriesRef = useRef<ReturnType<ReturnType<NonNullable<typeof window.LightweightCharts>['createChart']>['addCandlestickSeries']> | null>(null);
  const priceLinesRef = useRef<{ entry: unknown | null; stop: unknown | null; target: unknown | null }>({ entry: null, stop: null, target: null });

  const [symbol, setSymbol] = useState('NQM6');
  const [timeframe, setTimeframe] = useState<ReplayTimeframe>('5m');
  const [range, setRange] = useState<ReplayRange>('5D');
  const [session, setSession] = useState<ReplaySession | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [chartReady, setChartReady] = useState(false);
  const [revealedCount, setRevealedCount] = useState(0);
  const [speed, setSpeed] = useState(5);
  const [isPlaying, setIsPlaying] = useState(false);
  const [toolMode, setToolMode] = useState<ToolMode>('cursor');
  const [pendingPoint, setPendingPoint] = useState<PlacementPoint | null>(null);
  const [drawings, setDrawings] = useState<ReplayDrawing[]>([]);
  const [tradeDraft, setTradeDraft] = useState<TradeDraft>(createInitialDraft(0, 0.25));
  const [syncEntryToCurrentClose, setSyncEntryToCurrentClose] = useState(true);
  const [tradeIntents, setTradeIntents] = useState<TradeIntent[]>([]);
  const [tradeError, setTradeError] = useState('');
  const [resultTrade, setResultTrade] = useState<ClosedReplayTrade | null>(null);
  const [dismissedResultIds, setDismissedResultIds] = useState<string[]>([]);
  const [chartBox, setChartBox] = useState({ width: 0, height: 0 });
  const [showSymbolSuggestions, setShowSymbolSuggestions] = useState(false);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);

  // Session library state
  const savedSessions = useFlyxaStore(state => state.backtestSessions) as SavedSession[];
  const setBacktestSessionsAction = useFlyxaStore(state => state.setBacktestSessions);
  const [showNewSessionForm, setShowNewSessionForm] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [startingBalance, setStartingBalance] = useState('25000');
  const [csvCandles, setCsvCandles] = useState<ReplayCandle[] | null>(null);
  const [csvFileName, setCsvFileName] = useState('');

  const displayedCandles = useMemo(() => session?.candles.slice(0, revealedCount) ?? [], [session, revealedCount]);
  const currentCandle = displayedCandles[displayedCandles.length - 1] ?? null;
  const simulation = useMemo(
    () => session ? simulateTrades(session.candles, revealedCount, tradeIntents) : { activeTrade: null, closedTrades: [], placedTrades: 0 },
    [session, revealedCount, tradeIntents]
  );
  const latestClosedTrade = simulation.closedTrades[simulation.closedTrades.length - 1] ?? null;

  const sessionStats = useMemo(() => {
    const wins = simulation.closedTrades.filter(t => t.pnlDollars > 0);
    const losses = simulation.closedTrades.filter(t => t.pnlDollars < 0);
    const grossProfit = wins.reduce((sum, t) => sum + t.pnlDollars, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlDollars, 0));
    return {
      tradesTaken: simulation.placedTrades,
      winRate: simulation.closedTrades.length ? (wins.length / simulation.closedTrades.length) * 100 : 0,
      totalPnL: simulation.closedTrades.reduce((sum, t) => sum + t.pnlDollars, 0),
      avgWin: wins.length ? grossProfit / wins.length : 0,
      avgLoss: losses.length ? losses.reduce((sum, t) => sum + t.pnlDollars, 0) / losses.length : 0,
      profitFactor: grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLoss,
    };
  }, [simulation.closedTrades, simulation.placedTrades]);

  const timeframeMeta = TIMEFRAME_OPTIONS.find(o => o.label === timeframe)!;
  const rangeMeta = RANGE_OPTIONS.find(o => o.label === range)!;
  const filteredSymbolSuggestions = useMemo(() => {
    const q = symbol.trim().toUpperCase();
    if (!q) return REPLAY_SYMBOL_SUGGESTIONS.slice(0, 8);
    return REPLAY_SYMBOL_SUGGESTIONS.filter(item =>
      item.symbol.toUpperCase().startsWith(q) ||
      item.label.toUpperCase().startsWith(q) ||
      item.description.toUpperCase().includes(q)
    ).slice(0, 8);
  }, [symbol]);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (!symbolSearchRef.current?.contains(e.target as Node)) setShowSymbolSuggestions(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    if (!latestClosedTrade || dismissedResultIds.includes(latestClosedTrade.id)) return;
    setResultTrade(latestClosedTrade);
    setDismissedResultIds(curr => [...curr, latestClosedTrade.id]);
  }, [latestClosedTrade, dismissedResultIds]);

  useEffect(() => {
    if (!session || !currentCandle || !syncEntryToCurrentClose || simulation.activeTrade) return;
    setTradeDraft(d => ({ ...d, entryPrice: formatPrice(currentCandle.close, session.tickSize) }));
  }, [currentCandle, session, syncEntryToCurrentClose, simulation.activeTrade]);

  useEffect(() => {
    if (!isPlaying || !session) return;
    const interval = window.setInterval(() => {
      setRevealedCount(curr => {
        if (curr >= session.candles.length) { setIsPlaying(false); return curr; }
        const next = curr + 1;
        if (next >= session.candles.length) setIsPlaying(false);
        return next;
      });
    }, Math.max(25, 800 / speed));
    return () => window.clearInterval(interval);
  }, [isPlaying, speed, session]);

  useEffect(() => {
    if (!session || !chartContainerRef.current) return;
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    loadLightweightChartsScript()
      .then(() => {
        if (cancelled || !chartContainerRef.current || !window.LightweightCharts) return;
        const chart = window.LightweightCharts.createChart(chartContainerRef.current, {
          layout: { background: { color: '#020817' }, textColor: '#64748b' },
          grid: { vertLines: { color: 'rgba(30,41,59,0.6)' }, horzLines: { color: 'rgba(30,41,59,0.6)' } },
          rightPriceScale: { borderColor: 'rgba(30,41,59,0.8)' },
          timeScale: { borderColor: 'rgba(30,41,59,0.8)', timeVisible: session.timeframeMinutes < 1440, secondsVisible: false },
          crosshair: { vertLine: { color: 'rgba(96,165,250,0.35)', width: 1 }, horzLine: { color: 'rgba(96,165,250,0.35)', width: 1 } },
          handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
          handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });

        const series = chart.addCandlestickSeries({
          upColor: '#22c55e', downColor: '#ef4444',
          wickUpColor: '#22c55e', wickDownColor: '#ef4444',
          borderVisible: false,
        });

        chartRef.current = chart;
        seriesRef.current = series;
        setChartReady(true);
        setChartBox({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight });

        resizeObserver = new ResizeObserver(entries => {
          const entry = entries[0];
          if (!entry) return;
          chart.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height });
          setChartBox({ width: entry.contentRect.width, height: entry.contentRect.height });
        });
        resizeObserver.observe(chartContainerRef.current);
      })
      .catch(error => { if (!cancelled) setLoadError(error instanceof Error ? error.message : 'Failed to load chart library.'); });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      Object.values(priceLinesRef.current).forEach(line => {
        if (line && seriesRef.current) { try { seriesRef.current.removePriceLine(line); } catch { /* ignore */ } }
      });
      priceLinesRef.current = { entry: null, stop: null, target: null };
      chartRef.current?.remove();
      chartRef.current = null;
      seriesRef.current = null;
      setChartReady(false);
    };
  }, [session]);

  useEffect(() => {
    if (!chartReady || !seriesRef.current || !chartRef.current || !session) return;
    seriesRef.current.setData(displayedCandles.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));
  }, [displayedCandles, chartReady, session]);

  useEffect(() => {
    if (!chartReady || !chartRef.current || !session) return;
    chartRef.current.timeScale().fitContent?.();
  }, [chartReady, session]);

  useEffect(() => {
    if (!seriesRef.current) return;
    Object.values(priceLinesRef.current).forEach(line => {
      if (line) { try { seriesRef.current?.removePriceLine(line); } catch { /* ignore */ } }
    });
    priceLinesRef.current = { entry: null, stop: null, target: null };
    if (!simulation.activeTrade) return;
    priceLinesRef.current.entry = seriesRef.current.createPriceLine({ price: simulation.activeTrade.entryPrice, color: '#3b82f6', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'Entry' });
    priceLinesRef.current.stop = seriesRef.current.createPriceLine({ price: simulation.activeTrade.stopLoss, color: '#ef4444', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'SL' });
    priceLinesRef.current.target = seriesRef.current.createPriceLine({ price: simulation.activeTrade.takeProfit, color: '#22c55e', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'TP' });
  }, [simulation.activeTrade]);

  useEffect(() => { setPendingPoint(null); }, [toolMode]);

  const projectedDrawings = useMemo<ProjectedDrawing[]>(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series || !chartBox.width || !chartBox.height) return [];

    return drawings.reduce<ProjectedDrawing[]>((acc, drawing) => {
      if (drawing.type === 'horizontal') {
        const y = series.priceToCoordinate(drawing.price);
        if (y === null || y === undefined) return acc;
        acc.push({ id: drawing.id, type: drawing.type, x1: 12, y1: y, x2: Math.max(chartBox.width - 12, 12), y2: y });
        return acc;
      }
      if (drawing.type === 'trendline') {
        const start = getProjectedPoint(chart, series, drawing.startIndex, drawing.startPrice);
        const end = getProjectedPoint(chart, series, drawing.endIndex, drawing.endPrice);
        if (!start || !end) return acc;
        acc.push({ id: drawing.id, type: drawing.type, x1: start.x, y1: start.y, x2: end.x, y2: end.y });
        return acc;
      }
      const start = getProjectedPoint(chart, series, drawing.startIndex, drawing.topPrice);
      const end = getProjectedPoint(chart, series, drawing.endIndex, drawing.bottomPrice);
      if (!start || !end) return acc;
      acc.push({ id: drawing.id, type: drawing.type, x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) });
      return acc;
    }, []);
  }, [drawings, chartBox, displayedCandles.length]);

  useEffect(() => {
    if (!selectedDrawingId) return;
    if (!drawings.some(d => d.id === selectedDrawingId)) setSelectedDrawingId(null);
  }, [drawings, selectedDrawingId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName;
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;
      if (e.code === 'Space' && session) { e.preventDefault(); if (revealedCount < session.candles.length) setIsPlaying(curr => !curr); }
      if (e.key === 'ArrowRight' && session) { e.preventDefault(); setRevealedCount(curr => Math.min(curr + 1, session.candles.length)); }
      if (e.key === 'ArrowLeft' && session) { e.preventDefault(); setIsPlaying(false); setRevealedCount(curr => Math.max(curr - 1, 1)); }
      if (e.key === 'Escape') { e.preventDefault(); setPendingPoint(null); setToolMode('cursor'); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawingId) {
        e.preventDefault();
        setDrawings(curr => curr.filter(d => d.id !== selectedDrawingId));
        setSelectedDrawingId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [revealedCount, selectedDrawingId, session]);


  const handleDeleteSession = (id: string) => {
    if (!window.confirm('Remove this session from the library?')) return;
    setBacktestSessionsAction(savedSessions.filter(s => s.id !== id));
  };

  const handleOpenSession = async (sess: SavedSession) => {
    setSymbol(sess.symbol);
    setTimeframe(sess.timeframe);
    setRange(sess.range);
    setShowNewSessionForm(false);
    const openedAt = new Date().toISOString();
    setBacktestSessionsAction(savedSessions.map(item => (
      item.id === sess.id
        ? { ...item, openedAt, isActive: true }
        : { ...item, isActive: false }
    )));
    // Trigger load after state flushes
    setLoading(true);
    setLoadError('');
    setIsPlaying(false);
    setResultTrade(null);
    try {
      const tfMeta = TIMEFRAME_OPTIONS.find(o => o.label === sess.timeframe)!;
      const rMeta = RANGE_OPTIONS.find(o => o.label === sess.range)!;
      let candles = await marketDataApi
        .getCandles(sess.symbol, tfMeta.interval)
        .catch(() => []);
      if (candles.length < 2) {
        await marketDataApi.importDatabentoCandles({
          symbol: sess.symbol,
          timeframe: tfMeta.interval,
          range: rMeta.range,
        }).catch(() => null);
        candles = await marketDataApi
          .getCandles(sess.symbol, tfMeta.interval)
          .catch(() => []);
      }
      if (candles.length < 2) {
        candles = await marketDataApi.getChart(sess.symbol, tfMeta.interval, rMeta.range);
      }
      const instrumentMeta = inferInstrumentMeta(sess.symbol, candles[0]?.close ?? 0);
      const initialCount = Math.min(50, candles.length);
      setSession({ symbol: sess.symbol, timeframe: sess.timeframe, range: sess.range, timeframeMinutes: tfMeta.minutes, candles, pointValue: instrumentMeta.pointValue, tickSize: instrumentMeta.tickSize });
      setRevealedCount(initialCount);
      setTradeDraft(createInitialDraft(candles[initialCount - 1].close, instrumentMeta.tickSize));
      setSyncEntryToCurrentClose(true);
      setDrawings([]); setTradeIntents([]); setDismissedResultIds([]);
      setToolMode('cursor'); setPendingPoint(null); setTradeError(''); setSelectedDrawingId(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load replay data.');
    } finally {
      setLoading(false);
    }
  };

  const handleLoadReplay = async () => {
    setLoading(true);
    setLoadError('');
    setIsPlaying(false);
    setResultTrade(null);
    try {
      const normalizedSymbol = symbol.trim().toUpperCase();
      let candles = csvCandles;
      if (candles) {
        await marketDataApi.importCandles({
          symbol: normalizedSymbol,
          timeframe: timeframeMeta.interval,
          candles,
        });
      } else {
        const savedCandles = await marketDataApi
          .getCandles(normalizedSymbol, timeframeMeta.interval)
          .catch(() => []);
        if (savedCandles.length >= 2) {
          candles = savedCandles;
        } else {
          await marketDataApi.importDatabentoCandles({
            symbol: normalizedSymbol,
            timeframe: timeframeMeta.interval,
            range: rangeMeta.range,
          }).catch(() => null);
          const databentoCandles = await marketDataApi
            .getCandles(normalizedSymbol, timeframeMeta.interval)
            .catch(() => []);
          candles = databentoCandles.length >= 2
            ? databentoCandles
            : await marketDataApi.getChart(normalizedSymbol, timeframeMeta.interval, rangeMeta.range);
        }
      }
      const instrumentMeta = inferInstrumentMeta(normalizedSymbol, candles[0]?.close ?? 0);
      const initialCount = Math.min(50, candles.length);
      setSession({ symbol: normalizedSymbol, timeframe, range, timeframeMinutes: timeframeMeta.minutes, candles, pointValue: instrumentMeta.pointValue, tickSize: instrumentMeta.tickSize });
      setRevealedCount(initialCount);
      setTradeDraft(createInitialDraft(candles[initialCount - 1].close, instrumentMeta.tickSize));
      setSyncEntryToCurrentClose(true);
      setDrawings([]);
      setTradeIntents([]);
      setDismissedResultIds([]);
      setToolMode('cursor');
      setPendingPoint(null);
      setTradeError('');
      setSelectedDrawingId(null);
      setShowNewSessionForm(false);
      // Auto-save to session library
      const toDate = (ts: number) => new Date(ts * 1000).toISOString().split('T')[0];
      const newSaved: SavedSession = {
        id: makeId('sess'),
        symbol: normalizedSymbol,
        timeframe,
        range,
        startDate: candles[0] ? toDate(candles[0].time) : '',
        endDate: candles[candles.length - 1] ? toDate(candles[candles.length - 1].time) : '',
        balance: Number(startingBalance) || 25000,
        openedAt: new Date().toISOString(),
        isActive: true,
      };
      setBacktestSessionsAction([
        newSaved,
        ...savedSessions
          .filter(s => !(s.symbol === normalizedSymbol && s.timeframe === timeframe && s.range === range))
          .map(s => ({ ...s, isActive: false }))
          .slice(0, 49),
      ]);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load replay data.');
    } finally {
      setLoading(false);
    }
  };

  const resetToStart = () => {
    setIsPlaying(false);
    setSession(null);
    setRevealedCount(0);
    setTradeDraft(createInitialDraft(0, 0.25));
    setDrawings([]);
    setTradeIntents([]);
    setPendingPoint(null);
    setTradeError('');
    setResultTrade(null);
    setDismissedResultIds([]);
    setToolMode('cursor');
    setSyncEntryToCurrentClose(true);
    setSelectedDrawingId(null);
  };

  const handleStepForward = () => {
    if (!session) return;
    setRevealedCount(curr => Math.min(curr + 1, session.candles.length));
  };

  const handleStepBackward = () => {
    setIsPlaying(false);
    setRevealedCount(curr => Math.max(curr - 1, 1));
  };

  const updateDraft = (field: keyof TradeDraft, value: string | TradeDirection | null) => {
    setTradeError('');
    if (field === 'entryPrice') setSyncEntryToCurrentClose(false);
    setTradeDraft(d => ({ ...d, [field]: value }));
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!session || toolMode === 'cursor' || !chartRef.current || !seriesRef.current) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - bounds.left;
    const y = e.clientY - bounds.top;
    const logical = chartRef.current.timeScale().coordinateToLogical(x);
    const price = seriesRef.current.coordinateToPrice(y);
    if (price === null || price === undefined) return;

    const point: PlacementPoint = {
      index: Math.max(0, Math.min(revealedCount - 1, Math.round(logical ?? (revealedCount - 1)))),
      price,
    };

    if (toolMode === 'horizontal') {
      const id = makeId('drawing');
      setDrawings(curr => [...curr, { id, type: 'horizontal', price: point.price }]);
      setSelectedDrawingId(id);
      return;
    }

    if (!pendingPoint) { setPendingPoint(point); return; }

    if (toolMode === 'trendline') {
      const id = makeId('drawing');
      setDrawings(curr => [...curr, { id, type: 'trendline', startIndex: pendingPoint.index, endIndex: point.index, startPrice: pendingPoint.price, endPrice: point.price }]);
      setSelectedDrawingId(id);
    }

    if (toolMode === 'rectangle') {
      const id = makeId('drawing');
      setDrawings(curr => [...curr, { id, type: 'rectangle', startIndex: pendingPoint.index, endIndex: point.index, topPrice: Math.max(pendingPoint.price, point.price), bottomPrice: Math.min(pendingPoint.price, point.price) }]);
      setSelectedDrawingId(id);
    }

    setPendingPoint(null);
  };

  const handleSymbolSuggestionSelect = (value: string) => {
    setSymbol(value);
    setShowSymbolSuggestions(false);
  };

  const handleCsvFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setLoadError('');
    try {
      const text = await file.text();
      const candles = parseCandleCsv(text);
      setCsvCandles(candles);
      setCsvFileName(file.name);
      setRange('1D');
    } catch (error) {
      setCsvCandles(null);
      setCsvFileName('');
      setLoadError(error instanceof Error ? error.message : 'Could not read this CSV file.');
    }
  };

  const handlePlaceTrade = () => {
    if (!session || !currentCandle || simulation.activeTrade) return;
    const direction = tradeDraft.direction;
    const entryPrice = Number(tradeDraft.entryPrice);
    const stopLoss = Number(tradeDraft.stopLoss);
    const takeProfit = Number(tradeDraft.takeProfit);
    const quantity = Number(tradeDraft.quantity);

    if (!direction || !Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || !Number.isFinite(quantity) || quantity <= 0) {
      setTradeError('Fill Direction, Entry, Stop, Target, and Quantity before placing a trade.');
      return;
    }

    const validStructure = direction === 'Long' ? stopLoss < entryPrice && takeProfit > entryPrice : takeProfit < entryPrice && stopLoss > entryPrice;
    if (!validStructure) { setTradeError('Stop/target levels do not match the selected direction.'); return; }

    setTradeIntents(curr => [...curr, {
      id: makeId('trade'),
      symbol: session.symbol,
      direction, entryPrice, stopLoss, takeProfit, quantity,
      notes: tradeDraft.notes.trim(),
      pointValue: session.pointValue,
      placedIndex: revealedCount - 1,
      placedTime: currentCandle.time,
    }]);
    setTradeDraft(createInitialDraft(currentCandle.close, session.tickSize, tradeDraft.quantity || '1'));
    setSyncEntryToCurrentClose(true);
    setTradeError('');
  };

  const handleExportCsv = () => {
    if (!session || simulation.closedTrades.length === 0) return;
    const csv = buildSessionCsv(simulation.closedTrades);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${normalizeJournalSymbol(session.symbol)}-${session.timeframe}-${session.range}-replay.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleLogToJournal = () => {
    if (!session || !resultTrade) return;
    const prefill = getTradePrefill(session, resultTrade);
    sessionStorage.setItem(BACKTEST_PREFILL_KEY, JSON.stringify(prefill));
    setResultTrade(null);
    navigate('/');
  };

  const entryValue = Number(tradeDraft.entryPrice);
  const stopValue = Number(tradeDraft.stopLoss);
  const targetValue = Number(tradeDraft.takeProfit);
  const quantityValue = Number(tradeDraft.quantity);
  const stopDistance = Number.isFinite(entryValue) && Number.isFinite(stopValue) ? Math.abs(entryValue - stopValue) : null;
  const rewardDistance = Number.isFinite(entryValue) && Number.isFinite(targetValue) ? Math.abs(targetValue - entryValue) : null;
  const rrRatio = stopDistance && rewardDistance ? rewardDistance / stopDistance : null;
  const canPlaceTrade = Boolean(
    tradeDraft.direction && Number.isFinite(entryValue) && Number.isFinite(stopValue) &&
    Number.isFinite(targetValue) && Number.isFinite(quantityValue) && quantityValue > 0 && !simulation.activeTrade
  );

  // Library and session screens
  if (!session) {
    const S: React.CSSProperties = {}; // namespace helper (unused, just for reference)
    void S;

    const totalSessions = savedSessions.length;
    const marketsTested = new Set(savedSessions.map(s => s.symbol)).size;
    const avgBalance = totalSessions > 0
      ? savedSessions.reduce((n, s) => n + s.balance, 0) / totalSessions
      : 0;
    const filteredSessions = savedSessions.filter(s =>
      !sessionSearch.trim() || s.symbol.toUpperCase().includes(sessionSearch.trim().toUpperCase()),
    );
    const fmtCurrency = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
    const fmtOpened = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });


    // New session config form
    if (showNewSessionForm) {
      return (
        <div
          style={{
            ...BACKTEST_LIBRARY_THEME,
            minHeight: 'calc(100vh - 56px)',
            background: 'var(--bg)',
            padding: '32px clamp(20px, 4vw, 56px)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <div style={{ maxWidth: 1180, margin: '0 auto' }}>
          <div style={{ marginBottom: 28 }}>
            <button
              type="button"
              onClick={() => setShowNewSessionForm(false)}
              style={{ background: 'none', border: 'none', color: 'var(--txt-3)', cursor: 'pointer', fontSize: 12, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 26 }}
            >
              <ChevronLeft size={14} />
              Back to library
            </button>
            <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--amber)', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase' }}>
              Replay setup
            </p>
            <h1 style={{ margin: 0, color: 'var(--txt)', fontSize: 30, fontWeight: 700, lineHeight: 1.1 }}>
              Start a backtest session
            </h1>
            <p style={{ margin: '10px 0 0', color: 'var(--txt-2)', fontSize: 13, maxWidth: 620, lineHeight: 1.6 }}>
              Choose the market, timeframe, range, and account size. Flyxa will load the replay chart and open your trading workspace.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 18, alignItems: 'start' }}>
          <section style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 10, padding: 22 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1.4fr) repeat(3, minmax(120px, 0.7fr))', gap: 14, marginBottom: 18 }}>
              {/* Symbol */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-3)', margin: '0 0 7px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Market</p>
                <div ref={symbolSearchRef} style={{ position: 'relative' }}>
                  <Search size={15} style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', color: 'var(--txt-3)', pointerEvents: 'none' }} />
                  <input
                    type="text"
                    value={symbol}
                    onChange={e => { setSymbol(e.target.value.toUpperCase()); setShowSymbolSuggestions(true); }}
                    onFocus={() => setShowSymbolSuggestions(true)}
                    style={{ width: '100%', height: 44, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, paddingLeft: 40, paddingRight: 12, fontSize: 14, color: 'var(--txt)', outline: 'none', boxSizing: 'border-box', fontWeight: 600 }}
                    placeholder="NQ=F"
                  />
                  {showSymbolSuggestions && filteredSymbolSuggestions.length > 0 && (
                    <div style={{ position: 'absolute', left: 0, right: 0, top: 'calc(100% + 6px)', zIndex: 30, background: '#0a0909', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', boxShadow: '0 16px 36px rgba(0,0,0,0.46)' }}>
                      {filteredSymbolSuggestions.map(item => (
                        <button key={item.symbol} type="button" onClick={() => handleSymbolSuggestionSelect(item.symbol)}
                          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid var(--border-sub)', cursor: 'pointer', textAlign: 'left', color: 'var(--txt)' }}
                        >
                          <div>
                            <p style={{ fontSize: 13, fontWeight: 500 }}>{item.label}</p>
                            <p style={{ fontSize: 11, color: 'var(--txt-3)', marginTop: 2 }}>{item.description}</p>
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>{item.symbol}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p style={{ fontSize: 11, color: 'var(--txt-3)', margin: '8px 0 0', lineHeight: 1.4 }}>
                  Databento works best with exact futures contracts like NQM6 or ESM6.
                </p>
              </div>
              {/* Timeframe */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-3)', margin: '0 0 7px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Timeframe</p>
                <select value={timeframe} onChange={e => setTimeframe(e.target.value as ReplayTimeframe)}
                  style={{ width: '100%', height: 44, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, fontSize: 14, color: 'var(--txt)', padding: '0 12px', cursor: 'pointer', fontWeight: 600 }}>
                  {TIMEFRAME_OPTIONS.map(o => <option key={o.label} value={o.label}>{o.label}</option>)}
                </select>
              </div>
              {/* Range */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-3)', margin: '0 0 7px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Range</p>
                <select value={range} onChange={e => setRange(e.target.value as ReplayRange)}
                  style={{ width: '100%', height: 44, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, fontSize: 14, color: 'var(--txt)', padding: '0 12px', cursor: 'pointer', fontWeight: 600 }}>
                  {RANGE_OPTIONS.map(o => <option key={o.label} value={o.label}>{o.label}</option>)}
                </select>
              </div>
              {/* Starting Balance */}
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-3)', margin: '0 0 7px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Balance</p>
                <input type="number" value={startingBalance} onChange={e => setStartingBalance(e.target.value)}
                  style={{ width: '100%', height: 44, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 7, fontSize: 14, color: 'var(--txt)', padding: '0 12px', boxSizing: 'border-box', fontWeight: 600 }}
                  placeholder="25000" />
              </div>
            </div>

            {/* Quick symbols */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, borderTop: '1px solid var(--border)', paddingTop: 18 }}>
              <div>
                <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--txt-3)', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Quick markets</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {QUICK_SYMBOLS.map(qs => (
                <button key={qs} type="button" onClick={() => setSymbol(qs)}
                  style={{ background: symbol === qs ? 'var(--amber)' : 'var(--surface-2)', border: `1px solid ${symbol === qs ? 'var(--amber)' : 'var(--border)'}`, borderRadius: 6, padding: '7px 13px', fontSize: 12, color: symbol === qs ? '#161310' : 'var(--txt-3)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontWeight: 500, transition: 'background .1s, color .1s' }}>
                  {qs}
                </button>
              ))}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 18, padding: 14, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px dashed var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
                <div>
                  <p style={{ margin: 0, color: 'var(--txt)', fontSize: 13, fontWeight: 700 }}>Candle CSV</p>
                  <p style={{ margin: '5px 0 0', color: 'var(--txt-3)', fontSize: 12 }}>
                    Upload columns: time, open, high, low, close, volume
                  </p>
                </div>
                <label
                  style={{
                    height: 36,
                    padding: '0 13px',
                    borderRadius: 6,
                    border: '1px solid var(--amber-border)',
                    background: 'var(--amber-dim)',
                    color: 'var(--amber)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 800,
                  }}
                >
                  <FileUp size={14} />
                  Upload CSV
                  <input type="file" accept=".csv,text/csv" onChange={handleCsvFileSelected} style={{ display: 'none' }} />
                </label>
              </div>
              {csvCandles && (
                <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, color: 'var(--txt-2)', fontSize: 12 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--txt)' }}>{csvFileName}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                    {csvCandles.length.toLocaleString()} candles ready
                    <button
                      type="button"
                      onClick={() => { setCsvCandles(null); setCsvFileName(''); }}
                      style={{ background: 'none', border: 'none', color: 'var(--txt-3)', cursor: 'pointer', fontSize: 11, padding: 0 }}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              )}
            </div>

            {loadError && (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 7, padding: '11px 12px', fontSize: 12, color: '#f87171', margin: '16px 0 0' }}>
                <AlertCircle size={14} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>{loadError}</span>
              </div>
            )}

            <button type="button" onClick={handleLoadReplay} disabled={loading || !symbol.trim()}
              style={{ width: '100%', height: 48, background: 'var(--amber)', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 800, color: '#050505', cursor: 'pointer', opacity: loading || !symbol.trim() ? 0.5 : 1, marginTop: 18 }}>
              {loading ? 'Loading...' : 'Load replay'}
            </button>
          </section>

          <aside style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
            <p style={{ margin: '0 0 14px', fontSize: 11, color: 'var(--txt-3)', textTransform: 'uppercase', letterSpacing: '0.14em', fontWeight: 800 }}>
              Session preview
            </p>
            {[
              ['Market', symbol || 'Not selected'],
              ['Timeframe', timeframe],
              ['Range', range],
              ['Data source', csvCandles ? 'Uploaded CSV' : 'Backend feed'],
              ['Starting balance', Number(startingBalance || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 0', borderTop: '1px solid var(--border-sub)' }}>
                <span style={{ color: 'var(--txt-3)', fontSize: 12 }}>{label}</span>
                <span style={{ color: 'var(--txt)', fontSize: 13, fontWeight: 700, fontFamily: label === 'Market' ? 'var(--font-mono)' : undefined }}>{value}</span>
              </div>
            ))}
            <div style={{ marginTop: 18, padding: 14, borderRadius: 8, background: 'rgba(251,166,0,0.08)', border: '1px solid rgba(251,166,0,0.18)' }}>
              <p style={{ margin: 0, color: 'var(--amber)', fontSize: 12, fontWeight: 800 }}>Replay mode</p>
              <p style={{ margin: '6px 0 0', color: 'var(--txt-2)', fontSize: 12, lineHeight: 1.5 }}>
                {csvCandles
                  ? `${csvCandles.length.toLocaleString()} uploaded candles will be used for this replay.`
                  : 'No CSV selected. Flyxa will request candles from the current backend feed.'}
              </p>
            </div>
          </aside>
          </div>
          </div>
        </div>
      );
    }

    // Library view
    const activeSession = savedSessions.find(s => s.isActive) ?? null;
    const latestSession = [...savedSessions].sort(
      (a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime()
    )[0] ?? null;

    const statCards = [
      {
        label: 'Total Sessions',
        value: String(totalSessions),
        sub: 'saved replay sessions',
        Icon: Layers3,
        badgeBg: 'var(--amber-dim)',
        badgeColor: 'var(--amber)',
        badgeBorder: 'var(--amber-border)',
      },
      {
        label: 'Markets Tested',
        value: String(marketsTested),
        sub: 'unique symbols',
        Icon: BarChart3,
        badgeBg: 'var(--cobalt-dim)',
        badgeColor: 'var(--cobalt)',
        badgeBorder: 'var(--border)',
      },
      {
        label: 'Avg Starting Balance',
        value: totalSessions ? fmtCurrency(avgBalance) : '—',
        sub: 'across sessions',
        Icon: DollarSign,
        badgeBg: 'var(--green-dim)',
        badgeColor: 'var(--green)',
        badgeBorder: 'var(--border)',
      },
      {
        label: 'Last Opened',
        value: latestSession ? fmtOpened(latestSession.openedAt) : '—',
        sub: 'most recent session',
        Icon: Clock3,
        badgeBg: 'var(--surface-2)',
        badgeColor: 'var(--txt-2)',
        badgeBorder: 'var(--border)',
      },
    ] as const;

    return (
      <div
        style={{
          ...BACKTEST_LIBRARY_THEME,
          minHeight: 'calc(100vh - 56px)',
          overflowY: 'auto',
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 34%, var(--bg)) 0%, var(--bg) 280px)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <div
          data-tour-id="backtest-header"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 20,
            background: 'var(--bg)',
            borderBottom: '1px solid var(--border)',
            padding: '16px 28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div>
            <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', margin: '0 0 4px' }}>
              Backtest
            </p>
            <p style={{ fontSize: 18, fontWeight: 600, color: 'var(--txt)', margin: '0 0 3px', lineHeight: 1.2 }}>
              Backtest
            </p>
            <p style={{ fontSize: 12, color: 'var(--txt-2)', margin: 0 }}>
              TradingView replay shell ·{' '}
              <span style={{ color: 'var(--amber)', fontWeight: 500 }}>{totalSessions}</span>{' '}
              saved session{totalSessions !== 1 ? 's' : ''}
            </p>
          </div>

          <button
            type="button"
            data-tour-id="backtest-new-session"
            onClick={() => setShowNewSessionForm(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              background: 'var(--amber)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: 5,
              padding: '8px 14px',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Plus size={14} />
            New Session
          </button>
        </div>

        <div style={{ padding: '24px 28px 40px' }}>
          <div data-tour-id="backtest-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12, marginBottom: 20 }}>
            {statCards.map(card => (
              <div
                key={card.label}
                style={{
                  background: 'var(--surface-1)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 16,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: card.badgeBg,
                      border: `1px solid ${card.badgeBorder}`,
                      color: card.badgeColor,
                      display: 'grid',
                      placeItems: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <card.Icon size={16} />
                  </div>
                  <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', margin: 0 }}>
                    {card.label}
                  </p>
                </div>
                <p
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 22,
                    fontWeight: 500,
                    color: 'var(--txt)',
                    margin: '0 0 5px',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {card.value}
                </p>
                <p style={{ fontSize: 11, color: 'var(--txt-3)', margin: 0 }}>{card.sub}</p>
              </div>
            ))}
          </div>


          <div
            data-tour-id="backtest-current-focus"
            style={{
              marginBottom: 20,
              background: 'var(--surface-1)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '18px 22px',
              display: 'flex',
              alignItems: 'center',
              gap: 20,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                background: 'var(--amber-dim)',
                border: '1px solid var(--amber-border)',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--amber)',
                flexShrink: 0,
              }}
            >
              <PlayCircle size={20} />
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', margin: '0 0 4px' }}>
                Current focus
              </p>
              {activeSession ? (
                <>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)', margin: '0 0 3px' }}>
                    {activeSession.symbol} · {activeSession.timeframe}
                  </p>
                  <p
                    style={{
                      fontSize: 12,
                      color: 'var(--txt-2)',
                      margin: 0,
                      fontFamily: 'var(--font-mono)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {activeSession.startDate} {'->'} {activeSession.endDate} · {fmtCurrency(activeSession.balance)}
                  </p>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)', margin: '0 0 3px' }}>No active session</p>
                  <p style={{ fontSize: 12, color: 'var(--txt-2)', margin: 0 }}>Set up your first replay workspace to begin testing.</p>
                </>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                {['TradingView replay shell', 'Saved session history', 'One-click session resume'].map(chip => (
                  <span
                    key={chip}
                    style={{
                      fontSize: 11,
                      color: 'var(--txt-3)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 3,
                      padding: '3px 9px',
                    }}
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowNewSessionForm(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                flexShrink: 0,
                background: 'var(--amber)',
                color: 'var(--bg)',
                border: 'none',
                borderRadius: 5,
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Play size={14} />
              Start New Session
            </button>
          </div>

          <div data-tour-id="backtest-session-library" style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <div
              style={{
                padding: '14px 20px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                borderBottom: '1px solid var(--border)',
              }}
            >
              <div>
                <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', margin: '0 0 3px' }}>
                  Session library
                </p>
                <p style={{ fontSize: 13, fontWeight: 500, color: 'var(--txt)', margin: 0 }}>
                  {totalSessions} saved configuration{totalSessions !== 1 ? 's' : ''}
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ position: 'relative' }}>
                  <Search
                    size={12}
                    style={{
                      position: 'absolute',
                      left: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: 'var(--txt-3)',
                      pointerEvents: 'none',
                    }}
                  />
                  <input
                    type="text"
                    value={sessionSearch}
                    onChange={event => setSessionSearch(event.target.value)}
                    placeholder="Search symbol..."
                    style={{
                      width: 184,
                      height: 32,
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border)',
                      borderRadius: 5,
                      padding: '6px 10px 6px 30px',
                      fontSize: 12,
                      color: 'var(--txt)',
                      outline: 'none',
                    }}
                  />
                </div>

                <button
                  type="button"
                  style={{
                    height: 32,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '0 10px',
                    fontSize: 11,
                    color: 'var(--txt-2)',
                    cursor: 'pointer',
                  }}
                >
                  <Filter size={12} />
                  Filter
                </button>

                <button
                  type="button"
                  onClick={() => setShowNewSessionForm(true)}
                  style={{
                    height: 32,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    background: 'var(--amber)',
                    color: 'var(--bg)',
                    border: 'none',
                    borderRadius: 4,
                    padding: '0 10px',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <Plus size={11} />
                  New Session
                </button>
              </div>
            </div>

            {filteredSessions.length === 0 ? (
              <div style={{ padding: '30px 20px', textAlign: 'center' }}>
                <p style={{ fontSize: 13, color: 'var(--txt-2)', margin: 0 }}>
                  {totalSessions === 0
                    ? 'No sessions yet. Start your first replay to build your library.'
                    : 'No sessions match this symbol search.'}
                </p>
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Market', 'Timeframe', 'Date Range', 'Balance', 'Opened', 'Action'].map((column, index) => (
                      <th
                        key={`${column}-${index}`}
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          color: 'var(--txt-3)',
                          padding: '10px 20px',
                          borderBottom: '1px solid var(--border)',
                          textAlign: index === 5 ? 'right' : 'left',
                        }}
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredSessions.map((sess, rowIdx) => {
                    const isLast = rowIdx === filteredSessions.length - 1;
                    return (
                      <tr
                        key={sess.id}
                        style={{ borderBottom: isLast ? 'none' : '1px solid var(--border-sub)' }}
                        onMouseEnter={event => {
                          Array.from((event.currentTarget as HTMLTableRowElement).cells).forEach(cell => {
                            (cell as HTMLTableCellElement).style.background = 'rgba(255,255,255,0.015)';
                          });
                        }}
                        onMouseLeave={event => {
                          Array.from((event.currentTarget as HTMLTableRowElement).cells).forEach(cell => {
                            (cell as HTMLTableCellElement).style.background = 'transparent';
                          });
                        }}
                      >
                        <td style={{ padding: '20px 20px', transition: 'background 120ms' }}>
                          <p style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500, color: 'var(--txt)', margin: 0 }}>
                            {sess.symbol}
                          </p>
                          <p
                            style={{
                              margin: '2px 0 0',
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                              color: 'var(--txt-3)',
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {fmtOpened(sess.openedAt)}
                          </p>
                        </td>
                        <td style={{ padding: '20px 20px', transition: 'background 120ms' }}>
                          <span
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 11,
                              fontWeight: 500,
                              color: 'var(--txt-2)',
                              background: 'var(--surface-2)',
                              border: '1px solid var(--border)',
                              borderRadius: 3,
                              padding: '2px 7px',
                            }}
                          >
                            {sess.timeframe}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: '20px 20px',
                            transition: 'background 120ms',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            color: 'var(--txt)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          <span>{sess.startDate}</span>
                          <span style={{ color: 'var(--txt-3)', margin: '0 6px' }}>{'->'}</span>
                          <span>{sess.endDate}</span>
                        </td>
                        <td
                          style={{
                            padding: '20px 20px',
                            transition: 'background 120ms',
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            color: 'var(--txt)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {fmtCurrency(sess.balance)}
                        </td>
                        <td style={{ padding: '20px 20px', transition: 'background 120ms', fontSize: 11, color: 'var(--txt-3)' }}>
                          {fmtOpened(sess.openedAt)}
                        </td>
                        <td style={{ padding: '20px 20px', transition: 'background 120ms' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                            <button
                              type="button"
                              title="Delete session"
                              onClick={() => handleDeleteSession(sess.id)}
                              style={{
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                display: 'grid',
                                placeItems: 'center',
                                color: 'var(--txt-3)',
                                cursor: 'pointer',
                              }}
                              onMouseEnter={event => { (event.currentTarget as HTMLButtonElement).style.color = 'var(--danger)'; }}
                              onMouseLeave={event => { (event.currentTarget as HTMLButtonElement).style.color = 'var(--txt-3)'; }}
                            >
                              <Trash2 size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleOpenSession(sess)}
                              style={{
                                background: 'var(--amber)',
                                color: 'var(--bg)',
                                border: 'none',
                                borderRadius: 4,
                                padding: '5px 12px',
                                fontSize: 11,
                                fontWeight: 600,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                                cursor: 'pointer',
                              }}
                            >
                              <ExternalLink size={11} />
                              Open
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    );
  }
  const progressPct = session.candles.length ? (revealedCount / session.candles.length) * 100 : 0;
  const activeSavedSession = savedSessions.find(item => item.isActive && item.symbol === session.symbol && item.timeframe === session.timeframe) ?? null;
  const activeStartingBalance = (activeSavedSession?.balance ?? Number(startingBalance)) || 25000;
  const activePositionPnL = simulation.activeTrade?.pnlDollars ?? 0;
  const sessionEquity = activeStartingBalance + sessionStats.totalPnL + activePositionPnL;
  const closedTradeCount = simulation.closedTrades.length;
  const replayClock = currentCandle ? format(new Date(currentCandle.time * 1000), 'MMM d, HH:mm') : 'Waiting';
  const positionTone = activePositionPnL > 0 ? 'text-emerald-300' : activePositionPnL < 0 ? 'text-red-300' : 'text-slate-200';

  return (
    <div className="flex min-h-[calc(100vh-72px)] flex-col gap-3 bg-[#050505] p-3 text-slate-100">

      {/* Top control bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-[#11100e] px-4 py-3 shadow-[0_18px_60px_rgba(0,0,0,0.28)]">

        {/* Symbol + back */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={resetToStart}
            title="New symbol"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-slate-400 transition-colors hover:border-white/20 hover:text-slate-100"
          >
            <ChevronLeft size={13} />
            New
          </button>
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-white">{session.symbol}</span>
            <span className="text-slate-700">·</span>
            <span className="text-[12px] text-slate-500">{session.timeframe}</span>
            <span className="text-slate-700">·</span>
            <span className="text-[12px] text-slate-500">{session.range}</span>
          </div>
        </div>

        {/* OHLC info */}
        {currentCandle && (
          <div className="hidden items-center gap-2 rounded-md border border-white/10 bg-black/25 px-3 py-1.5 text-[11px] text-slate-500 xl:flex">
            <span>{format(new Date(currentCandle.time * 1000), 'MMM d HH:mm')}</span>
            <span className="text-slate-700">·</span>
            <span>O <span className="text-slate-300">{formatPrice(currentCandle.open, session.tickSize)}</span></span>
            <span>H <span className="text-slate-300">{formatPrice(currentCandle.high, session.tickSize)}</span></span>
            <span>L <span className="text-slate-300">{formatPrice(currentCandle.low, session.tickSize)}</span></span>
            <span>C <span className={currentCandle.close >= currentCandle.open ? 'text-emerald-400' : 'text-red-400'}>{formatPrice(currentCandle.close, session.tickSize)}</span></span>
          </div>
        )}

        {/* Transport */}
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={handleStepBackward} disabled={revealedCount <= 1} title="Step back (←)" className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/50 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40">
            <ChevronLeft size={14} />
          </button>
          {isPlaying ? (
            <button type="button" onClick={() => setIsPlaying(false)} title="Pause (Space)" className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/50 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200">
              <Pause size={13} />
            </button>
          ) : (
            <button type="button" onClick={() => setIsPlaying(true)} disabled={revealedCount >= session.candles.length} title="Play (Space)" className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-400 transition-colors hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-40">
              <Play size={13} />
            </button>
          )}
          <button type="button" onClick={handleStepForward} disabled={revealedCount >= session.candles.length} title="Step forward (→)" className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-slate-700/60 bg-slate-800/50 text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40">
            <StepForward size={13} />
          </button>
        </div>

        {/* Progress */}
        <div className="flex items-center gap-2">
          <div className="hidden h-1 w-20 overflow-hidden rounded-full bg-slate-800 sm:block">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-100" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="tabular-nums text-[11px] text-slate-500">{revealedCount}/{session.candles.length}</span>
        </div>

        {/* Speed */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-600">Speed</span>
          <input
            type="range"
            min={1}
            max={50}
            value={speed}
            onChange={e => setSpeed(Number(e.target.value))}
            className="h-1 w-20 cursor-pointer accent-blue-500"
          />
          <span className="w-8 text-right text-[12px] tabular-nums text-slate-400">{speed}x</span>
        </div>
      </div>

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
        {([
          ['Equity', formatCurrency(sessionEquity), sessionEquity >= activeStartingBalance ? 'text-emerald-300' : 'text-red-300'],
          ['Closed P&L', formatCurrency(sessionStats.totalPnL), sessionStats.totalPnL >= 0 ? 'text-emerald-300' : 'text-red-300'],
          ['Open P&L', formatCurrency(activePositionPnL), positionTone],
          ['Win rate', `${sessionStats.winRate.toFixed(1)}%`, sessionStats.winRate >= 50 ? 'text-emerald-300' : 'text-slate-200'],
          ['Replay time', replayClock, 'text-slate-100'],
        ] as [string, string, string][]).map(([label, value, tone]) => (
          <div key={label} className="rounded-lg border border-white/10 bg-[#11100e] px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">{label}</p>
            <p className={`mt-1 text-[18px] font-semibold tabular-nums ${tone}`}>{value}</p>
            <p className="mt-1 text-[11px] text-slate-600">
              {label === 'Equity' ? `${closedTradeCount} closed · ${simulation.activeTrade ? '1 active' : 'flat'}` :
               label === 'Closed P&L' ? `${sessionStats.tradesTaken} placed trades` :
               label === 'Open P&L' ? (simulation.activeTrade ? 'mark-to-market' : 'no live position') :
               label === 'Win rate' ? `${closedTradeCount} resolved trades` :
               `${revealedCount}/${session.candles.length} candles`}
            </p>
          </div>
        ))}
      </div>

      {/* Main grid: chart + right panel */}
      <div className="grid flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_360px]">

        {/* Chart column */}
        <div className="flex flex-col gap-2">

          {/* Drawing toolbar */}
          <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#11100e] px-3 py-2">
            {([
              { id: 'cursor', label: 'Cursor', icon: MousePointer2 },
              { id: 'horizontal', label: 'Horizontal', icon: Minus },
              { id: 'trendline', label: 'Trendline', icon: TrendingUp },
              { id: 'rectangle', label: 'Zone', icon: Square },
            ] as const).map(tool => (
              <button
                key={tool.id}
                type="button"
                onClick={() => setToolMode(tool.id as ToolMode)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                  toolMode === tool.id
                    ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-200'
                    : 'border-white/10 bg-white/[0.04] text-slate-500 hover:border-white/20 hover:text-slate-300'
                }`}
              >
                <tool.icon size={12} />
                {tool.label}
              </button>
            ))}
            {pendingPoint && (
              <span className="ml-1 rounded-md border border-amber-400/25 bg-amber-400/[0.08] px-2 py-1 text-[11px] text-amber-300">
                Click second point to finish
              </span>
            )}
            <span className="ml-auto hidden text-[10px] text-slate-700 lg:block">
              Space play · ← → step · Del remove drawing
            </span>
          </div>

          {/* Chart */}
          <div
            className="relative overflow-hidden rounded-lg border border-white/10 bg-[#030303] shadow-[0_24px_80px_rgba(0,0,0,0.45)]"
            style={{ height: 'calc(100vh - 330px)', minHeight: '520px' }}
          >
            <div ref={chartContainerRef} className="h-full w-full" />

            {/* OHLC overlay (mobile fallback) */}
            <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-slate-700/60 bg-slate-900/90 px-3 py-2 text-[11px] xl:hidden">
              <span className="font-semibold text-slate-100">{session.symbol}</span>
              {currentCandle && (
                <span className="text-slate-500">
                  C <span className={currentCandle.close >= currentCandle.open ? 'text-emerald-400' : 'text-red-400'}>{formatPrice(currentCandle.close, session.tickSize)}</span>
                </span>
              )}
            </div>

            {/* Drawing SVG overlay */}
            <div
              className={`absolute inset-0 z-20 ${toolMode === 'cursor' ? 'pointer-events-none cursor-default' : 'pointer-events-auto cursor-crosshair'}`}
              onClick={handleOverlayClick}
            >
              <svg className="h-full w-full">
                {projectedDrawings.map(drawing => {
                  if (drawing.type === 'rectangle') {
                    const selected = selectedDrawingId === drawing.id;
                    return (
                      <rect
                        key={drawing.id}
                        x={drawing.x} y={drawing.y}
                        width={Math.max(drawing.width, 2)} height={Math.max(drawing.height, 2)}
                        fill={selected ? 'rgba(56,189,248,0.18)' : 'rgba(59,130,246,0.10)'}
                        stroke={selected ? 'rgba(125,211,252,0.95)' : 'rgba(96,165,250,0.7)'}
                        strokeWidth={selected ? '2.5' : '1.5'}
                        rx="6"
                        className="pointer-events-auto cursor-pointer"
                        onContextMenu={e => { e.preventDefault(); setDrawings(curr => curr.filter(d => d.id !== drawing.id)); }}
                        onClick={() => setSelectedDrawingId(drawing.id)}
                      />
                    );
                  }
                  return (
                    <line
                      key={drawing.id}
                      x1={drawing.x1} y1={drawing.y1} x2={drawing.x2} y2={drawing.y2}
                      stroke={
                        selectedDrawingId === drawing.id
                          ? 'rgba(125,211,252,1)'
                          : drawing.type === 'horizontal'
                            ? 'rgba(250,204,21,0.85)'
                            : 'rgba(96,165,250,0.85)'
                      }
                      strokeWidth={selectedDrawingId === drawing.id ? '2.5' : '1.5'}
                      strokeDasharray={drawing.type === 'horizontal' ? '6 4' : undefined}
                      strokeLinecap="round"
                      className="pointer-events-auto cursor-pointer"
                      onContextMenu={e => { e.preventDefault(); setDrawings(curr => curr.filter(d => d.id !== drawing.id)); }}
                      onClick={() => setSelectedDrawingId(drawing.id)}
                    />
                  );
                })}
              </svg>
            </div>
          </div>
        </div>

        {/* Right panel */}
        <div className="flex flex-col gap-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 178px)' }}>

          {/* Trade ticket */}
          <div className="rounded-lg border border-white/10 bg-[#11100e] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.24)]">
            <div className="mb-3.5 flex items-center justify-between">
              <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-300">Trade Ticket</p>
              <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${simulation.activeTrade ? 'bg-amber-400/10 text-amber-300' : 'bg-slate-800 text-slate-500'}`}>
                {simulation.activeTrade ? 'Active' : 'Ready'}
              </span>
            </div>

            <div className="space-y-3">
              {/* Direction */}
              <div className="grid grid-cols-2 gap-2">
                {(['Long', 'Short'] as const).map(dir => (
                  <button
                    key={dir}
                    type="button"
                    disabled={!!simulation.activeTrade}
                    onClick={() => updateDraft('direction', dir)}
                    className={`cursor-pointer rounded-lg border py-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      tradeDraft.direction === dir
                        ? dir === 'Long'
                          ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                          : 'border-red-400/40 bg-red-400/10 text-red-300'
                        : 'border-white/10 bg-white/[0.04] text-slate-400 hover:border-white/20 hover:text-slate-200'
                    }`}
                  >
                    {dir}
                  </button>
                ))}
              </div>

              {/* Entry */}
              <div>
                <p className="mb-1 text-[11px] text-slate-500">Entry Price</p>
                <input type="number" value={tradeDraft.entryPrice} disabled={!!simulation.activeTrade} onChange={e => updateDraft('entryPrice', e.target.value)} className="input-field h-9 text-[13px]" />
              </div>

              {/* Stop + Target */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="mb-1 text-[11px] text-slate-500">Stop Loss</p>
                  <input type="number" value={tradeDraft.stopLoss} disabled={!!simulation.activeTrade} onChange={e => updateDraft('stopLoss', e.target.value)} className="input-field h-9 text-[13px]" />
                  {stopDistance !== null && (
                    <p className="mt-1 text-[10px] text-slate-600">{formatPrice(stopDistance, session.tickSize)} pts</p>
                  )}
                </div>
                <div>
                  <p className="mb-1 text-[11px] text-slate-500">Take Profit</p>
                  <input type="number" value={tradeDraft.takeProfit} disabled={!!simulation.activeTrade} onChange={e => updateDraft('takeProfit', e.target.value)} className="input-field h-9 text-[13px]" />
                  {rrRatio && (
                    <p className="mt-1 text-[10px] text-slate-600">{formatRiskRewardRatio(rrRatio, { placeholder: '1:0 RR' })}</p>
                  )}
                </div>
              </div>

              {/* Qty */}
              <div>
                <p className="mb-1 text-[11px] text-slate-500">Quantity</p>
                <input type="number" min={1} value={tradeDraft.quantity} disabled={!!simulation.activeTrade} onChange={e => updateDraft('quantity', e.target.value)} className="input-field h-9 text-[13px]" />
              </div>

              {/* Notes */}
              <div>
                <p className="mb-1 text-[11px] text-slate-500">Notes</p>
                <textarea
                  rows={2}
                  value={tradeDraft.notes}
                  disabled={!!simulation.activeTrade}
                  onChange={e => updateDraft('notes', e.target.value)}
                  className="input-field resize-none text-[13px]"
                  placeholder="Context, notes..."
                />
              </div>

              {tradeError && (
                <p className="rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[12px] text-red-300">
                  {tradeError}
                </p>
              )}

              <button
                type="button"
                disabled={!canPlaceTrade}
                onClick={handlePlaceTrade}
                className="h-10 w-full cursor-pointer rounded-md bg-emerald-400 text-[13px] font-semibold text-black transition-colors hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Place Trade
              </button>
            </div>
          </div>

          {/* Live position */}
          {simulation.activeTrade ? (
            <div className="rounded-lg border border-white/10 bg-[#11100e] p-4">
              <p className="mb-3 text-[12px] font-medium text-slate-300">Live Position</p>
              <div className={`mb-3 rounded-lg border px-3 py-2.5 ${simulation.activeTrade.pnlDollars >= 0 ? 'border-emerald-500/25 bg-emerald-500/[0.07]' : 'border-red-500/25 bg-red-500/[0.07]'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-medium text-slate-300">
                    {simulation.activeTrade.direction} · {session.symbol}
                  </span>
                  <span className={`text-[15px] font-semibold tabular-nums ${simulation.activeTrade.pnlDollars >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatCurrency(simulation.activeTrade.pnlDollars)}
                  </span>
                </div>
                <p className={`mt-0.5 text-[12px] tabular-nums ${simulation.activeTrade.pnlPoints >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                  {formatPoints(simulation.activeTrade.pnlPoints, session.tickSize)} pts
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                {[
                  ['Current', formatPrice(simulation.activeTrade.currentPrice, session.tickSize)],
                  ['Duration', formatDuration(simulation.activeTrade.durationSeconds)],
                  ['Entry', formatPrice(simulation.activeTrade.entryPrice, session.tickSize)],
                  ['Candles', String(simulation.activeTrade.candlesHeld)],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-2">
                    <p className="text-[10px] text-slate-600">{label}</p>
                    <p className="mt-0.5 font-medium text-slate-200">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-white/10 bg-[#11100e] p-4">
              <p className="mb-2 text-[12px] font-medium text-slate-300">Live Position</p>
              <p className="text-[12px] text-slate-600">No active trade. Place a trade to track it here.</p>
            </div>
          )}

          {/* Session stats */}
          <div className="rounded-lg border border-white/10 bg-[#11100e] p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[12px] font-medium text-slate-300">Session Stats</p>
              <button
                type="button"
                onClick={handleExportCsv}
                disabled={simulation.closedTrades.length === 0}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-800/40 px-2.5 py-1 text-[11px] text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download size={11} />
                Export CSV
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {([
                ['Trades', String(sessionStats.tradesTaken), null],
                ['Win Rate', `${sessionStats.winRate.toFixed(1)}%`, sessionStats.winRate > 50 ? 'positive' : sessionStats.winRate > 0 ? 'neutral' : null],
                ['Total P&L', formatCurrency(sessionStats.totalPnL), sessionStats.totalPnL > 0 ? 'positive' : sessionStats.totalPnL < 0 ? 'negative' : null],
                ['Profit Factor', sessionStats.profitFactor >= 999 ? '—' : sessionStats.profitFactor.toFixed(2), sessionStats.profitFactor >= 1.5 ? 'positive' : null],
                ['Avg Win', formatCurrency(sessionStats.avgWin), 'positive'],
                ['Avg Loss', formatCurrency(sessionStats.avgLoss), 'negative'],
              ] as [string, string, string | null][]).map(([label, value, tone]) => (
                <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-2.5">
                  <p className="text-[10px] text-slate-600">{label}</p>
                  <p className={`mt-1 text-[14px] font-semibold tabular-nums ${
                    tone === 'positive' ? 'text-emerald-400' : tone === 'negative' ? 'text-red-400' : 'text-slate-200'
                  }`}>{value}</p>
                </div>
              ))}
            </div>

            {simulation.closedTrades.length === 0 && (
              <p className="mt-2 text-[11px] text-slate-700">Stats appear once trades close.</p>
            )}
          </div>

        </div>
      </div>

      {/* Result modal */}
      <Modal isOpen={!!resultTrade} onClose={() => setResultTrade(null)} title="Trade Closed" size="md">
        {resultTrade && (
          <div className="space-y-4">
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-semibold ${
              resultTrade.outcome === 'Win'
                ? 'border-emerald-500/35 bg-emerald-500/[0.08] text-emerald-300'
                : 'border-red-500/35 bg-red-500/[0.08] text-red-300'
            }`}>
              {resultTrade.outcome} · {resultTrade.exitReason}
            </div>

            <div className="grid grid-cols-2 gap-2">
              {([
                ['Entry → Exit', `${formatPrice(resultTrade.entryPrice, session.tickSize)} → ${formatPrice(resultTrade.exitPrice, session.tickSize)}`],
                ['Points', formatPoints(resultTrade.pnlPoints, session.tickSize)],
                ['P&L', formatCurrency(resultTrade.pnlDollars)],
                ['R Achieved', `${resultTrade.rAchieved.toFixed(2)}R`],
                ['Duration', formatDuration(resultTrade.durationSeconds)],
                ['Candles', String(resultTrade.candlesHeld)],
              ] as [string, string][]).map(([label, value]) => (
                <div key={label} className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2.5">
                  <p className="text-[11px] text-slate-500">{label}</p>
                  <p className="mt-1 text-[13px] font-semibold text-slate-100">{value}</p>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button type="button" onClick={handleLogToJournal} className="btn-primary flex-1 rounded-lg py-2.5 text-[13px]">
                Log to Journal
              </button>
              <button type="button" onClick={() => setResultTrade(null)} className="btn-secondary flex-1 rounded-lg py-2.5 text-[13px]">
                Next Trade
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
