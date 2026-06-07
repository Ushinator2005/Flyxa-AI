import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp,
  ArrowUpRight, ArrowDownRight, Eye, Filter, ChevronLeft, ChevronRight, Trash2, X,
} from 'lucide-react';
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

// ── Design tokens ────────────────────────────────────────────────
const COBALT      = '#60a5fa';
const COBALT_DIM  = 'rgba(96,165,250,0.12)';
const AMBER       = '#f59e0b';
const AMBER_DIM   = 'rgba(245,158,11,0.12)';
const GREEN       = '#34d399';
const GREEN_DIM   = 'rgba(52,211,153,0.12)';
const RED         = '#f87171';
const RED_DIM     = 'rgba(248,113,113,0.12)';
const S1          = 'var(--app-panel)';
const S2          = 'var(--app-panel-strong)';
const BORDER      = 'var(--app-border)';
const BSUB        = 'rgba(255,255,255,0.04)';
const T1          = 'var(--app-text)';
const T2          = 'var(--app-text-muted)';
const T3          = 'var(--app-text-subtle)';
const CHIP_BG     = 'rgba(255,255,255,0.035)';
const MONO        = 'var(--font-mono)';
const SANS        = 'var(--font-sans)';

// ── Helpers ──────────────────────────────────────────────────────
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

function winRateBadge(winRate: number): string {
  const diff = Math.round(winRate - 50);
  if (diff === 0) return 'At target';
  return `${Math.abs(diff)}% ${diff > 0 ? 'above' : 'below'} target`;
}

// ── Sub-components ───────────────────────────────────────────────

type BadgeTone = 'positive' | 'negative' | 'neutral';

function DeltaBadge({ label, tone = 'neutral' }: { label?: string; tone?: BadgeTone }) {
  if (label === undefined) return null;
  const toneColor = tone === 'positive' ? GREEN : tone === 'negative' ? RED : T3;
  if (tone === 'neutral') {
    return (
      <span style={{
        fontSize: 11, fontFamily: MONO, color: T3,
        background: CHIP_BG,
        border: `1px solid ${BSUB}`,
        padding: '2px 7px', borderRadius: 4,
      }}>{label}</span>
    );
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 11, fontFamily: MONO, fontVariantNumeric: 'tabular-nums',
      color: toneColor,
      background: CHIP_BG,
      border: `1px solid ${BSUB}`,
      padding: '2px 7px', borderRadius: 4,
    }}>
      {label}
    </span>
  );
}

function DirBadge({ dir }: { dir: 'Long' | 'Short' }) {
  const long = dir === 'Long';
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, fontFamily: SANS, letterSpacing: '0.06em',
      color: long ? COBALT : '#f87171',
      background: long ? COBALT_DIM : RED_DIM,
      padding: '2px 7px', borderRadius: 3,
    }}>
      {dir.toUpperCase()}
    </span>
  );
}

function Pill({ color, bg, children }: { color: string; bg: string; children: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, fontFamily: SANS, color, background: bg, padding: '2px 7px', borderRadius: 3 }}>
      {children}
    </span>
  );
}

function ResultBadge({ trade }: { trade: Trade }) {
  const open = !trade.exit_price || trade.exit_price === 0;
  if (open)          return <Pill color={AMBER} bg={AMBER_DIM}>OPEN</Pill>;
  if (trade.pnl > 0) return <Pill color={GREEN} bg={GREEN_DIM}>WIN</Pill>;
  return                    <Pill color={RED}   bg={RED_DIM}>LOSS</Pill>;
}

