import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, Minus,
  ArrowUpRight, ArrowDownRight, Eye, Filter, ChevronLeft, ChevronRight, Trash2, X, ChevronDown,
} from 'lucide-react';
import { Btn, Badge, PageHeader, SectionPanel, EmptyState } from '../components/ds/index.js';
import {
  PieChart, Pie, Cell,
} from 'recharts';
import { format } from 'date-fns';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings, ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID } from '../contexts/AppSettingsContext.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { useHighImpactAlerts } from '../hooks/useHighImpactAlerts.js';
import {
  buildAnalyticsSummary,
  buildRecentTrades,
  getTradeRiskReward,
} from '../utils/tradeAnalytics.js';
import { formatRiskRewardRatio } from '../utils/riskReward.js';
import MonthlyHeatmap from '../components/dashboard/MonthlyHeatmap.js';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { Trade } from '../types/index.js';
import { useBreakingNewsAlert } from '../hooks/useBreakingNewsAlert.js';
import { isLivePreSession } from '../utils/sessionLifecycle.js';

// ── Design tokens ────────────────────────────────────────────────
const COBALT      = '#60a5fa';
const COBALT_DIM  = 'rgba(96,165,250,0.12)';
const AMBER       = '#f59e0b';
const AMBER_DIM   = 'rgba(245,158,11,0.12)';
const GREEN       = '#34d399';
const RED         = '#f87171';
const RED_DIM     = 'rgba(248,113,113,0.12)';
const S1          = 'var(--app-panel)';
const BORDER      = 'var(--app-border)';
const BSUB        = 'rgba(255,255,255,0.04)';
const T1          = 'var(--app-text)';
const T2          = 'var(--app-text-muted)';
const T3          = 'var(--app-text-subtle)';
const MONO        = 'var(--font-mono)';
const SANS        = 'var(--font-sans)';

// ── Helpers ──────────────────────────────────────────────────────
function acctStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'blown')  return '#ef4444';
  if (s === 'eval')   return '#3b82f6';
  if (s === 'funded') return '#22c55e';
  if (s === 'live')   return '#f59e0b';
  return 'var(--app-text-subtle)';
}

const fmtUSD = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (v: number) => v.toFixed(1) + '%';
const fmtRR  = (v: number) => formatRiskRewardRatio(v, { placeholder: '1:0 RR' });
const fmtSignedCompactUSD = (v: number) => {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(v)).replace('K', 'k');
  return `${v >= 0 ? '+' : '-'}${formatted}`;
};

function wallTimeToUtcMs(dateSlice: string, timeHHMM: string, tz: string): number | null {
  try {
    const [yearS, monthS, dayS] = dateSlice.split('-');
    const [hourS, minuteS] = timeHHMM.split(':');
    const year = Number(yearS), month = Number(monthS), day = Number(dayS);
    const hour = Number(hourS), minute = Number(minuteS);
    if ([year, month, day, hour, minute].some(Number.isNaN)) return null;

    // Use Date.UTC as the base so the browser's local timezone never contaminates the math.
    const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);

    // Find what wall time this UTC instant shows in the target timezone.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcGuess));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);

    // UTC epoch of the displayed tz time — diff gives the true tz offset.
    const shownAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const tzOffsetMs = shownAsUtc - utcGuess;

    // Actual UTC for the wall time = utcGuess minus the tz offset.
    return utcGuess - tzOffsetMs;
  } catch {
    return null;
  }
}

// ── Sub-components ───────────────────────────────────────────────

function DirBadge({ dir }: { dir: 'Long' | 'Short' }) {
  return <Badge tone={dir === 'Long' ? 'blue' : 'red'}>{dir.toUpperCase()}</Badge>;
}

function ResultBadge({ trade }: { trade: Trade }) {
  const open = !trade.exit_price || trade.exit_price === 0;
  if (open) return <Badge tone="amber">OPEN</Badge>;
  const net = trade.pnl - (trade.commission ?? 0);
  if (net > 0) return <Badge tone="green">WIN</Badge>;
  if (net < 0) return <Badge tone="red">LOSS</Badge>;
  return <Badge tone="amber">BE</Badge>;
}


