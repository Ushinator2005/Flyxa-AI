import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpen,
  Camera,
  ChevronDown,
  ChevronUp,
  FastForward,
  LayoutTemplate,
  Moon,
  Pause,
  Play,
  Rewind,
  Search,
  ShoppingCart,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import { analyticsApi } from '../services/api.js';
import { useRisk } from '../contexts/RiskContext.js';
import { AnalyticsSummary } from '../types/index.js';
import { formatCurrency } from '../utils/calculations.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { ChartHistoryRecord } from '../store/types.js';
import DatePicker from '../components/common/DatePicker.js';

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

type ChartInterval = '1' | '5' | '15' | '30' | '60' | '240' | 'D' | 'W';
type ReplaySpeed = 1 | 2 | 5 | 10 | 25 | 50;
type RailPanel = 'order' | 'goto' | null;

interface SymbolSuggestion {
  display: string;
  widgetSymbol: string;
  description: string;
}

interface BacktestConfig {
  sessionId: string;
  symbolDisplay: string;
  widgetSymbol: string;
  timeframe: ChartInterval;
  accountBalance: number;
  startDate: string;
  endDate: string;
  speed: ReplaySpeed;
}

interface BacktestSessionRecord extends BacktestConfig {
  createdAt: string;
  lastOpenedAt: string;
}

const TV_SCRIPT_SRC = 'https://s3.tradingview.com/tv.js';
const TV_CONTAINER_ID = 'tradingview_chart';
const BACKTEST_CONFIG_KEY = 'tw_backtest_config_v1';

const TIMEFRAME_OPTIONS: Array<{ label: string; value: ChartInterval }> = [
  { label: '1m', value: '1' },
  { label: '5m', value: '5' },
  { label: '15m', value: '15' },
  { label: '30m', value: '30' },
  { label: '1H', value: '60' },
  { label: '4H', value: '240' },
  { label: '1D', value: 'D' },
  { label: '1W', value: 'W' },
];

const SPEED_OPTIONS: ReplaySpeed[] = [1, 2, 5, 10, 25, 50];

const SYMBOL_SUGGESTIONS: SymbolSuggestion[] = [
  { display: 'NQ1', widgetSymbol: 'OANDA:NAS100USD', description: 'Nasdaq 100 CFD' },
  { display: 'NQ', widgetSymbol: 'OANDA:NAS100USD', description: 'Nasdaq 100 CFD' },
  { display: 'ES1', widgetSymbol: 'OANDA:SPX500USD', description: 'S&P 500 CFD' },
  { display: 'ES', widgetSymbol: 'OANDA:SPX500USD', description: 'S&P 500 CFD' },
  { display: 'EURUSD', widgetSymbol: 'FX:EURUSD', description: 'Euro / US Dollar' },
  { display: 'GBPUSD', widgetSymbol: 'FX:GBPUSD', description: 'British Pound / US Dollar' },
  { display: 'USDJPY', widgetSymbol: 'FX:USDJPY', description: 'US Dollar / Japanese Yen' },
  { display: 'AAPL', widgetSymbol: 'NASDAQ:AAPL', description: 'Apple' },
  { display: 'NVDA', widgetSymbol: 'NASDAQ:NVDA', description: 'NVIDIA' },
  { display: 'MSFT', widgetSymbol: 'NASDAQ:MSFT', description: 'Microsoft' },
  { display: 'TSLA', widgetSymbol: 'NASDAQ:TSLA', description: 'Tesla' },
];

let tradingViewScriptPromise: Promise<void> | null = null;

function loadTradingViewScript() {
  if (window.TradingView?.widget) {
    return Promise.resolve();
  }

  if (tradingViewScriptPromise) {
    return tradingViewScriptPromise;
  }

  tradingViewScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TV_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load TradingView widget script.')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = TV_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load TradingView widget script.'));
    document.body.appendChild(script);
  });

  return tradingViewScriptPromise;
}

function formatUtcTime(now: Date) {
  return `${new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now)} UTC`;
}

function formatInputDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatSessionDate(value: string) {
  return new Intl.DateTimeFormat('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
}

function getDefaultDates() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 30);

  return {
    startDate: formatInputDate(start),
    endDate: formatInputDate(end),
  };
}

function getTimeframeLabel(value: ChartInterval) {
  return TIMEFRAME_OPTIONS.find(item => item.value === value)?.label ?? value;
}

function parseStoredConfig() {
  const raw = sessionStorage.getItem(BACKTEST_CONFIG_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<BacktestConfig>;
    if (!parsed.symbolDisplay || !parsed.widgetSymbol || !parsed.timeframe) {
      return null;
    }

    return {
      sessionId: parsed.sessionId || `session-${Date.now()}`,
      symbolDisplay: parsed.symbolDisplay,
      widgetSymbol: parsed.widgetSymbol,
      timeframe: parsed.timeframe,
      accountBalance: Number(parsed.accountBalance || 0),
      startDate: parsed.startDate || getDefaultDates().startDate,
      endDate: parsed.endDate || getDefaultDates().endDate,
      speed: (parsed.speed as ReplaySpeed) || 1,
    } satisfies BacktestConfig;
  } catch {
    return null;
  }
}