function Card({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement> & { style?: React.CSSProperties }) {
  return (
    <div {...props} style={{ background: S1, border: `1px solid ${BORDER}`, borderRadius: 8, ...style }}>
      {children}
    </div>
  );
}

function CardHeader({ title, sub, right }: { title: string; sub?: string; right?: React.ReactNode }) {
  return (
    <div style={{
      padding: '14px 18px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      borderBottom: `1px solid ${BSUB}`,
    }}>
      <div>
        <p style={{ fontSize: 13, fontWeight: 600, color: T1, margin: 0, marginBottom: sub ? 2 : 0 }}>{title}</p>
        {sub && <p style={{ fontSize: 11, color: T3, margin: 0 }}>{sub}</p>}
      </div>
      {right}
    </div>
  );
}

function StatCard({ color, label, value, badgeLabel, badgeTone = 'neutral', valueTone = 'neutral', compact = false }: {
  color: string;
  label: string; value: string;
  badgeLabel?: string; badgeTone?: BadgeTone;
  valueTone?: BadgeTone;
  compact?: boolean;
}) {
  const valueColor = valueTone === 'positive' ? GREEN : valueTone === 'negative' ? RED : T1;
  return (
    <div style={{
      background: S1,
      border: `1px solid ${BORDER}`,
      borderRadius: 8,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Top accent line */}
      <div style={{ height: 2, background: `linear-gradient(90deg, ${color}, transparent)` }} />
      <div style={{ padding: compact ? '10px 12px 12px' : '14px 16px 16px' }}>
        {/* Header row: label */}
        <div style={{ marginBottom: compact ? 6 : 12 }}>
          <p style={{ fontSize: compact ? 9 : 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T2, margin: 0 }}>
            {label}
          </p>
        </div>
        {/* Value */}
        <p style={{
          fontSize: compact ? 18 : 26, fontWeight: 500, fontFamily: MONO,
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em',
          fontFeatureSettings: "'zero' 1",
          lineHeight: 1, marginBottom: compact ? 6 : 10, color: valueColor,
        }}>
          {value}
        </p>
        <DeltaBadge label={badgeLabel} tone={badgeTone} />
      </div>
    </div>
  );
}

const GAUGE_ARC = Math.PI * 40;

// ── Main component ────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  const { trades, loading, deleteTrade } = useTrades();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const { accounts, selectedAccountId, setSelectedAccountId, filterTradesBySelectedAccount, preferences } = useAppSettings();
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  const storeAccounts = useFlyxaStore(state => state.accounts);

  // Fire bottom-right toast notifications when high-impact events are imminent.
  useHighImpactAlerts(preferences?.timezone ?? 'America/New_York');

  // Pre-session brief prompt — shows daily until dismissed or started.
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const [preSessionDone, setPreSessionDone] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem('flyxa_presession_done_date') === todayKey
  );
  const dismissPreSession = useCallback(() => {
    localStorage.setItem('flyxa_presession_done_date', todayKey);
    setPreSessionDone(true);
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

  const { wins, losses, winRingData, gaugeScored, gaugeWinArc, gaugeLossArc } = useMemo(() => {
    const w = filteredTrades.filter(t => t.pnl > 0).length;
    const l = filteredTrades.filter(t => t.pnl < 0).length;
    const scored = w + l;
    return {
      wins: w,
      losses: l,
      winRingData: scored > 0
        ? [{ v: w, c: GREEN }, { v: l, c: 'rgba(255,255,255,0.06)' }]
        : [{ v: 1, c: 'rgba(255,255,255,0.06)' }],
      gaugeScored: scored,
      gaugeWinArc:  scored > 0 ? (w / scored) * GAUGE_ARC : 0,
      gaugeLossArc: scored > 0 ? (l / scored) * GAUGE_ARC : 0,
    };
  }, [filteredTrades]);

  const todayPnL = useMemo(
    () => todayTrades.reduce((s, t) => s + t.pnl, 0),
    [todayTrades],
  );

  const avgComparison = useMemo(() => {
    if (todayTrades.length === 0) return null;
    const historicalTrades = filteredTrades.filter(t => t.trade_date !== todayStr);
    const historicalDays = new Set(historicalTrades.map(t => t.trade_date)).size;
    if (historicalDays === 0) return null;
    const histPnL       = historicalTrades.reduce((s, t) => s + t.pnl, 0);
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
  const acctName    = selectedAcct?.name ?? 'All Accounts';

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
        <div data-tour-id="dashboard-overview" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0, flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 600, color: T1, margin: 0, letterSpacing: '-0.02em' }}>
              Dashboard
            </h1>
            <p style={{ fontSize: 12, color: T3, margin: '3px 0 0' }}>
              {format(new Date(), 'EEEE, MMMM d')}
              {' · '}
              <span style={{ color: T2 }}>{acctName}</span>
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div data-tour-id="dashboard-account-filter" style={{ position: 'relative' }}>
              <select
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
                style={{
                  height: 34, paddingLeft: 12, paddingRight: 28,
                  appearance: 'none',
                  background: S1, border: `1px solid ${BORDER}`,
                  borderRadius: 5, fontSize: 12, fontFamily: SANS,
                  color: T1, outline: 'none', cursor: 'pointer',
                  minWidth: isMobile ? 120 : 170,
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)'; }}
                onBlur={e =>  { e.currentTarget.style.borderColor = BORDER; }}
              >
                <option value={ALL_ACCOUNTS_ID}>All Accounts</option>
                {accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && !a.archived).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <span style={{ pointerEvents: 'none', position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: T3 }}>▼</span>
            </div>
            <button
              data-tour-id="dashboard-log-trade"
              onClick={() => navigate('/scanner')}
              style={{
                height: 34, padding: '0 14px',
                background: '#f59e0b', border: 'none', borderRadius: 5,
                fontSize: 12, fontWeight: 600, color: '#000', cursor: 'pointer',
                fontFamily: SANS, display: 'flex', alignItems: 'center', gap: 6,
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.88'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
            >
              <TrendingUp size={13} />
              Log trade
            </button>
          </div>
        </div>

        {/* Stat cards */}
        <div data-tour-id="dashboard-metrics" style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : `repeat(${selectedStoreAcct ? 5 : 4}, 1fr)`, gap: isMobile ? 8 : 14, flexShrink: 0 }}>
          {selectedStoreAcct && (() => {
            const sb = selectedStoreAcct.startingBalance ?? 0;
            const totalPayouts = (selectedStoreAcct.payouts ?? []).reduce((s, p) => s + p.amount, 0);
            const liveBalance = sb + summary.netPnL - totalPayouts;
            return (
              <StatCard
                color={COBALT}
                label="Account Balance"
                value={fmtUSD(liveBalance)}
                badgeLabel={totalPayouts > 0 ? `Payouts taken: ${fmtUSD(totalPayouts)}` : sb > 0 ? `Started ${fmtUSD(sb)}` : 'Set starting balance in Settings'}
                valueTone={liveBalance >= sb ? 'positive' : 'negative'}
                compact={isMobile}
              />
            );
          })()}
          <StatCard
            color={AMBER}
            label="Net P&L"
            value={fmtUSD(summary.netPnL)}
            badgeLabel={todayTrades.length > 0 ? `Today ${fmtSignedCompactUSD(todayPnL)}` : 'No trades today'}
            badgeTone={todayTrades.length === 0 ? 'neutral' : todayPnL >= 0 ? 'positive' : 'negative'}
            valueTone={summary.netPnL > 0 ? 'positive' : summary.netPnL < 0 ? 'negative' : 'neutral'}
            compact={isMobile}
          />
          {/* Win Rate card with gauge */}
          <div style={{ background: S1, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
            <div style={{ height: 2, background: `linear-gradient(90deg, ${COBALT}, transparent)` }} />
            <div style={{ padding: isMobile ? '10px 12px 12px' : '14px 16px 16px' }}>
              <p style={{ fontSize: isMobile ? 9 : 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T2, margin: `0 0 ${isMobile ? 6 : 12}px` }}>Win Rate</p>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <p style={{ fontSize: isMobile ? 18 : 26, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em', fontFeatureSettings: "'zero' 1", lineHeight: 1, marginBottom: isMobile ? 6 : 10, color: T1 }}>
                    {fmtPct(summary.winRate)}
                  </p>
                  <DeltaBadge label={summary.totalTrades > 0 ? winRateBadge(summary.winRate) : 'No closed trades'} tone={summary.totalTrades === 0 ? 'neutral' : summary.winRate >= 50 ? 'positive' : 'negative'} />
                </div>
                <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                  <svg viewBox="0 0 96 54" width="92" height="52">
                    <path d="M 8 50 A 40 40 0 0 1 88 50" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="7" strokeLinecap="round" />
                    {gaugeScored > 0 && gaugeWinArc > 0 && (
                      <path d="M 8 50 A 40 40 0 0 1 88 50" fill="none"
                        stroke={GREEN} strokeWidth="7" strokeLinecap="round"
                        strokeDasharray={`${gaugeWinArc} ${GAUGE_ARC}`}
                        strokeDashoffset={0}
                      />
                    )}
                    {gaugeScored > 0 && gaugeLossArc > 0 && (
                      <path d="M 8 50 A 40 40 0 0 1 88 50" fill="none"
                        stroke={RED} strokeWidth="7" strokeLinecap="round"
                        strokeDasharray={`${gaugeLossArc} ${GAUGE_ARC}`}
                        strokeDashoffset={-gaugeWinArc}
                      />
                    )}
                  </svg>
                  <span style={{ fontSize: 10, fontFamily: MONO, color: T3 }}>{wins}W · {losses}L</span>
                </div>
              </div>
            </div>
          </div>
          <StatCard
            color={GREEN}
            label="Avg R:R"
            value={fmtRR(summary.avgRR)}
            badgeLabel={summary.avgRR > 0 ? (summary.avgRR >= 1 ? 'Above 1:1' : 'Below 1:1') : 'No ratio yet'}
            badgeTone={summary.avgRR === 0 ? 'neutral' : summary.avgRR >= 1 ? 'positive' : 'negative'}
            valueTone="neutral"
            compact={isMobile}
          />
          <StatCard
            color={RED}
            label="Trades"
            value={String(summary.totalTrades)}
            badgeLabel={`${todayTrades.length} Today`}
            valueTone="neutral"
            compact={isMobile}
          />
        </div>

        {/* Today vs Your Average strip */}
        {avgComparison && (
          <div style={{
            display: 'grid', gridTemplateColumns: isMobile ? 'repeat(1, 1fr)' : 'repeat(3, 1fr)', gap: 2,
            borderRadius: 8, overflow: 'hidden', border: `1px solid ${BORDER}`,
            background: S1, flexShrink: 0,
          }}>
            {/* Header row spanning all 3 */}
            <div style={{ gridColumn: '1 / -1', padding: '9px 16px 8px', borderBottom: `1px solid rgba(255,255,255,0.04)`, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T3 }}>Today vs your average</span>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.15)' }}>·</span>
              <span style={{ fontSize: 10, color: T3 }}>based on {new Set(filteredTrades.filter(t => t.trade_date !== todayStr).map(t => t.trade_date)).size} prior trading days</span>
            </div>
            {/* P&L */}
            {(() => {
              const diff = avgComparison.today.pnl - avgComparison.avg.pnl;
              const ahead = diff > 0;
              return (
                <div style={{ padding: '10px 16px 12px', borderRight: `1px solid rgba(255,255,255,0.04)` }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T3, margin: '0 0 6px' }}>P&amp;L</p>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 18, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: avgComparison.today.pnl >= 0 ? GREEN : RED }}>
                      {fmtUSD(avgComparison.today.pnl)}
                    </span>
                    <span style={{ fontSize: 10, color: ahead ? GREEN : RED, fontFamily: MONO }}>
                      {ahead ? '▲' : '▼'} {fmtUSD(Math.abs(diff))}
                    </span>
                  </div>
                  <p style={{ fontSize: 11, color: T3, margin: '3px 0 0', fontFamily: MONO }}>avg {fmtUSD(avgComparison.avg.pnl)}</p>
                </div>
              );
            })()}
            {/* Win Rate */}
            {(() => {
              const diff = avgComparison.today.winRate - avgComparison.avg.winRate;
              const ahead = diff > 0;
              return (
                <div style={{ padding: '10px 16px 12px', borderRight: `1px solid rgba(255,255,255,0.04)` }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T3, margin: '0 0 6px' }}>Win Rate</p>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 18, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: T1 }}>
                      {avgComparison.today.winRate.toFixed(0)}%
                    </span>
                    <span style={{ fontSize: 10, color: Math.abs(diff) < 1 ? T3 : ahead ? GREEN : RED, fontFamily: MONO }}>
                      {ahead ? '▲' : '▼'} {Math.abs(diff).toFixed(0)}pp
                    </span>
                  </div>
                  <p style={{ fontSize: 11, color: T3, margin: '3px 0 0', fontFamily: MONO }}>avg {avgComparison.avg.winRate.toFixed(0)}%</p>
                </div>
              );
            })()}
            {/* Trades */}
            {(() => {
              const diff = avgComparison.today.tradeCount - avgComparison.avg.tradeCount;
              return (
                <div style={{ padding: '10px 16px 12px' }}>
                  <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T3, margin: '0 0 6px' }}>Trades</p>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 18, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', color: T1 }}>
                      {avgComparison.today.tradeCount}
                    </span>
                    <span style={{ fontSize: 10, color: T3, fontFamily: MONO }}>
                      {diff >= 0 ? '+' : ''}{diff.toFixed(1)} vs avg
                    </span>
                  </div>
                  <p style={{ fontSize: 11, color: T3, margin: '3px 0 0', fontFamily: MONO }}>avg {avgComparison.avg.tradeCount.toFixed(1)}/day</p>
                </div>
              );
            })()}
          </div>
        )}

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
              <p style={{ fontSize: 12, fontWeight: 500, color: AMBER, margin: 0, letterSpacing: '0.01em' }}>
                No pre-session brief today
              </p>
              <span style={{ fontSize: 11, color: T3, margin: 0 }}>·</span>
              <p style={{ fontSize: 11, color: T3, margin: 0 }}>You haven't locked in your plan yet.</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingRight: 10 }}>
              <button
                onClick={() => { dismissPreSession(); navigate('/pre-session'); }}
                style={{
                  height: 26, padding: '0 11px', flexShrink: 0,
                  background: 'transparent',
                  border: '1px solid rgba(245,158,11,0.35)',
                  borderRadius: 4,
                  fontSize: 11, fontWeight: 600, color: AMBER,
                  cursor: 'pointer', fontFamily: SANS,
                  letterSpacing: '0.01em',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(245,158,11,0.1)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
              >
                Begin
              </button>
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
            <Card style={{ flexShrink: 0 }} data-tour-id="dashboard-calendar">
              <div style={{ padding: isMobile ? '10px 8px' : '14px 18px' }}>
                <MonthlyHeatmap trades={filteredTrades} />
              </div>
            </Card>

            {/* Recent Trades table */}
            <Card data-tour-id="dashboard-recent-trades">
              <CardHeader
                title="Recent Trades"
                sub={`${displayTrades.length} trade${displayTrades.length !== 1 ? 's' : ''}`}
                right={
                  <button style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    fontSize: 11, fontFamily: SANS, color: T2,
                    background: S2, border: `1px solid ${BORDER}`,
                    borderRadius: 4, padding: '5px 10px', cursor: 'pointer',
                  }}>
                    <Filter size={11} /> Filter
                  </button>
                }
              />
              {displayTrades.length === 0 ? (
                <div style={{ padding: '34px 18px', textAlign: 'center' }}>
                  <p style={{ fontSize: 13, fontWeight: 600, color: T1, margin: '0 0 6px' }}>No trades logged yet</p>
                  <p style={{ fontSize: 12, color: T3, margin: '0 0 14px' }}>
                    Add your first chart screenshot to unlock the dashboard, calendar, analytics, and Flyxa AI feedback.
                  </p>
                  <button
                    type="button"
                    onClick={() => navigate('/scanner')}
                    style={{ height: 32, borderRadius: 5, border: 'none', background: AMBER, color: '#090909', fontSize: 12, fontWeight: 700, padding: '0 12px', cursor: 'pointer' }}
                  >
                    Log first trade
                  </button>
                </div>
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
                          <span style={{ fontSize: 13, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontWeight: 500, flexShrink: 0, color: trade.pnl > 0 ? GREEN : trade.pnl < 0 ? RED : AMBER }}>
                            {fmtUSD(trade.pnl)}
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
                            fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                            textTransform: 'uppercase', color: T3, whiteSpace: 'nowrap',
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
                            <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 400, color: trade.pnl > 0 ? GREEN : trade.pnl < 0 ? RED : AMBER }}>
                              {fmtUSD(trade.pnl)}
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
            </Card>
          </div>

          {/* Right column — widgets */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>

            {/* Win Rate ring */}
            <Card style={{ padding: 16, flexShrink: 0 }}>
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
                  <div style={{ fontSize: 10, color: T3, marginTop: 3, letterSpacing: '0.06em' }}>Win Rate</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 16 }}>
                {[{ label: `${wins} wins`, color: GREEN }, { label: `${losses} losses`, color: RED }].map(l => (
                  <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: T2 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: l.color }} />
                    {l.label}
                  </span>
                ))}
              </div>
            </Card>

            {/* Calendar strip */}
            <Card style={{ padding: 16, flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: T1, margin: 0 }}>
                  Today, {format(new Date(), 'MMM d')}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {weekOffset !== 0 && (
                    <button
                      type="button"
                      onClick={() => setWeekOffset(0)}
                      style={{
                        height: 20,
                        padding: '0 7px',
                        borderRadius: 4,
                        border: `1px solid ${BORDER}`,
                        background: 'transparent',
                        color: T2,
                        fontSize: 10,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Now
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setWeekOffset(prev => prev - 1)}
                    aria-label="Previous week"
                    style={{
                      width: 20,
                      height: 20,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 4,
                      border: `1px solid ${BORDER}`,
                      background: 'transparent',
                      color: T2,
                      cursor: 'pointer',
                    }}
                  >
                    <ChevronLeft size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setWeekOffset(prev => prev + 1)}
                    aria-label="Next week"
                    style={{
                      width: 20,
                      height: 20,
                      display: 'grid',
                      placeItems: 'center',
                      borderRadius: 4,
                      border: `1px solid ${BORDER}`,
                      background: 'transparent',
                      color: T2,
                      cursor: 'pointer',
                    }}
                  >
                    <ChevronRight size={12} />
                  </button>
                </div>
              </div>
              <p style={{ fontSize: 10, color: T3, marginBottom: 12 }}>
                Week of {format(weekDays[0], 'MMM d')}
                {weekOffset !== 0 ? ` (${weekOffset > 0 ? '+' : ''}${weekOffset}w)` : ''}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 3 }}>
                {weekDays.map(day => {
                  const ds      = format(day, 'yyyy-MM-dd');
                  const dayTr   = tradesByDate[ds] ?? [];
                  const isToday = ds === todayStr;
                  const dayW    = dayTr.filter(t => t.pnl > 0);
                  const dayL    = dayTr.filter(t => t.pnl < 0);
                  return (
                    <div key={ds} style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      padding: '5px 2px', borderRadius: 5,
                      background: isToday ? AMBER_DIM : 'transparent',
                    }}>
                      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: isToday ? AMBER : T3 }}>
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
            </Card>

            {/* High-impact economic events today */}
            <Card style={{ padding: 0, flexShrink: 0, border: `1px solid rgba(248,113,113,0.28)`, boxShadow: '0 0 24px rgba(248,113,113,0.09)', overflow: 'hidden' }}>
              {/* Accent bar */}
              <div style={{ height: 3, background: 'linear-gradient(90deg, #f87171, rgba(248,113,113,0.1))' }} />
              <div style={{ padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: RED, boxShadow: `0 0 8px ${RED}`, flexShrink: 0 }} />
                    <p style={{ fontSize: 12, fontWeight: 700, color: T1, margin: 0, letterSpacing: '0.01em' }}>High Impact Today</p>
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 3, color: RED, background: RED_DIM, border: `1px solid rgba(248,113,113,0.3)` }}>USD</span>
                </div>
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
              </div>
            </Card>

            {/* Daily trade log */}
            <Card style={{ padding: 16, flex: 1 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: T1, marginBottom: 12 }}>Today's Log</p>
              {todayTrades.length === 0 ? (
                <p style={{ fontSize: 12, color: T3, textAlign: 'center', padding: '16px 0' }}>No trades today.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {todayTrades.map(trade => {
                    const open   = !trade.exit_price || trade.exit_price === 0;
                    const isWin  = trade.pnl > 0;
                    const badgeBg    = open ? AMBER_DIM   : isWin ? 'rgba(34,197,94,0.10)'  : RED_DIM;
                    const badgeColor = open ? AMBER        : isWin ? GREEN                    : RED;
                    const Icon       = open ? TrendingUp   : isWin ? ArrowUpRight             : ArrowDownRight;
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
                        <span style={{ fontSize: 12, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontFeatureSettings: "'zero' 1", fontWeight: 500, flexShrink: 0, color: open ? AMBER : isWin ? GREEN : RED }}>
                          {fmtUSD(trade.pnl)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
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
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.09em',
                  textTransform: 'uppercase', color: COBALT, fontFamily: SANS,
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