// ── Main component ────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  const { trades, loading, deleteTrade } = useTrades();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const initialCalendarDate = useMemo(() => new Date(), []);
  const [calendarMonth, setCalendarMonth] = useState(() => ({
    year: initialCalendarDate.getFullYear(),
    month: initialCalendarDate.getMonth() + 1,
  }));
  const { accounts, selectedAccountId, setSelectedAccountId, filterTradesBySelectedAccount, preferences, updateAccount } = useAppSettings();
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  const [acctDropOpen, setAcctDropOpen] = useState(false);
  const acctDropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (acctDropRef.current && !acctDropRef.current.contains(e.target as Node)) {
        setAcctDropOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);
  const storeAccounts = useFlyxaStore(state => state.accounts);

  // Fire bottom-right toast notifications when high-impact events are imminent.
  useHighImpactAlerts(preferences?.timezone ?? 'America/New_York');

  // Pre-session brief prompt — shows daily until dismissed or started.
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const preSession = useFlyxaStore(state => state.preSession);
  const sessionStartedToday = isLivePreSession(preSession) && preSession.startedAt.startsWith(todayKey);
  const [preSessionDismissed, setPreSessionDismissed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem('flyxa_presession_done_date') === todayKey
  );
  const preSessionDone = preSessionDismissed || sessionStartedToday;
  const dismissPreSession = useCallback(() => {
    localStorage.setItem('flyxa_presession_done_date', todayKey);
    setPreSessionDismissed(true);
  }, [todayKey]);

  // Breaking news bubble — persists until user dismisses it.
  const [newsBubble, setNewsBubble] = useState<{ text: string; source: string; timestamp: string } | null>(null);
  const handleNewsAlert = useCallback(
    (headline: { text: string; source: string; timestamp: string }) => {
      setNewsBubble(headline);
      return () => setNewsBubble(null);
    },
    [],
  );
  useBreakingNewsAlert(handleNewsAlert);

  // Live clock for countdown timers — ticks every second.
  // Read today's high-impact calendar events from the local cache.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  interface CachedCalEvent { event: string; date: string; time: string; impact: string; country?: string; actual?: string; forecast?: string; previous?: string; }
  const [todayHighImpact, setTodayHighImpact] = useState<CachedCalEvent[]>([]);
  const [calendarTimeZone, setCalendarTimeZone] = useState(preferences?.timezone ?? 'America/New_York');
  useEffect(() => {
    function load() {
      try {
        const raw = localStorage.getItem('flyxa_calendar_cache_v4');
        if (!raw) { setTodayHighImpact([]); return; }
        const parsed = JSON.parse(raw) as { events?: unknown[]; timeZone?: string };
        if (!Array.isArray(parsed.events)) { setTodayHighImpact([]); return; }
        // Dates in the cache are in the calendar's display timezone — match using that same timezone.
        const tz = parsed.timeZone ?? 'America/New_York';
        setCalendarTimeZone(tz);
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
        const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00';
        const todayInTz = `${get('year')}-${get('month')}-${get('day')}`;
        setTodayHighImpact(
          (parsed.events as CachedCalEvent[])
            .filter(e => e.impact === 'high' && e.date === todayInTz)
            .sort((a, b) => a.time.localeCompare(b.time))
        );
      } catch { setTodayHighImpact([]); }
    }
    load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, []);
  const filteredTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades],
  );
  const summary      = useMemo(() => buildAnalyticsSummary(filteredTrades), [filteredTrades]);
  const recentTrades = useMemo(() => buildRecentTrades(filteredTrades).slice(0, 25), [filteredTrades]);

  const todayStr = format(new Date(), 'yyyy-MM-dd');

  const todayTrades = useMemo(
    () => filteredTrades
      .filter(t => t.trade_date === todayStr)
      .sort((a, b) => (a.trade_time ?? '').localeCompare(b.trade_time ?? '')),
    [filteredTrades, todayStr],
  );

  const tradesByDate = useMemo(() => {
    const m: Record<string, Trade[]> = {};
    filteredTrades.forEach(t => { (m[t.trade_date] ??= []).push(t); });
    return m;
  }, [filteredTrades]);

  // Calendar week Mon–Sun
  const weekDays = useMemo(() => {
    const today = new Date();
    const dow = today.getDay();
    const mon = new Date(today);
    mon.setDate(today.getDate() - ((dow + 6) % 7) + (weekOffset * 7));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      return d;
    });
  }, [weekOffset]);

  const { wins, losses, breakevens, winRingData } = useMemo(() => {
    const ep = (t: typeof filteredTrades[0]) => t.pnl - (t.commission ?? 0);
    const w = filteredTrades.filter(t => ep(t) > 0).length;
    const l = filteredTrades.filter(t => ep(t) < 0).length;
    const b = filteredTrades.filter(t => ep(t) === 0 && (t.exit_price ?? 0) > 0).length;
    const total = w + l + b;
    return {
      wins: w,
      losses: l,
      breakevens: b,
      winRingData: total > 0
        ? [
            { v: w, c: GREEN },
            { v: l, c: RED },
            ...(b > 0 ? [{ v: b, c: AMBER }] : []),
          ]
        : [{ v: 1, c: 'rgba(255,255,255,0.06)' }],
    };
  }, [filteredTrades]);

  const todayPnL = useMemo(
    () => todayTrades.reduce((s, t) => s + t.pnl - (t.commission ?? 0), 0),
    [todayTrades],
  );

  const avgComparison = useMemo(() => {
    if (todayTrades.length === 0) return null;
    const historicalTrades = filteredTrades.filter(t => t.trade_date !== todayStr);
    const historicalDays = new Set(historicalTrades.map(t => t.trade_date)).size;
    if (historicalDays === 0) return null;
    const histPnL       = historicalTrades.reduce((s, t) => s + t.pnl - (t.commission ?? 0), 0);
    const avgDailyPnL   = histPnL / historicalDays;
    const histWins      = historicalTrades.filter(t => t.pnl > 0).length;
    const histScored    = historicalTrades.filter(t => t.pnl !== 0).length;
    const avgWinRate    = histScored > 0 ? (histWins / histScored) * 100 : 0;
    const avgTradesPerDay = historicalTrades.length / historicalDays;
    const todayWins     = todayTrades.filter(t => t.pnl > 0).length;
    const todayScored   = todayTrades.filter(t => t.pnl !== 0).length;
    const todayWinRate  = todayScored > 0 ? (todayWins / todayScored) * 100 : 0;
    return {
      today: { pnl: todayPnL, winRate: todayWinRate, tradeCount: todayTrades.length },
      avg:   { pnl: avgDailyPnL, winRate: avgWinRate, tradeCount: avgTradesPerDay },
    };
  }, [filteredTrades, todayTrades, todayStr, todayPnL]);
  // TradingAccount (from context) has no balance; use store Account which does.
  const selectedStoreAcct = selectedAccountId !== ALL_ACCOUNTS_ID
    ? storeAccounts.find(a => a.id === selectedAccountId)
    : undefined;
  const selectedAcct = selectedAccountId !== ALL_ACCOUNTS_ID
    ? accounts.find(a => a.id === selectedAccountId)
    : undefined;
  const hasSelectedAccount = selectedAccountId !== ALL_ACCOUNTS_ID && Boolean(selectedAcct);
  const acctName    = selectedAcct?.name ?? 'All Accounts';

  // Compute live balance and target at component level for auto-pass detection
  const liveBalForEffect = useMemo(() => {
    if (!selectedAcct) return null;
    const sb = selectedAcct.startingBalance ?? selectedStoreAcct?.startingBalance ?? 0;
    const payouts = (selectedStoreAcct?.payouts ?? []).reduce((s: number, p: { amount: number }) => s + p.amount, 0);
    return sb + summary.netPnL - payouts;
  }, [selectedAcct, selectedStoreAcct, summary.netPnL]);

  const targetBalForEffect = selectedAcct?.targetBalance ?? null;

  // Auto-switch Eval account to Passed when live balance meets/exceeds target
  useEffect(() => {
    if (
      selectedAcct &&
      selectedAcct.status === 'Eval' &&
      targetBalForEffect !== null &&
      liveBalForEffect !== null &&
      liveBalForEffect >= targetBalForEffect
    ) {
      updateAccount(selectedAcct.id, { status: 'Passed' });
    }
  }, [selectedAcct, liveBalForEffect, targetBalForEffect, updateAccount]);

  const displayTrades = recentTrades;

  function goToTradeInJournal(trade: Trade) {
    const params = new URLSearchParams();
    if (trade.trade_date) params.set('date', trade.trade_date);
    params.set('tradeId', trade.id);
    navigate(`/scanner?${params.toString()}`);
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--app-bg)' }}>
        <LoadingSpinner size="lg" label="Loading..." />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', fontFamily: SANS }}>

      {/* ═══════════════ MAIN CONTENT ═══════════════ */}
      <div style={{ flex: 1, height: '100%', overflowY: 'auto', padding: isMobile ? 12 : 24, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>

        {/* Top bar */}
        <PageHeader
          data-tour-id="dashboard-overview"
          title="Dashboard"
          sub={<>{format(new Date(), 'EEEE, MMMM d')} · <span style={{ color: 'var(--color-text-muted)' }}>{acctName}</span></>}
          actions={
            <>
              <div data-tour-id="dashboard-account-filter" ref={acctDropRef} style={{ position: 'relative' }}>
                <button
                  type="button"
                  onClick={() => setAcctDropOpen(o => !o)}
                  style={{
                    height: 34,
                    minWidth: isMobile ? 120 : 170,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    paddingLeft: 10,
                    paddingRight: 10,
                    fontSize: 12,
                    fontFamily: SANS,
                    fontWeight: 500,
                    color: T2,
                    background: 'var(--app-bg)',
                    border: `1px solid ${BORDER}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  {selectedAccountId !== ALL_ACCOUNTS_ID && acctName !== 'All Accounts' ? (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: acctStatusColor(accounts.find(a => a.id === selectedAccountId)?.status ?? ''), flexShrink: 0 }} />
                  ) : (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: T3, flexShrink: 0 }} />
                  )}
                  <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {acctName}
                  </span>
                  <ChevronDown size={11} style={{ flexShrink: 0, opacity: 0.5 }} />
                </button>
                {acctDropOpen && (() => {
                  const visAccounts = accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && !a.archived);
                  const activeAccounts = visAccounts.filter(a => a.status !== 'Blown' && a.status !== 'Passed');
                  const closedAccounts = visAccounts.filter(a => a.status === 'Blown' || a.status === 'Passed');
                  const rowBtn = (id: string, name: string, status: string, isSelected: boolean, blown: boolean) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => { setSelectedAccountId(id); setAcctDropOpen(false); }}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        fontFamily: SANS,
                        background: isSelected ? 'var(--app-bg)' : 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        opacity: blown ? 0.5 : 1,
                      }}
                      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--app-bg)'; }}
                      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: acctStatusColor(status), flexShrink: 0, display: 'inline-block' }} title={status} />
                      <span style={{ fontSize: 12, fontWeight: 500, color: isSelected ? T1 : T2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    </button>
                  );
                  return (
                    <div style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      right: 0,
                      width: 220,
                      background: 'var(--app-panel)',
                      border: `1px solid ${BORDER}`,
                      borderRadius: 8,
                      padding: '4px 0',
                      zIndex: 9999,
                      boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
                      maxHeight: 320,
                      overflowY: 'auto',
                    }}>
                      <button
                        type="button"
                        onClick={() => { setSelectedAccountId(ALL_ACCOUNTS_ID); setAcctDropOpen(false); }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '8px 12px',
                          fontFamily: SANS,
                          color: selectedAccountId === ALL_ACCOUNTS_ID ? T1 : T2,
                          background: selectedAccountId === ALL_ACCOUNTS_ID ? 'var(--app-bg)' : 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontSize: 12,
                          fontWeight: 500,
                        }}
                        onMouseEnter={e => { if (selectedAccountId !== ALL_ACCOUNTS_ID) e.currentTarget.style.background = 'var(--app-bg)'; }}
                        onMouseLeave={e => { if (selectedAccountId !== ALL_ACCOUNTS_ID) e.currentTarget.style.background = 'transparent'; }}
                      >
                        All Accounts
                      </button>
                      {activeAccounts.length > 0 && (
                        <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 2, paddingTop: 2 }}>
                          {activeAccounts.map(a => rowBtn(a.id, a.name, a.status, selectedAccountId === a.id, false))}
                        </div>
                      )}
                      {closedAccounts.length > 0 && (
                        <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 4, paddingTop: 4 }}>
                          <div style={{ padding: '2px 12px 4px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T3 }}>Closed</div>
                          {closedAccounts.map(a => rowBtn(a.id, a.name, a.status, selectedAccountId === a.id, true))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
              <Btn
                data-tour-id="dashboard-log-trade"
                variant="primary"
                size="md"
                icon={<TrendingUp size={13} />}
                onClick={() => navigate('/scanner')}
              >
                Log trade
              </Btn>
            </>
          }
        />

        {/* Command Strip */}
        {(() => {
          const todayW  = todayTrades.filter(t => t.pnl - (t.commission ?? 0) > 0).length;
          const todayL  = todayTrades.filter(t => t.pnl - (t.commission ?? 0) < 0).length;
          const monthDate   = new Date(calendarMonth.year, calendarMonth.month - 1, 1);
          const monthStr    = format(monthDate, 'yyyy-MM');
          const monthTrades = filteredTrades.filter(t => t.trade_date?.startsWith(monthStr));
          const monthPnL    = monthTrades.reduce((s, t) => s + t.pnl - (t.commission ?? 0), 0);
          const monthLabel  = format(monthDate, 'MMM yyyy');
          const nextEv  = todayHighImpact.find(ev => {
            const t = wallTimeToUtcMs(ev.date, ev.time, calendarTimeZone);
            return t !== null && t > now && !Boolean(ev.actual);
          });
          const nextEvMs = nextEv ? wallTimeToUtcMs(nextEv.date, nextEv.time, calendarTimeZone) : null;
          const secsLeft = nextEvMs !== null ? Math.max(0, Math.floor((nextEvMs - now) / 1000)) : null;
          const cntdown  = secsLeft !== null
            ? secsLeft >= 3600 ? `${Math.floor(secsLeft / 3600)}h ${Math.floor((secsLeft % 3600) / 60)}m`
            : secsLeft >= 60   ? `${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s`
            : `${secsLeft}s`
            : null;
          const sbRaw   = selectedAcct?.startingBalance ?? selectedStoreAcct?.startingBalance;
          const sb      = sbRaw ?? 0;
          const payouts = (selectedStoreAcct?.payouts ?? []).reduce((s, p) => s + p.amount, 0);
          const liveBal = sb + summary.netPnL - payouts;
          const targetBal = selectedAcct?.targetBalance ?? null;
          const progressPct = targetBal !== null && hasSelectedAccount && targetBal > sb
            ? Math.min(100, Math.max(0, ((liveBal - sb) / (targetBal - sb)) * 100))
            : null;
          const fmtCompact = (v: number) => new Intl.NumberFormat('en-US', {
            style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 0,
          }).format(v).replace('K', 'k');
          const refLabel = hasSelectedAccount ? 'BALANCE' : 'NET P&L';
          const refValue = hasSelectedAccount ? fmtUSD(liveBal) : fmtUSD(summary.netPnL);
          const refTone  = hasSelectedAccount
            ? (liveBal >= sb ? GREEN : RED)
            : summary.netPnL > 0 ? GREEN : summary.netPnL < 0 ? RED : T2;
          const refSub   = hasSelectedAccount
            ? `Net P&L ${fmtSignedCompactUSD(summary.netPnL)}`
            : `${summary.totalTrades} total trades`;
          const D  = 'rgba(255,255,255,0.05)';
          const cs = { padding: isMobile ? '14px 14px' : '16px 20px', borderRight: `1px solid ${D}`, borderBottom: `1px solid ${D}` };
          return (
            <div data-tour-id="dashboard-metrics" style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : '1.5fr 1fr 1fr 1fr 1fr',
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              background: S1,
              overflow: 'hidden',
              flexShrink: 0,
            }}>

              {/* TODAY */}
              <div style={cs}>
                <p style={{ fontSize: 10, fontWeight: 600, color: T3, margin: '0 0 8px', fontFamily: MONO }}>TODAY</p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 5 }}>
                  <p style={{ fontSize: isMobile ? 22 : 26, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: todayPnL > 0 ? GREEN : todayPnL < 0 ? RED : T2, margin: 0, lineHeight: 1 }}>
                    {todayTrades.length > 0 ? fmtUSD(todayPnL) : '—'}
                  </p>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                    <span style={{ padding: '2px 7px', borderRadius: 5, background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.22)', fontSize: 12, fontWeight: 700, fontFamily: SANS, color: GREEN }}>{todayW}W</span>
                    <span style={{ padding: '2px 7px', borderRadius: 5, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.22)', fontSize: 12, fontWeight: 700, fontFamily: SANS, color: RED }}>{todayL}L</span>
                  </span>
                </div>
                <p style={{ fontSize: 11, color: T3, margin: 0 }}>
                  {todayTrades.length > 0 ? (
                    <>{todayTrades.length} trade{todayTrades.length !== 1 ? 's' : ''}{avgComparison ? <span style={{ color: (avgComparison.today.pnl - avgComparison.avg.pnl) >= 0 ? GREEN : RED, fontFamily: MONO }}>{' '}{fmtSignedCompactUSD(avgComparison.today.pnl - avgComparison.avg.pnl)} vs avg</span> : null}</>
                  ) : 'No trades yet'}
                </p>
              </div>

              {/* REFERENCE — account balance or all-time net P&L */}
              <div style={cs}>
                {/* Label row — target hint on the right when set */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <p style={{ fontSize: 10, fontWeight: 600, color: T3, margin: 0, fontFamily: MONO }}>{refLabel}</p>
                  {targetBal !== null && hasSelectedAccount && (
                    <span style={{ fontSize: 10, color: T3, fontFamily: MONO, letterSpacing: '0.02em' }}>
                      target {fmtCompact(targetBal)}
                    </span>
                  )}
                </div>

                {/* Main value */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: progressPct !== null ? 7 : 5 }}>
                  <p style={{ fontSize: isMobile ? 20 : 22, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: refTone, margin: 0, lineHeight: 1 }}>
                    {refValue}
                  </p>
                </div>

                {/* Progress bar */}
                {progressPct !== null && (
                  <div style={{ marginBottom: 7 }}>
                    <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        borderRadius: 3,
                        background: progressPct >= 100 ? GREEN : refTone,
                        width: `${progressPct.toFixed(1)}%`,
                        transition: 'width 0.4s ease',
                      }} />
                    </div>
                  </div>
                )}

                {/* Sub-text */}
                <p style={{ fontSize: 11, color: T3, margin: 0 }}>
                  {refSub}
                  {progressPct !== null && targetBal !== null && (
                    progressPct >= 100
                      ? <span style={{ color: GREEN }}> · Target reached!</span>
                      : <span> · {fmtUSD(targetBal - liveBal)} to go</span>
                  )}
                </p>
              </div>

              {/* EXECUTION */}
              <div style={cs}>
                <p style={{ fontSize: 10, fontWeight: 600, color: T3, margin: '0 0 8px', fontFamily: MONO }}>EXECUTION</p>
                <p style={{ fontSize: isMobile ? 20 : 22, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: T1, margin: '0 0 5px', lineHeight: 1 }}>
                  {fmtPct(summary.winRate)}
                </p>
                <p style={{ fontSize: 11, color: T3, margin: 0 }}><span style={{ fontFamily: MONO }}>{fmtRR(summary.avgRR)}</span> avg R:R</p>
              </div>

              {/* MONTHLY P&L */}
              <div style={cs}>
                <p style={{ fontSize: 10, fontWeight: 600, color: T3, margin: '0 0 8px', fontFamily: MONO }}>{monthLabel.toUpperCase()} P&amp;L</p>
                <p style={{ fontSize: isMobile ? 20 : 22, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: monthPnL > 0 ? GREEN : monthPnL < 0 ? RED : T2, margin: '0 0 5px', lineHeight: 1 }}>
                  {monthTrades.length > 0 ? fmtUSD(monthPnL) : '—'}
                </p>
                <p style={{ fontSize: 11, color: T3, margin: 0 }}>
                  {monthTrades.length > 0 ? `${monthTrades.length} trade${monthTrades.length !== 1 ? 's' : ''}` : `No trades in ${format(monthDate, 'MMM')}`}
                </p>
              </div>

              {/* UP NEXT */}
              <div style={{ ...cs, ...(isMobile && { gridColumn: '1 / -1' }) }}>
                <p style={{ fontSize: 10, fontWeight: 600, color: T3, margin: '0 0 8px', fontFamily: MONO }}>UP NEXT</p>
                {nextEv ? (
                  <>
                    <p style={{ fontSize: isMobile ? 20 : 22, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: RED, margin: '0 0 5px', lineHeight: 1 }}>
                      {cntdown ?? '--'}
                    </p>
                    <p style={{ fontSize: 11, color: T3, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {nextEv.event}
                    </p>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: isMobile ? 20 : 22, fontWeight: 500, fontFamily: MONO, color: T3, margin: '0 0 5px', lineHeight: 1 }}>—</p>
                    <p style={{ fontSize: 11, color: T3, margin: 0 }}>All clear today</p>
                  </>
                )}
              </div>

            </div>
          );
        })()}

        {/* Pre-session brief prompt */}
        {!preSessionDone && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 0,
            borderRadius: 7, flexShrink: 0, overflow: 'hidden',
            border: '1px solid rgba(245,158,11,0.18)',
            background: 'rgba(245,158,11,0.04)',
          }}>
            {/* left accent */}
            <span style={{ width: 3, alignSelf: 'stretch', background: AMBER, flexShrink: 0 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', flex: 1, minWidth: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, flexShrink: 0, boxShadow: `0 0 6px ${AMBER}` }} />
              <p style={{ fontSize: 12, fontWeight: 500, color: AMBER, margin: 0 }}>
                No pre-session brief today
              </p>
              <span style={{ fontSize: 11, color: T3, margin: 0 }}>·</span>
              <p style={{ fontSize: 11, color: T3, margin: 0 }}>You haven't locked in your plan yet.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingRight: 10 }}>
              <Btn
                size="sm"
                variant="outline"
                onClick={() => { dismissPreSession(); navigate('/pre-session'); }}
              >
                Begin
              </Btn>
              <button
                onClick={dismissPreSession}
                style={{ background: 'none', border: 'none', padding: '4px 2px', cursor: 'pointer', color: T3, flexShrink: 0, display: 'flex', alignItems: 'center', opacity: 0.6 }}
                title="Dismiss for today"
                onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '0.6'; }}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )}

        {/* 2-column content grid */}
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 260px', gap: 16, flex: 1, minHeight: 0 }}>

          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

            {/* P&L Calendar */}
            <SectionPanel flush style={{ flexShrink: 0 }} data-tour-id="dashboard-calendar">
              <div style={{ padding: isMobile ? '10px 8px' : '14px 18px' }}>
                <MonthlyHeatmap trades={filteredTrades} onVisibleMonthChange={setCalendarMonth} />
              </div>
            </SectionPanel>

            {/* Recent Trades table */}
            <SectionPanel
              data-tour-id="dashboard-recent-trades"
              title="Recent Trades"
              subtitle={`${displayTrades.length} trade${displayTrades.length !== 1 ? 's' : ''}`}
              right={<Btn variant="ghost" size="sm" icon={<Filter size={11} />}>Filter</Btn>}
              flush
            >
              {displayTrades.length === 0 ? (
                <EmptyState
                  title="No trades logged yet"
                  sub="Add your first chart screenshot to unlock the dashboard, calendar, analytics, and Flyxa AI feedback."
                  action={{ label: 'Log first trade', onClick: () => navigate('/scanner') }}
                />
              ) : isMobile ? (
                /* ── Mobile: compact list (no table) ── */
                <div>
                  {displayTrades.map((trade, i) => {
                    const rrVal = getTradeRiskReward(trade);
                    return (
                      <div
                        key={trade.id}
                        style={{
                          padding: '10px 14px',
                          borderBottom: i < displayTrades.length - 1 ? `1px solid ${BSUB}` : 'none',
                          display: 'flex', flexDirection: 'column', gap: 5,
                        }}
                      >
                        {/* Row 1: Dir + Symbol | P&L */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            {(trade.direction === 'Long' || trade.direction === 'Short')
                              ? <DirBadge dir={trade.direction} />
                              : null}
                            <span style={{ fontSize: 13, fontWeight: 600, color: T1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {trade.symbol || 'N/A'}
                            </span>
                          </div>
                          <span style={{ fontSize: 13, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontWeight: 500, flexShrink: 0, color: trade.pnl - (trade.commission ?? 0) > 0 ? GREEN : trade.pnl - (trade.commission ?? 0) < 0 ? RED : AMBER }}>
                            {fmtUSD(trade.pnl - (trade.commission ?? 0))}
                          </span>
                        </div>
                        {/* Row 2: Date · R:R | Result + actions */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontSize: 11, color: T3, fontFamily: MONO }}>
                            {trade.trade_date ? format(new Date(`${trade.trade_date}T00:00:00`), 'MMM d, yyyy') : '—'}
                            {rrVal !== null ? ` · ${fmtRR(rrVal)}` : ''}
                          </span>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                            <ResultBadge trade={trade} />
                            <button
                              type="button"
                              title="View in Journal"
                              onClick={() => goToTradeInJournal(trade)}
                              style={{ border: 'none', background: 'transparent', padding: 2, color: T3, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', lineHeight: 0 }}
                            >
                              <Eye size={12} />
                            </button>
                            {pendingDeleteId === trade.id ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <button
                                  type="button"
                                  onClick={() => { deleteTrade(trade.id); setPendingDeleteId(null); }}
                                  style={{ fontSize: 10, fontFamily: SANS, padding: '2px 6px', borderRadius: 4, border: 'none', background: RED, color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                                >Del</button>
                                <button
                                  type="button"
                                  onClick={() => setPendingDeleteId(null)}
                                  style={{ fontSize: 10, fontFamily: SANS, padding: '2px 6px', borderRadius: 4, border: `1px solid ${BORDER}`, background: 'transparent', color: T2, cursor: 'pointer' }}
                                >✕</button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                title="Delete trade"
                                onClick={() => setPendingDeleteId(trade.id)}
                                style={{ border: 'none', background: 'transparent', padding: 2, color: T3, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', lineHeight: 0 }}
                              >
                                <Trash2 size={12} />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* ── Desktop: full table ── */
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['Date', 'Dir', 'Entry', 'Exit', 'Qty', 'R:R', 'P&L', 'Result'].map(col => (
                          <th key={col} style={{
                            padding: '9px 14px',
                            paddingRight: col === 'Result' ? 36 : 14,
                            textAlign: col === 'P&L' || col === 'Result' ? 'right' : 'left',
                            fontSize: 11, fontWeight: 500,
                            color: T3, whiteSpace: 'nowrap',
                            borderBottom: `1px solid ${BSUB}`, fontFamily: SANS,
                          }}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {displayTrades.map((trade, i) => {
                        const rrVal = getTradeRiskReward(trade);
                        return (
                          <tr
                            key={trade.id}
                            style={{ borderBottom: i < displayTrades.length - 1 ? `1px solid ${BSUB}` : 'none', transition: 'background 0.12s' }}
                            onMouseEnter={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.015)'; }}
                            onMouseLeave={e => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
                          >
                            <td style={{ padding: '9px 14px' }}>
                              <div style={{ fontSize: 13, fontWeight: 500, color: T1 }}>
                                {trade.trade_date ? format(new Date(`${trade.trade_date}T00:00:00`), 'MMM d, yyyy') : '—'}
                              </div>
                              <div style={{ fontSize: 11, color: T3, marginTop: 1 }}>{trade.symbol || 'N/A'}</div>
                            </td>
                            <td style={{ padding: '9px 14px' }}>
                              {(trade.direction === 'Long' || trade.direction === 'Short')
                                ? <DirBadge dir={trade.direction} />
                                : <span style={{ color: T3, fontSize: 12 }}>—</span>}
                            </td>
                            <td style={{ padding: '9px 14px', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: 12, color: T2 }}>
                              ${trade.entry_price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}
                            </td>
                            <td style={{ padding: '9px 14px', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: 12, color: T2 }}>
                              ${trade.exit_price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}
                            </td>
                            <td style={{ padding: '9px 14px', fontFamily: MONO, fontSize: 12, color: T2 }}>
                              {trade.contract_size}
                            </td>
                            <td style={{ padding: '9px 14px', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: 12, color: T2 }}>
                              {rrVal !== null ? fmtRR(rrVal) : '—'}
                            </td>
                            <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 400, color: trade.pnl - (trade.commission ?? 0) > 0 ? GREEN : trade.pnl - (trade.commission ?? 0) < 0 ? RED : AMBER }}>
                              {fmtUSD(trade.pnl - (trade.commission ?? 0))}
                            </td>
                            <td style={{ padding: '9px 14px', textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                <ResultBadge trade={trade} />
                                <button
                                  type="button"
                                  title="View in Journal"
                                  onClick={() => goToTradeInJournal(trade)}
                                  style={{ border: 'none', background: 'transparent', padding: 2, color: T3, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', lineHeight: 0 }}
                                  onMouseEnter={e => { e.currentTarget.style.color = COBALT; }}
                                  onMouseLeave={e => { e.currentTarget.style.color = T3; }}
                                >
                                  <Eye size={13} />
                                </button>
                                {pendingDeleteId === trade.id ? (
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                    <button
                                      type="button"
                                      onClick={() => { deleteTrade(trade.id); setPendingDeleteId(null); }}
                                      style={{ fontSize: 11, fontFamily: SANS, padding: '2px 8px', borderRadius: 4, border: 'none', background: RED, color: '#fff', cursor: 'pointer', fontWeight: 600 }}
                                    >Delete</button>
                                    <button
                                      type="button"
                                      onClick={() => setPendingDeleteId(null)}
                                      style={{ fontSize: 11, fontFamily: SANS, padding: '2px 8px', borderRadius: 4, border: `1px solid ${BORDER}`, background: 'transparent', color: T2, cursor: 'pointer' }}
                                    >Cancel</button>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    title="Delete trade"
                                    onClick={() => setPendingDeleteId(trade.id)}
                                    style={{ border: 'none', background: 'transparent', padding: 2, color: T3, display: 'inline-flex', alignItems: 'center', cursor: 'pointer', lineHeight: 0 }}
                                    onMouseEnter={e => { e.currentTarget.style.color = RED; }}
                                    onMouseLeave={e => { e.currentTarget.style.color = T3; }}
                                  >
                                    <Trash2 size={13} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionPanel>
          </div>

          {/* Right column — widgets */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>

            {/* Win Rate ring */}
            <SectionPanel style={{ flexShrink: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: T1, marginBottom: 14 }}>Win Rate</p>
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
                <PieChart width={132} height={132}>
                  <Pie
                    data={winRingData} dataKey="v"
                    cx="50%" cy="50%"
                    innerRadius={48} outerRadius={62}
                    stroke="none" isAnimationActive={false}
                    startAngle={90} endAngle={-270}
                  >
                    {winRingData.map((entry, i) => <Cell key={i} fill={entry.c} />)}
                  </Pie>
                </PieChart>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
                  <div style={{ fontSize: 20, fontWeight: 400, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: T1, lineHeight: 1 }}>
                    {fmtPct(summary.winRate)}
                  </div>
                  <div style={{ fontSize: 10, color: T3, marginTop: 3 }}>Win Rate</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
                {[
                  { label: `${wins} wins`, color: GREEN },
                  { label: `${losses} losses`, color: RED },
                  ...(breakevens > 0 ? [{ label: `${breakevens} BE`, color: AMBER }] : []),
                ].map(l => (
                  <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: T2 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: l.color }} />
                    {l.label}
                  </span>
                ))}
              </div>
            </SectionPanel>

            {/* Calendar strip */}
            <SectionPanel
              title={`Today, ${format(new Date(), 'MMM d')}`}
              subtitle={`Week of ${format(weekDays[0], 'MMM d')}${weekOffset !== 0 ? ` (${weekOffset > 0 ? '+' : ''}${weekOffset}w)` : ''}`}
              right={
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {weekOffset !== 0 && (
                    <Btn size="sm" variant="ghost" onClick={() => setWeekOffset(0)}>Now</Btn>
                  )}
                  <Btn size="sm" variant="ghost" icon={<ChevronLeft size={12} />}
                    aria-label="Previous week" onClick={() => setWeekOffset(prev => prev - 1)} />
                  <Btn size="sm" variant="ghost" icon={<ChevronRight size={12} />}
                    aria-label="Next week" onClick={() => setWeekOffset(prev => prev + 1)} />
                </div>
              }
              style={{ flexShrink: 0 }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
                {weekDays.map(day => {
                  const ds      = format(day, 'yyyy-MM-dd');
                  const dayTr   = tradesByDate[ds] ?? [];
                  const isToday = ds === todayStr;
                  const dayW    = dayTr.filter(t => t.pnl - (t.commission ?? 0) > 0);
                  const dayL    = dayTr.filter(t => t.pnl - (t.commission ?? 0) < 0);
                  return (
                    <div key={ds} style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      padding: '5px 2px', borderRadius: 5,
                      background: isToday ? AMBER_DIM : 'transparent',
                    }}>
                      <span style={{ fontSize: 9, fontWeight: 600, color: isToday ? AMBER : T3 }}>
                        {format(day, 'EEE').slice(0, 2)}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: isToday ? AMBER : T1 }}>
                        {format(day, 'd')}
                      </span>
                      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', justifyContent: 'center', minHeight: 8 }}>
                        {dayW.slice(0, 3).map((_, i) => <span key={`w${i}`} style={{ width: 4, height: 4, borderRadius: '50%', background: GREEN }} />)}
                        {dayL.slice(0, 3).map((_, i) => <span key={`l${i}`} style={{ width: 4, height: 4, borderRadius: '50%', background: RED }} />)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionPanel>

            {/* High-impact economic events today — intentional red theme */}
            <SectionPanel
              title={
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: RED, boxShadow: `0 0 8px ${RED}`, flexShrink: 0 }} />
                  High Impact Today
                </span>
              }
              right={<Badge tone="red">USD</Badge>}
              style={{
                flexShrink: 0,
                border: `1px solid rgba(248,113,113,0.28)`,
                borderTop: `3px solid ${RED}`,
                boxShadow: '0 0 24px rgba(248,113,113,0.09)',
              }}
            >
              {todayHighImpact.length === 0 ? (
                <p style={{ fontSize: 11, color: T3, margin: 0, padding: '6px 0' }}>No high-impact events today.</p>
              ) : (() => {
                  const nextUpIndex = todayHighImpact.findIndex(ev => {
                    const t = wallTimeToUtcMs(ev.date, ev.time, calendarTimeZone);
                    return t !== null && t > now && !Boolean(ev.actual);
                  });
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {todayHighImpact.map((ev, i) => {
                        const released = Boolean(ev.actual);
                        const eventTimeMs = wallTimeToUtcMs(ev.date, ev.time, calendarTimeZone);
                        const hasPassed = eventTimeMs !== null && eventTimeMs <= now;
                        const isUpNext = i === nextUpIndex;
                        const secsLeft = isUpNext && eventTimeMs !== null ? Math.max(0, Math.floor((eventTimeMs - now) / 1000)) : null;
                        const countdown = secsLeft !== null
                          ? secsLeft >= 3600
                            ? `${Math.floor(secsLeft / 3600)}h ${Math.floor((secsLeft % 3600) / 60)}m`
                            : secsLeft >= 60
                              ? `${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s`
                              : `${secsLeft}s`
                          : null;
                        return (
                          <div
                            key={i}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 8,
                              padding: '7px 9px',
                              borderRadius: 6,
                              background: hasPassed ? 'transparent' : isUpNext ? 'rgba(248,113,113,0.11)' : 'rgba(255,255,255,0.03)',
                              borderLeft: `3px solid ${hasPassed ? 'rgba(255,255,255,0.07)' : isUpNext ? RED : 'rgba(248,113,113,0.3)'}`,
                              opacity: hasPassed ? 0.38 : 1,
                            }}
                          >
                            <span style={{ fontSize: 11, fontFamily: MONO, color: T2, fontWeight: 500, flexShrink: 0, paddingTop: 1, minWidth: 40 }}>{ev.time}</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{
                                fontSize: 12,
                                fontWeight: isUpNext ? 600 : 500,
                                color: hasPassed ? T3 : isUpNext ? T1 : T2,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                textDecoration: hasPassed ? 'line-through' : 'none',
                                textDecorationColor: 'rgba(255,255,255,0.18)',
                              }}>{ev.event}</div>
                              {released ? (
                                <div style={{ fontSize: 10, color: T3, marginTop: 2 }}>
                                  <span style={{ color: ev.actual && ev.forecast && parseFloat(String(ev.actual)) >= parseFloat(String(ev.forecast)) ? GREEN : RED, fontFamily: MONO, fontWeight: 600 }}>{ev.actual}</span>
                                  {ev.forecast && <span style={{ color: T3 }}> · est {ev.forecast}</span>}
                                </div>
                              ) : (
                                ev.forecast && <div style={{ fontSize: 10, color: T3, marginTop: 2 }}>Est {ev.forecast}</div>
                              )}
                            </div>
                            {countdown !== null && (
                              <span style={{
                                fontSize: 10,
                                fontWeight: 600,
                                fontFamily: MONO,
                                color: secsLeft !== null && secsLeft < 60 ? RED : RED,
                                opacity: secsLeft !== null && secsLeft < 60 ? 1 : 0.75,
                                flexShrink: 0,
                                alignSelf: 'center',
                                letterSpacing: '0.03em',
                              }}>{countdown}</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
            </SectionPanel>

            {/* Daily trade log */}
            <SectionPanel title="Today's Log" style={{ flex: 1 }}>
              {todayTrades.length === 0 ? (
                <p style={{ fontSize: 12, color: T3, textAlign: 'center', padding: '16px 0' }}>No trades today.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {todayTrades.map(trade => {
                    const open   = !trade.exit_price || trade.exit_price === 0;
                    const net    = trade.pnl - (trade.commission ?? 0);
                    const isWin  = !open && net > 0;
                    const isBE   = !open && net === 0;
                    const badgeBg    = open ? AMBER_DIM   : isWin ? 'rgba(34,197,94,0.10)'  : isBE ? AMBER_DIM : RED_DIM;
                    const badgeColor = open ? AMBER        : isWin ? GREEN                    : isBE ? AMBER     : RED;
                    const Icon       = open ? TrendingUp   : isWin ? ArrowUpRight             : isBE ? Minus     : ArrowDownRight;
                    return (
                      <div key={trade.id} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span style={{ fontSize: 10, fontFamily: MONO, color: T3, flexShrink: 0, width: 36 }}>
                          {(trade.trade_time ?? '--:--').slice(0, 5)}
                        </span>
                        <div style={{ width: 28, height: 28, borderRadius: 6, flexShrink: 0, background: badgeBg, color: badgeColor, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Icon size={13} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 450, color: T1, fontFamily: MONO }}>{trade.symbol}</div>
                          <div style={{ fontSize: 10, color: T3 }}>{trade.direction} · {trade.session}</div>
                        </div>
                        <span style={{ fontSize: 12, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: "'zero' 1", fontWeight: 500, flexShrink: 0, color: open ? AMBER : isWin ? GREEN : isBE ? AMBER : RED }}>
                          {fmtUSD(net)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionPanel>
          </div>
        </div>
      </div>

      {/* ── Breaking news bubble ─────────────────────────────────── */}
      {newsBubble && (() => {
        const ageMs   = Date.now() - new Date(newsBubble.timestamp).getTime();
        const ageMins = Math.round(ageMs / 60_000);
        const ageLabel = ageMins < 1 ? 'just now' : ageMins === 1 ? '1 min ago' : `${ageMins} min ago`;
        return (
          <div
            role="alert"
            aria-live="assertive"
            style={{
              position: 'fixed',
              bottom: 24,
              right: 24,
              zIndex: 190,
              width: 380,
              maxWidth: 'calc(100vw - 48px)',
              background: 'var(--app-panel)',
              border: `1px solid ${COBALT}`,
              borderRadius: 8,
              boxShadow: `0 0 0 1px ${COBALT_DIM}, 0 12px 36px rgba(0,0,0,0.45)`,
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', background: COBALT, flexShrink: 0,
                  boxShadow: `0 0 6px ${COBALT}`,
                }} />
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: COBALT, fontFamily: SANS,
                }}>
                  Breaking News
                </span>
                <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>{ageLabel}</span>
              </div>
              <button
                type="button"
                aria-label="Dismiss news alert"
                onClick={() => setNewsBubble(null)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  color: T3, padding: 2, lineHeight: 0, flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>
            {/* Headline */}
            <p style={{
              margin: 0, fontSize: 13, fontWeight: 500, color: T1,
              fontFamily: SANS, lineHeight: 1.45,
            }}>
              {newsBubble.text}
            </p>
            {/* Source */}
            <p style={{ margin: 0, fontSize: 11, color: T3, fontFamily: MONO }}>
              via {newsBubble.source}
            </p>
          </div>
        );
      })()}
    </div>
  );
}