function resolveSymbol(input: string) {
  const normalized = input.trim().toUpperCase();
  const directMatch = SYMBOL_SUGGESTIONS.find(item => item.display === normalized);

  if (directMatch) {
    return directMatch;
  }

  if (!normalized) {
    return SYMBOL_SUGGESTIONS[0];
  }

  return {
    display: normalized,
    widgetSymbol: normalized,
    description: 'Custom symbol',
  };
}

function toSessionRecord(config: BacktestConfig): BacktestSessionRecord {
  const timestamp = new Date().toISOString();
  return {
    ...config,
    createdAt: timestamp,
    lastOpenedAt: timestamp,
  };
}

export default function Chart() {
  const navigate = useNavigate();
  const { settings } = useRisk();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const symbolMenuRef = useRef<HTMLDivElement | null>(null);
  const timeframeMenuRef = useRef<HTMLDivElement | null>(null);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);
  const setupSearchRef = useRef<HTMLDivElement | null>(null);

  const defaultDates = getDefaultDates();
  const [config, setConfig] = useState<BacktestConfig | null>(null);
  const [savedConfig, setSavedConfig] = useState<BacktestConfig | null>(() => parseStoredConfig());
  const sessionHistory = useFlyxaStore(state => state.chartHistory) as BacktestSessionRecord[];
  const setChartHistoryAction = useFlyxaStore(state => state.setChartHistory);
  const [isSetupOpen, setIsSetupOpen] = useState(false);

  const [setupSymbolInput, setSetupSymbolInput] = useState('NQ1');
  const [setupTimeframe, setSetupTimeframe] = useState<ChartInterval>('1');
  const [setupAccountBalance, setSetupAccountBalance] = useState(String(settings?.account_size ?? 10000));
  const [setupStartDate, setSetupStartDate] = useState(defaultDates.startDate);
  const [setupEndDate, setSetupEndDate] = useState(defaultDates.endDate);
  const [setupSpeed, setSetupSpeed] = useState<ReplaySpeed>(1);
  const [setupError, setSetupError] = useState('');
  const [showSetupSuggestions, setShowSetupSuggestions] = useState(false);

  const [symbolInput, setSymbolInput] = useState('NQ1');
  const [activeSymbol, setActiveSymbol] = useState<SymbolSuggestion>(SYMBOL_SUGGESTIONS[0]);
  const [interval, setInterval] = useState<ChartInterval>('1');
  const [widgetError, setWidgetError] = useState('');
  const [showSymbolMenu, setShowSymbolMenu] = useState(false);
  const [showTimeframeMenu, setShowTimeframeMenu] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>(1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [replayCursor, setReplayCursor] = useState(0);
  const [darkToggle, setDarkToggle] = useState(true);
  const [usePercentScale, setUsePercentScale] = useState(false);
  const [autoScale, setAutoScale] = useState(true);
  const [railPanel, setRailPanel] = useState<RailPanel>(null);
  const [jumpDate, setJumpDate] = useState('');
  const [clock, setClock] = useState(() => new Date());
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);

  const filteredSetupSymbols = useMemo(() => {
    const query = setupSymbolInput.trim().toUpperCase();
    if (!query) {
      return SYMBOL_SUGGESTIONS;
    }

    return SYMBOL_SUGGESTIONS.filter(item => (
      item.display.startsWith(query) ||
      item.widgetSymbol.toUpperCase().includes(query) ||
      item.description.toUpperCase().includes(query)
    ));
  }, [setupSymbolInput]);

  const filteredSymbols = useMemo(() => {
    const query = symbolInput.trim().toUpperCase();
    if (!query) {
      return SYMBOL_SUGGESTIONS;
    }

    return SYMBOL_SUGGESTIONS.filter(item => (
      item.display.startsWith(query) ||
      item.widgetSymbol.toUpperCase().includes(query) ||
      item.description.toUpperCase().includes(query)
    ));
  }, [symbolInput]);

  const dashboardStats = useMemo(() => {
    const totalSessions = sessionHistory.length;
    const uniqueMarkets = new Set(sessionHistory.map(item => item.symbolDisplay)).size;
    const averageBalance = totalSessions
      ? sessionHistory.reduce((sum, item) => sum + item.accountBalance, 0) / totalSessions
      : 0;
    const timeframeCounts = sessionHistory.reduce<Record<string, number>>((counts, item) => {
      counts[item.timeframe] = (counts[item.timeframe] || 0) + 1;
      return counts;
    }, {});
    const favoriteTimeframe = Object.entries(timeframeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] as ChartInterval | undefined;

    return {
      totalSessions,
      uniqueMarkets,
      averageBalance,
      favoriteTimeframe: favoriteTimeframe ? getTimeframeLabel(favoriteTimeframe) : '-',
      latestSession: sessionHistory[0] ?? null,
    };
  }, [sessionHistory]);

  useEffect(() => {
    if (!config) {
      return;
    }

    setActiveSymbol({
      display: config.symbolDisplay,
      widgetSymbol: config.widgetSymbol,
      description: 'Backtest session',
    });
    setSymbolInput(config.symbolDisplay);
    setInterval(config.timeframe);
    setReplaySpeed(config.speed);
    setJumpDate(config.startDate);
  }, [config]);

  useEffect(() => {
    if (savedConfig) {
      sessionStorage.setItem(BACKTEST_CONFIG_KEY, JSON.stringify(savedConfig));
    } else {
      sessionStorage.removeItem(BACKTEST_CONFIG_KEY);
    }
  }, [savedConfig]);


  useEffect(() => {
    analyticsApi.getSummary()
      .then(data => setSummary(data as AnalyticsSummary))
      .catch(() => setSummary(null));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!isPlaying) {
      return;
    }

    const timer = window.setInterval(() => {
      setReplayCursor(current => Math.min(current + 1, 9999));
    }, Math.max(100, 1000 / replaySpeed));

    return () => window.clearInterval(timer);
  }, [isPlaying, replaySpeed]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!symbolMenuRef.current?.contains(target)) {
        setShowSymbolMenu(false);
      }
      if (!timeframeMenuRef.current?.contains(target)) {
        setShowTimeframeMenu(false);
      }
      if (!speedMenuRef.current?.contains(target)) {
        setShowSpeedMenu(false);
      }
      if (!setupSearchRef.current?.contains(target)) {
        setShowSetupSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  useEffect(() => {
    if (!config) {
      return;
    }

    let cancelled = false;

    loadTradingViewScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.TradingView?.widget) {
          return;
        }

        containerRef.current.innerHTML = '';

        new window.TradingView.widget({
          autosize: true,
          symbol: activeSymbol.widgetSymbol,
          interval,
          timezone: 'America/New_York',
          theme: darkToggle ? 'dark' : 'light',
          style: '1',
          locale: 'en',
          toolbar_bg: '#0f0f0f',
          backgroundColor: '#0f0f0f',
          gridColor: 'rgba(255,255,255,0.04)',
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_legend: false,
          allow_symbol_change: true,
          save_image: true,
          container_id: TV_CONTAINER_ID,
          studies: ['Volume@tv-basicstudies'],
          show_popup_button: false,
          withdateranges: true,
          hide_side_toolbar: false,
          details: false,
          hotlist: false,
          calendar: false,
        });

        setWidgetError('');
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setWidgetError(error instanceof Error ? error.message : 'Failed to load TradingView chart.');
        }
      });

    return () => {
      cancelled = true;
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [activeSymbol, config, interval, darkToggle]);

  const controlButtonClass = 'inline-flex h-8 items-center gap-2 rounded-full border border-[#222] bg-[#141414] px-3 text-xs font-medium text-slate-100 transition-colors hover:bg-[#1a1a1a]';
  const iconButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#222] bg-[#141414] text-slate-100 transition-colors hover:bg-[#1a1a1a]';

  const syncSessionRecord = (nextConfig: BacktestConfig) => {
    setConfig(nextConfig);
    setSavedConfig(nextConfig);
    const timestamp = new Date().toISOString();
    const existing = sessionHistory.find(item => item.sessionId === nextConfig.sessionId);
    let nextHistory: BacktestSessionRecord[];
    if (!existing) {
      nextHistory = [toSessionRecord(nextConfig), ...sessionHistory];
    } else {
      nextHistory = sessionHistory.map(item => (
        item.sessionId === nextConfig.sessionId
          ? { ...item, ...nextConfig, lastOpenedAt: timestamp }
          : item
      ));
      nextHistory.sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt));
    }
    setChartHistoryAction(nextHistory as ChartHistoryRecord[]);
  };

  const updateCurrentSession = (updater: (current: BacktestConfig) => BacktestConfig) => {
    if (!config) {
      return;
    }
    syncSessionRecord(updater(config));
  };

  const openSetupModal = () => {
    const source = savedConfig ?? config;
    if (source) {
      setSetupSymbolInput(source.symbolDisplay);
      setSetupTimeframe(source.timeframe);
      setSetupAccountBalance(String(source.accountBalance));
      setSetupStartDate(source.startDate);
      setSetupEndDate(source.endDate);
      setSetupSpeed(source.speed);
    } else {
      setSetupSymbolInput('NQ1');
      setSetupTimeframe('1');
      setSetupAccountBalance(String(settings?.account_size ?? 10000));
      setSetupStartDate(defaultDates.startDate);
      setSetupEndDate(defaultDates.endDate);
      setSetupSpeed(1);
    }
    setSetupError('');
    setShowSetupSuggestions(false);
    setIsSetupOpen(true);
  };

  const resumeSession = (nextConfig: BacktestConfig) => {
    syncSessionRecord(nextConfig);
    setReplayCursor(0);
    setIsPlaying(false);
    setRailPanel(null);
    setIsSetupOpen(false);
  };

  const returnToDashboard = () => {
    setConfig(null);
    setIsPlaying(false);
    setRailPanel(null);
    setWidgetError('');
  };

  const handleSubmitSetup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSetupError('');

    const accountBalance = Number(setupAccountBalance);
    if (!Number.isFinite(accountBalance) || accountBalance <= 0) {
      setSetupError('Enter a valid account balance greater than 0.');
      return;
    }

    if (!setupStartDate || !setupEndDate || setupStartDate > setupEndDate) {
      setSetupError('Choose a valid backtest start and end date.');
      return;
    }

    const resolved = resolveSymbol(setupSymbolInput);
    const nextConfig: BacktestConfig = {
      sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbolDisplay: resolved.display,
      widgetSymbol: resolved.widgetSymbol,
      timeframe: setupTimeframe,
      accountBalance,
      startDate: setupStartDate,
      endDate: setupEndDate,
      speed: setupSpeed,
    };

    syncSessionRecord(nextConfig);
    setReplayCursor(0);
    setIsPlaying(false);
    setRailPanel(null);
    setIsSetupOpen(false);
  };

  const accountBalance = config?.accountBalance ?? settings?.account_size ?? 0;
  const realizedPnL = summary?.netPnL ?? 0;
  const unrealizedPnL = 0;

  if (!config) {
    return (
      <div style={{ padding: 28, overflowY: 'auto', minHeight: 'calc(100vh - 56px)' }}>

        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', marginBottom: 6 }}>
              TradingView replay shell
            </p>
            <h1 style={{ fontSize: 26, fontWeight: 600, color: 'var(--txt)', margin: 0, lineHeight: 1.2, fontFamily: "'Instrument Serif', Georgia, serif" }}>
              Backtest
            </h1>
            <p style={{ fontSize: 12, color: 'var(--txt-3)', margin: '4px 0 0' }}>
              <span style={{ color: 'var(--amber-500)', fontWeight: 500 }}>{dashboardStats.totalSessions}</span> saved session{dashboardStats.totalSessions !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={openSetupModal}
            style={{ display: 'flex', alignItems: 'center', gap: 7, background: 'var(--amber-500)', color: '#000', border: 'none', borderRadius: 5, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            New Session
          </button>
        </div>

        {/* Stat cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
          {([
            { label: 'Total Sessions',      value: String(dashboardStats.totalSessions), sub: 'saved replay sessions' },
            { label: 'Markets Tested',       value: String(dashboardStats.uniqueMarkets), sub: 'unique symbols' },
            { label: 'Avg Starting Balance', value: dashboardStats.totalSessions ? formatCurrency(dashboardStats.averageBalance) : '—', sub: 'across sessions' },
            { label: 'Most Used Timeframe',  value: dashboardStats.favoriteTimeframe, sub: 'by frequency' },
          ] as const).map(card => (
            <div key={card.label} style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 }}>
              <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', marginBottom: 8 }}>{card.label}</p>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 500, color: 'var(--txt)', marginBottom: 5 }}>{card.value}</p>
              <p style={{ fontSize: 11, color: 'var(--txt-3)' }}>{card.sub}</p>
            </div>
          ))}
        </div>

        {/* Current Focus card */}
        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, padding: '18px 22px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ width: 42, height: 42, borderRadius: 8, background: 'var(--amber-dim)', border: '1px solid var(--amber-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Play size={16} style={{ color: 'var(--amber-500)' }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', marginBottom: 4 }}>Current focus</p>
            {savedConfig ? (
              <>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: 'var(--txt)', marginBottom: 3 }}>
                  {savedConfig.symbolDisplay} · {getTimeframeLabel(savedConfig.timeframe)} · {savedConfig.startDate} → {savedConfig.endDate}
                </p>
                <p style={{ fontSize: 11, color: 'var(--txt-3)' }}>{formatCurrency(savedConfig.accountBalance)} starting balance</p>
              </>
            ) : (
              <p style={{ fontSize: 13, color: 'var(--txt-3)', fontStyle: 'italic' }}>No active session — start your first replay workspace.</p>
            )}
          </div>
          {savedConfig && (
            <button
              type="button"
              onClick={() => resumeSession(savedConfig)}
              style={{ flexShrink: 0, background: 'var(--amber-dim)', color: 'var(--amber-500)', border: '1px solid var(--amber-border)', borderRadius: 5, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              Resume
            </button>
          )}
        </div>

        {/* Session Library */}
        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <div>
              <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', marginBottom: 2 }}>Session library</p>
              <p style={{ fontSize: 14, fontWeight: 500, color: 'var(--txt)', margin: 0 }}>{dashboardStats.totalSessions} saved configuration{dashboardStats.totalSessions !== 1 ? 's' : ''}</p>
            </div>
            <button
              type="button"
              onClick={openSetupModal}
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 5, padding: '6px 12px', fontSize: 12, fontWeight: 500, color: 'var(--txt-2)', cursor: 'pointer' }}
            >
              New Session
            </button>
          </div>

          {sessionHistory.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {(['Market', 'Timeframe', 'Date Range', 'Balance', 'Opened', ''] as const).map((col, i) => (
                    <th key={col + i} style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', padding: '10px 18px', borderBottom: '1px solid var(--border)', textAlign: i === 5 ? 'right' : 'left' }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sessionHistory.slice(0, 12).map((item, rowIdx) => (
                  <tr
                    key={item.sessionId}
                    style={{ borderBottom: rowIdx < Math.min(sessionHistory.length, 12) - 1 ? '1px solid var(--border-sub)' : 'none', transition: 'background 120ms' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.015)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
                  >
                    <td style={{ padding: '12px 18px' }}>
                      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500, color: 'var(--txt)' }}>{item.symbolDisplay}</p>
                      <p style={{ fontSize: 10, color: 'var(--txt-3)', marginTop: 2 }}>Opened {formatSessionDate(item.lastOpenedAt)}</p>
                    </td>
                    <td style={{ padding: '12px 18px' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 7px', color: 'var(--txt-2)' }}>{getTimeframeLabel(item.timeframe)}</span>
                    </td>
                    <td style={{ padding: '12px 18px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--txt)' }}>
                      {item.startDate} → {item.endDate}
                    </td>
                    <td style={{ padding: '12px 18px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--txt)' }}>
                      {formatCurrency(item.accountBalance)}
                    </td>
                    <td style={{ padding: '12px 18px', fontSize: 11, color: 'var(--txt-3)' }}>
                      {formatSessionDate(item.lastOpenedAt)}
                    </td>
                    <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => resumeSession(item)}
                        style={{ background: 'var(--amber-500)', color: '#000', border: 'none', borderRadius: 4, padding: '5px 12px', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
                      >
                        <Play size={10} /> Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: '32px 18px', textAlign: 'center' }}>
              <p style={{ fontSize: 13, color: 'var(--txt-3)', marginBottom: 12 }}>No sessions yet. Start your first replay to build your library.</p>
              <button
                type="button"
                onClick={openSetupModal}
                style={{ background: 'var(--amber-500)', border: 'none', borderRadius: 5, padding: '8px 16px', fontSize: 13, fontWeight: 600, color: '#000', cursor: 'pointer' }}
              >
                New Session
              </button>
            </div>
          )}
        </div>

        {isSetupOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-5 py-8">
            <button
              type="button"
              aria-label="Close backtest session"
              onClick={() => setIsSetupOpen(false)}
              className="absolute inset-0 cursor-default"
            />
            <div style={{ position: 'relative', zIndex: 10, width: '100%', maxWidth: 720, background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 12, padding: 32, boxShadow: '0 30px 80px rgba(0,0,0,0.5)' }}>
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <p style={{ fontSize: 11, fontWeight: 500, color: 'var(--txt-3)', marginBottom: 4 }}>Backtest session</p>
                  <h2 style={{ fontSize: 22, fontWeight: 600, color: 'var(--txt)', fontFamily: "'Instrument Serif', Georgia, serif", margin: 0 }}>Configure Your Backtest</h2>
                  <p style={{ fontSize: 13, color: 'var(--txt-3)', maxWidth: 500 }}>
                    Choose the asset, timeframe, backtest window, and account balance. The chart will open with those settings applied.
                  </p>
                </div>
                <button type="button" onClick={() => setIsSetupOpen(false)} className={iconButtonClass}>
                  <X size={14} />
                </button>
              </div>

              <form onSubmit={handleSubmitSetup} className="mt-8 space-y-6">
                <div className="grid gap-5 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Asset Pair / Symbol</span>
                    <div ref={setupSearchRef} className="relative">
                      <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
                      <input
                        type="text"
                        value={setupSymbolInput}
                        onChange={event => {
                          setSetupSymbolInput(event.target.value.toUpperCase());
                          setShowSetupSuggestions(true);
                        }}
                        onFocus={() => setShowSetupSuggestions(true)}
                        className="h-12 w-full rounded-2xl border border-[#222] bg-[#151515] pl-11 pr-4 text-base text-slate-100 outline-none placeholder:text-slate-500"
                        placeholder="NQ1, ES1, EURUSD, AAPL"
                      />
                      {showSetupSuggestions && filteredSetupSymbols.length > 0 && (
                        <div className="absolute left-0 right-0 top-[calc(100%+0.55rem)] z-30 overflow-hidden rounded-2xl border border-[#222] bg-[#0f0f0f] shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
                          {filteredSetupSymbols.map(item => (
                            <button
                              key={`${item.display}-${item.widgetSymbol}`}
                              type="button"
                              onClick={() => {
                                setSetupSymbolInput(item.display);
                                setShowSetupSuggestions(false);
                              }}
                              className="flex w-full items-center justify-between border-b border-[#171717] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[#1a1a1a]"
                            >
                              <div>
                                <p className="text-sm font-medium text-slate-100">{item.display}</p>
                                <p className="mt-1 text-xs text-slate-500">{item.description}</p>
                              </div>
                              <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{item.widgetSymbol}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </label>

                  <label className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Chart Timeframe</span>
                    <select
                      value={setupTimeframe}
                      onChange={event => setSetupTimeframe(event.target.value as ChartInterval)}
                      className="h-12 w-full rounded-2xl border border-[#222] bg-[#151515] px-4 text-base text-slate-100 outline-none"
                    >
                      {TIMEFRAME_OPTIONS.map(item => (
                        <option key={item.value} value={item.value}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="grid gap-5 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Backtest Start</span>
                    <DatePicker
                      value={setupStartDate}
                      onChange={setSetupStartDate}
                      className="h-12 w-full rounded-2xl border border-[#222] bg-[#151515] px-4 text-base text-slate-100 outline-none"
                      fullWidth
                      align="left"
                    />
                  </label>

                  <label className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Backtest End</span>
                    <DatePicker
                      value={setupEndDate}
                      onChange={setSetupEndDate}
                      className="h-12 w-full rounded-2xl border border-[#222] bg-[#151515] px-4 text-base text-slate-100 outline-none"
                      fullWidth
                      align="right"
                    />
                  </label>
                </div>

                <div className="grid gap-5 md:grid-cols-2">
                  <label className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Starting Account Balance</span>
                    <input
                      type="number"
                      min={1}
                      value={setupAccountBalance}
                      onChange={event => setSetupAccountBalance(event.target.value)}
                      className="h-12 w-full rounded-2xl border border-[#222] bg-[#151515] px-4 text-base text-slate-100 outline-none"
                      placeholder="10000"
                    />
                  </label>

                  <label className="space-y-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Default Replay Speed</span>
                    <select
                      value={setupSpeed}
                      onChange={event => setSetupSpeed(Number(event.target.value) as ReplaySpeed)}
                      className="h-12 w-full rounded-2xl border border-[#222] bg-[#151515] px-4 text-base text-slate-100 outline-none"
                    >
                      {SPEED_OPTIONS.map(option => (
                        <option key={option} value={option}>{option}x</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="flex flex-wrap gap-2">
                  {SYMBOL_SUGGESTIONS.slice(0, 6).map(item => (
                    <button
                      key={item.display}
                      type="button"
                      onClick={() => setSetupSymbolInput(item.display)}
                      className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                        setupSymbolInput === item.display
                          ? 'border-[rgba(245,158,11,0.50)] bg-[#d97706]/15 text-[#f59e0b]'
                          : 'border-[#222] bg-[#151515] text-slate-300 hover:bg-[#1a1a1a]'
                      }`}
                    >
                      {item.display}
                    </button>
                  ))}
                </div>

                <div className="grid gap-4 rounded-3xl border border-[#222] bg-[#151515] p-5 md:grid-cols-4">
                  {[
                    ['Symbol', resolveSymbol(setupSymbolInput).display],
                    ['Timeframe', getTimeframeLabel(setupTimeframe)],
                    ['Window', `${setupStartDate} -> ${setupEndDate}`],
                    ['Balance', setupAccountBalance ? formatCurrency(Number(setupAccountBalance) || 0) : '$0.00'],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
                      <p className="mt-2 text-sm font-medium text-slate-100">{value}</p>
                    </div>
                  ))}
                </div>

                {setupError && (
                  <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                    {setupError}
                  </div>
                )}

                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm text-slate-500">
                    We&apos;ll keep these settings attached to your current backtest session until you change them.
                  </p>
                  <button
                    type="submit"
                    style={{ background: 'var(--amber-500)', color: '#000', border: 'none', borderRadius: 5, padding: '10px 22px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    Launch Backtest
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="animate-fade-in h-full min-h-[720px] w-full bg-[#0f0f0f] text-slate-100">
      <div className="flex h-full min-h-[calc(100vh-56px)] w-full flex-col bg-[#0f0f0f]">
        <div className="flex h-12 items-center justify-between gap-3 border-b border-[#222] bg-[#0f0f0f] px-3">
          <div className="flex min-w-0 items-center gap-2">
            <div ref={symbolMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setShowSymbolMenu(current => !current)}
                className={`${controlButtonClass} min-w-[120px] justify-between`}
              >
                <span>{activeSymbol.display}</span>
                <ChevronDown size={14} />
              </button>

              {showSymbolMenu && (
                <div className="absolute left-0 top-[calc(100%+0.5rem)] z-30 w-[320px] overflow-hidden rounded-2xl border border-[#222] bg-[#0f0f0f] shadow-[0_24px_60px_rgba(0,0,0,0.4)]">
                  <div className="border-b border-[#222] p-3">
                    <div className="relative">
                      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                      <input
                        type="text"
                        value={symbolInput}
                        onChange={event => setSymbolInput(event.target.value.toUpperCase())}
                        placeholder="Search symbol"
                        className="h-10 w-full rounded-xl border border-[#222] bg-[#141414] pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                      />
                    </div>
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    {filteredSymbols.map(item => (
                      <button
                        key={`${item.display}-${item.widgetSymbol}`}
                        type="button"
                        onClick={() => {
                          updateCurrentSession(current => ({
                            ...current,
                            symbolDisplay: item.display,
                            widgetSymbol: item.widgetSymbol,
                          }));
                          setShowSymbolMenu(false);
                        }}
                        className="flex w-full items-center justify-between border-b border-[#171717] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[#1a1a1a]"
                      >
                        <div>
                          <p className="text-sm font-medium text-slate-100">{item.display}</p>
                          <p className="mt-1 text-xs text-slate-500">{item.description}</p>
                        </div>
                        <span className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{item.widgetSymbol}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div ref={timeframeMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setShowTimeframeMenu(current => !current)}
                className={`${controlButtonClass} min-w-[88px] justify-between`}
              >
                <span>{getTimeframeLabel(interval)}</span>
                <span className="flex flex-col text-slate-500">
                  <ChevronUp size={10} />
                  <ChevronDown size={10} className="-mt-1" />
                </span>
              </button>

              {showTimeframeMenu && (
                <div className="absolute left-0 top-[calc(100%+0.5rem)] z-30 w-28 overflow-hidden rounded-2xl border border-[#222] bg-[#0f0f0f] shadow-[0_24px_60px_rgba(0,0,0,0.4)]">
                  {TIMEFRAME_OPTIONS.map(item => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => {
                        updateCurrentSession(current => ({ ...current, timeframe: item.value }));
                        setShowTimeframeMenu(false);
                      }}
                      className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-[#1a1a1a] ${
                        interval === item.value ? 'text-[#f59e0b]' : 'text-slate-100'
                      }`}
                    >
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button type="button" onClick={returnToDashboard} className={controlButtonClass}>
              <LayoutTemplate size={14} />
              <span>Backtest Dashboard</span>
            </button>

            <span className="rounded-full border border-[#222] bg-[#141414] px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-400">
              {config.startDate} {'->'} {config.endDate}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setReplayCursor(0)} className={iconButtonClass}>
              <SkipBack size={14} />
            </button>
            <button type="button" onClick={() => setReplayCursor(current => Math.max(current - 10, 0))} className={iconButtonClass}>
              <Rewind size={14} />
            </button>
            <button
              type="button"
              onClick={() => setIsPlaying(current => !current)}
              className="inline-flex h-8 items-center gap-2 rounded-full border border-[#222] bg-[#141414] px-4 text-xs font-medium text-slate-100 transition-colors hover:bg-[#1a1a1a]"
            >
              {isPlaying ? <Pause size={14} /> : <Play size={14} />}
              <span>{isPlaying ? 'Pause' : 'Play'}</span>
            </button>
            <button type="button" onClick={() => setReplayCursor(current => current + 10)} className={iconButtonClass}>
              <FastForward size={14} />
            </button>
            <button type="button" onClick={() => setReplayCursor(9999)} className={iconButtonClass}>
              <SkipForward size={14} />
            </button>

            <div ref={speedMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setShowSpeedMenu(current => !current)}
                className={`${controlButtonClass} min-w-[74px] justify-between`}
              >
                <span>{replaySpeed}x</span>
                <ChevronDown size={14} />
              </button>
              {showSpeedMenu && (
                <div className="absolute left-0 top-[calc(100%+0.5rem)] z-30 w-24 overflow-hidden rounded-2xl border border-[#222] bg-[#0f0f0f] shadow-[0_24px_60px_rgba(0,0,0,0.4)]">
                  {SPEED_OPTIONS.map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => {
                        updateCurrentSession(current => ({ ...current, speed: option }));
                        setShowSpeedMenu(false);
                      }}
                      className={`flex w-full items-center px-4 py-3 text-left text-sm transition-colors hover:bg-[#1a1a1a] ${
                        replaySpeed === option ? 'text-[#f59e0b]' : 'text-slate-100'
                      }`}
                    >
                      {option}x
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" className={controlButtonClass}>
              <SlidersHorizontal size={14} />
              <span>Indicators</span>
            </button>
            <button type="button" className={iconButtonClass}>
              <Camera size={14} />
            </button>
            <button
              type="button"
              onClick={() => setDarkToggle(current => !current)}
              className="inline-flex h-8 items-center gap-2 rounded-full border border-[#222] bg-[#141414] px-3 text-xs font-medium text-slate-100 transition-colors hover:bg-[#1a1a1a]"
            >
              <span className={`relative h-4 w-8 rounded-full transition-colors ${darkToggle ? 'bg-[#d97706]' : 'bg-[#1f2937]'}`}>
                <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${darkToggle ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </span>
              {darkToggle ? <Moon size={14} /> : <Sun size={14} />}
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="relative min-h-0 flex-1 bg-[#0f0f0f]">
            <div className="h-full w-full" style={{ backgroundColor: '#0f0f0f' }}>
              <div className="tradingview-widget-container h-full w-full">
                <div id={TV_CONTAINER_ID} ref={containerRef} className="h-full w-full" />
              </div>
            </div>

            {widgetError && (
              <div className="absolute left-4 top-4 z-20 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {widgetError}
              </div>
            )}

            <div className="pointer-events-none absolute left-4 top-4 z-10 rounded-full border border-[#222] bg-[#0f0f0f]/90 px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-slate-400">
              Replay cursor {replayCursor}
            </div>
          </div>

          {railPanel && (
            <div className="w-80 border-l border-[#222] bg-[#0f0f0f]">
              {railPanel === 'order' && (
                <div className="h-full p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-100">Order Ticket</h2>
                    <button type="button" onClick={() => setRailPanel(null)} className={iconButtonClass}>
                      <X size={14} />
                    </button>
                  </div>
                  <div className="mt-4 space-y-3">
                    {['Direction', 'Entry', 'Stop Loss', 'Take Profit', 'Contracts'].map(label => (
                      <label key={label} className="block">
                        <span className="mb-1 block text-[11px] uppercase tracking-[0.16em] text-slate-500">{label}</span>
                        <input
                          className="h-10 w-full rounded-xl border border-[#222] bg-[#141414] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                          placeholder={label}
                        />
                      </label>
                    ))}
                    <button
                      type="button"
                      onClick={() => navigate('/')}
                      className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-[#d97706] px-4 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
                    >
                      Open Dashboard
                    </button>
                  </div>
                </div>
              )}

              {railPanel === 'goto' && (
                <div className="h-full p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-slate-100">Go To Date</h2>
                    <button type="button" onClick={() => setRailPanel(null)} className={iconButtonClass}>
                      <X size={14} />
                    </button>
                  </div>
                  <div className="mt-4 space-y-3">
                    <label className="block">
                      <span className="mb-1 block text-[11px] uppercase tracking-[0.16em] text-slate-500">Date</span>
                      <DatePicker
                        value={jumpDate}
                        onChange={setJumpDate}
                        className="h-10 w-full rounded-xl border border-[#222] bg-[#141414] px-3 text-sm text-slate-100 outline-none"
                        fullWidth
                        align="left"
                      />
                    </label>
                    <p className="text-xs text-slate-500">
                      TradingView&apos;s public widget does not expose direct programmatic date jumps, so this keeps your target date handy while you inspect the chart manually.
                    </p>
                    <button
                      type="button"
                      onClick={() => setRailPanel(null)}
                      className="inline-flex h-10 w-full items-center justify-center rounded-xl bg-[#d97706] px-4 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex w-[72px] flex-col items-center border-l border-[#222] bg-[#0f0f0f] py-3">
            {[
              {
                id: 'order',
                label: 'Order',
                icon: <ShoppingCart size={16} />,
                onClick: () => setRailPanel(current => current === 'order' ? null : 'order'),
                active: railPanel === 'order',
              },
              {
                id: 'goto',
                label: 'Go to',
                icon: <ArrowUpRight size={16} />,
                onClick: () => setRailPanel(current => current === 'goto' ? null : 'goto'),
                active: railPanel === 'goto',
              },
              {
                id: 'dashboard',
                label: 'Dashboard',
                icon: <BookOpen size={16} />,
                onClick: () => navigate('/'),
                active: false,
              },
            ].map(item => (
              <button
                key={item.id}
                type="button"
                onClick={item.onClick}
                className={`mb-2 flex w-full flex-col items-center gap-1 px-2 py-3 text-[11px] transition-colors hover:bg-[#1a1a1a] ${
                  item.active ? 'bg-[rgba(245,158,11,0.10)] text-[#f59e0b]' : 'text-slate-300'
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="flex h-8 items-center justify-between gap-3 border-t border-[#222] bg-[#0f0f0f] px-3 text-[11px] text-slate-200">
          <div>{formatUtcTime(clock)}</div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setUsePercentScale(current => !current)}
              className={`transition-colors hover:text-white ${usePercentScale ? 'text-[#f59e0b]' : 'text-slate-400'}`}
            >
              %
            </button>
            <button
              type="button"
              onClick={() => setAutoScale(current => !current)}
              className={`transition-colors hover:text-white ${autoScale ? 'text-[#f59e0b]' : 'text-slate-400'}`}
            >
              log/auto
            </button>
          </div>
          <div className="flex items-center gap-4 whitespace-nowrap">
            <span>Account Balance {formatCurrency(accountBalance)}</span>
            <span>Realized PnL {formatCurrency(realizedPnL)}</span>
            <span>Unrealized PnL {formatCurrency(unrealizedPnL)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
