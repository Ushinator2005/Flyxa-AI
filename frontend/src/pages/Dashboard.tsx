import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp,
  ArrowUpRight, ArrowDownRight, Eye, Filter, ChevronLeft, ChevronRight, Trash2, ClipboardCheck, X,
  FileText, Crosshair, Target,
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
  const local = new Date(`${dateSlice}T${timeHHMM}:00`);
  if (Number.isNaN(local.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(local);
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
    const zonedAsUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    const offsetMs = zonedAsUtc - local.getTime();
    return local.getTime() - offsetMs;
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

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: S1, border: `1px solid ${BORDER}`, borderRadius: 8, ...style }}>
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

function StatCard({ color, label, value, badgeLabel, badgeTone = 'neutral', valueTone = 'neutral' }: {
  color: string;
  label: string; value: string;
  badgeLabel?: string; badgeTone?: BadgeTone;
  valueTone?: BadgeTone;
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
      <div style={{ padding: '14px 16px 16px' }}>
        {/* Header row: label */}
        <div style={{ marginBottom: 12 }}>
          <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T2, margin: 0 }}>
            {label}
          </p>
        </div>
        {/* Value */}
        <p style={{
          fontSize: 26, fontWeight: 500, fontFamily: MONO,
          fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em',
          fontFeatureSettings: "'zero' 1",
          lineHeight: 1, marginBottom: 10, color: valueColor,
        }}>
          {value}
        </p>
        <DeltaBadge label={badgeLabel} tone={badgeTone} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate();
  const { trades, loading, deleteTrade } = useTrades();
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const { accounts, selectedAccountId, setSelectedAccountId, filterTradesBySelectedAccount, preferences } = useAppSettings();
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

  // Read today's high-impact calendar events from the local cache.
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

  const wins   = filteredTrades.filter(t => t.pnl > 0).length;
  const losses = filteredTrades.filter(t => t.pnl < 0).length;
  const winRingData = wins + losses > 0
    ? [{ v: wins, c: GREEN }, { v: losses, c: 'rgba(255,255,255,0.06)' }]
    : [{ v: 1, c: 'rgba(255,255,255,0.06)' }];
  const GAUGE_ARC = Math.PI * 40;
  const gaugeScored = wins + losses;
  const gaugeWinArc  = gaugeScored > 0 ? (wins   / gaugeScored) * GAUGE_ARC : 0;
  const gaugeLossArc = gaugeScored > 0 ? (losses / gaugeScored) * GAUGE_ARC : 0;

  const todayPnL    = todayTrades.reduce((s, t) => s + t.pnl, 0);
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
      <div style={{ flex: 1, height: '100%', overflowY: 'auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0 }}>
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
            <div style={{ position: 'relative' }}>
              <select
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
                style={{
                  height: 34, paddingLeft: 12, paddingRight: 28,
                  appearance: 'none',
                  background: S1, border: `1px solid ${BORDER}`,
                  borderRadius: 5, fontSize: 12, fontFamily: SANS,
                  color: T1, outline: 'none', cursor: 'pointer',
                  minWidth: 170,
                }}
                onFocus={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)'; }}
                onBlur={e =>  { e.currentTarget.style.borderColor = BORDER; }}
              >
                <option value={ALL_ACCOUNTS_ID}>All Accounts</option>
                {accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID).map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <span style={{ pointerEvents: 'none', position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: T3 }}>▼</span>
            </div>
            <button
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
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${selectedStoreAcct ? 5 : 4}, 1fr)`, gap: 14, flexShrink: 0 }}>
          {selectedStoreAcct && (() => {
            const sb = selectedStoreAcct.startingBalance ?? 0;
            const liveBalance = sb + summary.netPnL;
            return (
              <StatCard
                color={COBALT}
                label="Account Balance"
                value={fmtUSD(liveBalance)}
                badgeLabel={sb > 0 ? `Started ${fmtUSD(sb)}` : 'Set starting balance in Settings'}
                valueTone={summary.netPnL >= 0 ? 'positive' : 'negative'}
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
          />
          {/* Win Rate card with gauge */}
          <div style={{ background: S1, border: `1px solid ${BORDER}`, borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
            <div style={{ height: 2, background: `linear-gradient(90deg, ${COBALT}, transparent)` }} />
            <div style={{ padding: '14px 16px 16px' }}>
              <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: T2, margin: '0 0 12px' }}>Win Rate</p>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div>
                  <p style={{ fontSize: 26, fontWeight: 500, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.03em', fontFeatureSettings: "'zero' 1", lineHeight: 1, marginBottom: 10, color: T1 }}>
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
          />
          <StatCard
            color={RED}
            label="Trades"
            value={String(summary.totalTrades)}
            badgeLabel={`${todayTrades.length} Today`}
            valueTone="neutral"
          />
        </div>

        {/* Pre-session brief prompt */}
        {!preSessionDone && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '11px 16px', borderRadius: 8, flexShrink: 0,
            background: 'rgba(245,158,11,0.07)',
            border: '1px solid rgba(245,158,11,0.22)',
          }}>
            <ClipboardCheck size={16} color={AMBER} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 12, fontWeight: 600, color: AMBER, margin: 0 }}>Pre-session brief not started</p>
              <p style={{ fontSize: 11, color: T3, margin: '2px 0 0' }}>Set your mindset, review your plan, and confirm today's targets before the market opens.</p>
            </div>
            <button
              onClick={() => { dismissPreSession(); navigate('/pre-session'); }}
              style={{
                height: 30, padding: '0 14px', flexShrink: 0,
                background: AMBER, border: 'none', borderRadius: 5,
                fontSize: 11, fontWeight: 600, color: '#000',
                cursor: 'pointer', fontFamily: SANS,
                transition: 'opacity 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = '0.85'; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
            >
              Start brief →
            </button>
            <button
              onClick={dismissPreSession}
              style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', color: T3, flexShrink: 0, display: 'flex', alignItems: 'center' }}
              title="Dismiss for today"
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Onboarding empty state */}
        {filteredTrades.length === 0 && (
          <div style={{
            background: S1,
            border: `1px solid ${BORDER}`,
            borderRadius: 10,
            padding: '36px 32px',
            flexShrink: 0,
          }}>
            <div style={{ maxWidth: 560 }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: AMBER, margin: '0 0 10px' }}>
                Getting started
              </p>
              <h2 style={{ fontSize: 20, fontWeight: 600, color: T1, margin: '0 0 8px', letterSpacing: '-0.025em' }}>
                Welcome to Flyxa
              </h2>
              <p style={{ fontSize: 13, color: T3, margin: '0 0 28px', lineHeight: 1.6 }}>
                You haven't logged any trades yet. Here are a few things to set up before your first session.
              </p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
              {[
                {
                  icon: TrendingUp,
                  label: 'Log your first trade',
                  desc: 'Open the Trade Scanner and record your first entry.',
                  to: '/scanner',
                  accent: AMBER,
                  accentDim: AMBER_DIM,
                },
                {
                  icon: FileText,
                  label: 'Build your trading plan',
                  desc: 'Document your strategy, rules, and setups.',
                  to: '/trading-plan',
                  accent: COBALT,
                  accentDim: COBALT_DIM,
                },
                {
                  icon: Crosshair,
                  label: 'Set your goals',
                  desc: 'Define targets for consistency, profit, and process.',
                  to: '/goals',
                  accent: GREEN,
                  accentDim: GREEN_DIM,
                },
                {
                  icon: Target,
                  label: 'Run a backtest',
                  desc: 'Test your edge before risking real capital.',
                  to: '/backtest',
                  accent: T3,
                  accentDim: BSUB,
                },
              ].map(({ icon: Icon, label, desc, to, accent, accentDim }) => (
                <button
                  key={to}
                  type="button"
                  onClick={() => navigate(to)}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10,
                    padding: '16px 18px', borderRadius: 8, textAlign: 'left',
                    background: accentDim, border: `1px solid ${accent}22`,
                    cursor: 'pointer', transition: 'border-color 0.15s, opacity 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = `${accent}55`; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = `${accent}22`; }}
                >
                  <div style={{
                    width: 32, height: 32, borderRadius: 7,
                    background: `${accent}22`, border: `1px solid ${accent}33`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <Icon size={15} color={accent} />
                  </div>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: T1, margin: '0 0 4px', fontFamily: SANS }}>{label}</p>
                    <p style={{ fontSize: 11, color: T3, margin: 0, lineHeight: 1.5, fontFamily: SANS }}>{desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 2-column content grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 16, flex: 1, minHeight: 0 }}>

          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

            {/* P&L Calendar */}
            <Card style={{ flexShrink: 0 }}>
              <div style={{ padding: '14px 18px' }}>
                <MonthlyHeatmap trades={filteredTrades} />
              </div>
            </Card>

            {/* Recent Trades table */}
            <Card>
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
                <p style={{ textAlign: 'center', padding: '32px 0', fontSize: 13, color: T3 }}>
                  No trades yet — log your first trade to get started.
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['Symbol', 'Dir', 'Entry', 'Exit', 'Qty', 'R:R', 'P&L', 'Result'].map(col => (
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
                              <div style={{ fontSize: 13, fontWeight: 500, fontFamily: MONO, color: T1 }}>{trade.symbol || 'N/A'}</div>
                              <div style={{ fontSize: 11, color: T3, marginTop: 1 }}>{trade.trade_date}</div>
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
            <Card style={{ padding: 16, flexShrink: 0, border: `1px solid rgba(248,113,113,0.25)`, boxShadow: '0 0 18px rgba(248,113,113,0.07)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: RED, boxShadow: `0 0 6px ${RED}`, flexShrink: 0 }} />
                  <p style={{ fontSize: 13, fontWeight: 700, color: T1, margin: 0 }}>High Impact Today</p>
                </div>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: 3, color: RED, background: RED_DIM, border: `1px solid rgba(248,113,113,0.3)` }}>USD</span>
              </div>
              {todayHighImpact.length === 0 ? (
                <p style={{ fontSize: 11, color: T3, margin: 0, padding: '6px 0' }}>No high-impact events today.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {todayHighImpact.map((ev, i) => {
                    const released = Boolean(ev.actual);
                    const eventTimeMs = wallTimeToUtcMs(ev.date, ev.time, calendarTimeZone);
                    const hasPassed = eventTimeMs !== null && eventTimeMs <= Date.now();
                    return (
                      <div key={i} style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRadius: 6, background: hasPassed || released ? 'rgba(255,255,255,0.03)' : 'rgba(248,113,113,0.10)', borderLeft: `3px solid ${hasPassed || released ? 'rgba(255,255,255,0.12)' : RED}` }}>
                        {hasPassed && (
                          <span
                            aria-hidden="true"
                            style={{
                              position: 'absolute',
                              left: 8,
                              right: 8,
                              top: '50%',
                              height: 1,
                              background: '#fff',
                              opacity: 0.75,
                              pointerEvents: 'none',
                            }}
                          />
                        )}
                        <span style={{ fontSize: 12, fontFamily: MONO, color: released ? T2 : T1, fontWeight: 500, flexShrink: 0, paddingTop: 1, minWidth: 40 }}>{ev.time}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: released ? 500 : 600, color: released ? T2 : T1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.event}</div>
                          {released ? (
                            <div style={{ fontSize: 10, color: T3, marginTop: 2 }}>
                              <span style={{ color: ev.actual && ev.forecast && ev.actual >= ev.forecast ? GREEN : RED, fontFamily: MONO, fontWeight: 600 }}>{ev.actual}</span>
                              {ev.forecast && <span style={{ color: T3 }}> · est {ev.forecast}</span>}
                            </div>
                          ) : (
                            ev.forecast && <div style={{ fontSize: 10, color: T3, marginTop: 2 }}>Est {ev.forecast}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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
