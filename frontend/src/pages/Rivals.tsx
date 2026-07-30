import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ArrowUp, ArrowDown, Bell, Check, ChevronDown, Clock3,
  MessageCircle, Minus, Plus, Share2, Users, X,
} from 'lucide-react';
import { useRivals } from '../hooks/useRivals.js';
import type { LeaderboardMetric, LeaderboardPeriod, Rival, RivalPeriodStats } from '../types/rivals.js';
import type { RivalRequestResponse, SharedTradeRecord } from '../services/api.js';
import { tradeSharesApi } from '../services/api.js';
import { useTrades } from '../hooks/useTrades.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { PrivateLeague } from '../store/types.js';
import AddRivalModal from '../components/rivals/AddRivalModal.js';
import RivalChatPanel from '../components/rivals/RivalChatPanel.js';
import ScreenshotImportModal from '../components/scanner/ScreenshotImportModal.js';
import '../components/rivals/rivals.css';

type League = PrivateLeague;

const PERIODS: Array<{ value: LeaderboardPeriod; label: string }> = [
  { value: 'week', label: '7D' },
  { value: 'month', label: '30D' },
  { value: 'season', label: 'Season' },
  { value: 'allTime', label: 'All' },
];

const MODES: Array<{ value: LeaderboardMetric; label: string; help?: string }> = [
  { value: 'netPnl', label: 'Net P&L' },
  { value: 'winRate', label: 'Win rate' },
  { value: 'consistency', label: 'Consistency' },
  { value: 'processScore', label: 'Process' },
];

const EMPTY_PERIOD: RivalPeriodStats = {
  netPnl: 0, winRate: 0, avgR: null, tradeCount: 0, tradingDays: 0, greenDays: 0,
  maxDrawdown: 0, consistency: 0, ruleAdherence: 0, riskAdjusted: 0, equityCurve: [], dailyPnl: [],
};

function formatCurrency(value: number): string {
  const amount = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value > 0 ? `+$${amount}` : value < 0 ? `-$${amount}` : '$0';
}

function getPeriodStats(rival: Rival, period: LeaderboardPeriod): RivalPeriodStats {
  const saved = rival.mascot.stats.periods?.[period];
  if (saved) return saved;
  // Only fall back to top-level all-time stats for 'allTime'.
  // For week/month/season with no period data, return empty so the filter is clearly reflected.
  if (period === 'allTime') {
    return {
      ...EMPTY_PERIOD,
      netPnl: rival.mascot.stats.netPnl ?? 0,
      winRate: rival.mascot.stats.winRate ?? 0,
      avgR: rival.mascot.stats.avgR ?? null,
      consistency: rival.mascot.stats.processScore,
    };
  }
  return { ...EMPTY_PERIOD };
}

function metricValue(rival: Rival, metric: LeaderboardMetric, period: LeaderboardPeriod): number {
  const stats = getPeriodStats(rival, period);
  if (metric === 'netPnl') return stats.netPnl;
  if (metric === 'consistency') return stats.consistency;
  if (metric === 'riskAdjusted') return stats.riskAdjusted;
  if (metric === 'journalStreak') return rival.mascot.stats.dailyJournalStreak;
  if (metric === 'processScore') return rival.mascot.stats.processScore;
  if (metric === 'winRate') return stats.winRate;
  if (metric === 'avgR') return rival.mascot.stats.avgR ?? 0;
  if (metric === 'dailyJournal') return rival.mascot.stats.dailyJournalScore;
  if (metric === 'tradingJournal') return rival.mascot.stats.tradingJournalScore;
  return rival.mascot.stats.backtestSessions;
}

// Leaderboard palette — matches the reference board exactly.
// House design tokens — the board must read as part of the app, not its own
// product, and must follow the active theme (Default / Light / Midnight).
const LB = {
  card: 'var(--app-panel)', cardHi: 'var(--app-panel-strong)', border: 'var(--app-border)', borderHi: 'var(--amber-border)',
  text: 'var(--app-text)', muted: 'var(--app-text-muted)', subtle: 'var(--app-text-subtle)',
  amber: 'var(--amber)', green: 'var(--green)', red: 'var(--red)',
  rowYou: 'var(--amber-dim)',
};

function seasonLabel(): string {
  const now = new Date();
  return now.toLocaleString('en-US', { month: 'long' });
}

function winsLosses(rival: Rival, period: LeaderboardPeriod): [number, number] {
  const s = getPeriodStats(rival, period);
  const wins = Math.round(s.tradeCount * (s.winRate / 100));
  return [wins, Math.max(0, s.tradeCount - wins)];
}

function avgRText(rival: Rival, period: LeaderboardPeriod): string {
  const r = getPeriodStats(rival, period).avgR ?? rival.mascot.stats.avgR ?? null;
  return r == null ? '—' : r.toFixed(2);
}

function formatMetricGap(value: number, metric: LeaderboardMetric): string {
  if (metric === 'netPnl') return formatCurrency(Math.max(0, value)).replace('+', '');
  if (metric === 'riskAdjusted') return `${Math.max(0, value).toFixed(2)}x`;
  if (metric === 'journalStreak') return `${Math.ceil(Math.max(0, value))} days`;
  return `${Math.ceil(Math.max(0, value))} points`;
}

function rankMovement(rival: Rival, rivals: Rival[], metric: LeaderboardMetric, period: LeaderboardPeriod): number {
  if (period === 'allTime') return 0;
  const previous = rival.mascot.stats.previousPeriods?.[period];
  if (!previous) return 0;
  const previousValue = (candidate: Rival) => {
    const stats = candidate.mascot.stats.previousPeriods?.[period] ?? EMPTY_PERIOD;
    if (metric === 'netPnl') return stats.netPnl;
    if (metric === 'consistency') return stats.consistency;
    if (metric === 'riskAdjusted') return stats.riskAdjusted;
    return metricValue(candidate, metric, period);
  };
  const currentRank = [...rivals].sort((a, b) => metricValue(b, metric, period) - metricValue(a, metric, period)).findIndex(item => item.id === rival.id);
  const previousRank = [...rivals].sort((a, b) => previousValue(b) - previousValue(a)).findIndex(item => item.id === rival.id);
  return previousRank - currentRank;
}

// Rank movement pill: ▲n (up, green), ▼n (down, red), — (flat, muted).
// Hidden entirely for all-time (no prior period to compare against).
function MovementBadge({ delta, period }: { delta: number; period: LeaderboardPeriod }) {
  if (period === 'allTime') return null;
  const flat = delta === 0;
  const up = delta > 0;
  const color = flat ? LB.subtle : up ? LB.green : LB.red;
  return (
    <span
      title={flat ? 'No rank change this period' : `${up ? 'Up' : 'Down'} ${Math.abs(delta)} this period`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color }}
    >
      {flat ? <Minus size={11} /> : up ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
      {!flat && Math.abs(delta)}
    </span>
  );
}

function coachingInsight(rival: Rival, period: LeaderboardPeriod): string {
  const stats = getPeriodStats(rival, period);
  if (stats.tradeCount === 0) return 'No logged trades yet — the table moves when the journal fills.';
  if (stats.ruleAdherence > 0 && stats.ruleAdherence < 80) return `Process under pressure — ${Math.round(stats.ruleAdherence)}% rule adherence.`;
  if (stats.netPnl < 0) return 'Protect downside first — one clean day gets you back in motion.';
  if (stats.consistency < 65) return 'Profitable, but consistency is the fastest ranking lever.';
  return 'Momentum intact — keep pressing the repeatable setup.';
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Re-renders on an interval — drives the live season countdown. */
function useTicker(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Animates a number toward `target` (~700ms). Skips under reduced motion. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion()) { setValue(target); fromRef.current = target; return; }
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    const dur = 700;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
}

/** Cumulative-equity sparkline from a period's daily P&L (or equity curve). */
function Sparkline({ stats, up, width = 68, height = 22 }: { stats: RivalPeriodStats; up: boolean; width?: number; height?: number }) {
  const series = stats.equityCurve?.length
    ? stats.equityCurve
    : (stats.dailyPnl ?? []).reduce<number[]>((acc, d) => { acc.push((acc[acc.length - 1] ?? 0) + d.pnl); return acc; }, []);
  if (series.length < 2) return <div style={{ width, height }} aria-hidden="true" />;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const stepX = width / (series.length - 1);
  const pts = series.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ');
  const color = up ? 'var(--green)' : 'var(--red)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
    </svg>
  );
}

/** Trailing consecutive green days from a period's daily P&L — powers the 🔥 marker. */
function hotStreak(stats: RivalPeriodStats): number {
  const daily = stats.dailyPnl ?? [];
  let streak = 0;
  for (let i = daily.length - 1; i >= 0; i--) {
    if (daily[i].pnl > 0) streak++;
    else break;
  }
  return streak;
}

/** Count-up numeric display with a formatter (currency, %, etc.). */
function CountUp({ target, format }: { target: number; format: (n: number) => string }) {
  const v = useCountUp(target);
  return <>{format(v)}</>;
}

interface PulseEvent { id: string; text: ReactNode; tone: 'up' | 'down' | 'neutral'; }

/** Derives a live-feeling activity feed from real, verifiable board data —
 *  rank moves, hot streaks, best days, and the current leader. No fabrication. */
function buildActivityFeed(
  ranked: Rival[], leagueRivals: Rival[], metric: LeaderboardMetric, period: LeaderboardPeriod,
): PulseEvent[] {
  const events: PulseEvent[] = [];
  ranked.forEach((rival) => {
    const name = rival.isMe ? 'You' : rival.displayName;
    const move = rankMovement(rival, leagueRivals, metric, period);
    const rank = ranked.findIndex(r => r.id === rival.id) + 1;
    if (move > 0) events.push({ id: `mv-${rival.id}`, tone: 'up', text: <><b>{name}</b> climbed to #{rank}</> });
    else if (move < 0) events.push({ id: `mv-${rival.id}`, tone: 'down', text: <><b>{name}</b> slipped to #{rank}</> });
    const streak = hotStreak(getPeriodStats(rival, period));
    if (streak >= 2) events.push({ id: `st-${rival.id}`, tone: 'up', text: <><b>{name}</b> on a {streak}-day green streak</> });
    const daily = getPeriodStats(rival, period).dailyPnl ?? [];
    const best = daily.length ? Math.max(...daily.map(d => d.pnl)) : 0;
    if (best >= 500) events.push({ id: `bd-${rival.id}`, tone: 'up', text: <><b>{name}</b> booked a {formatCurrency(best)} day</> });
  });
  if (ranked[0]) events.push({ id: 'leader', tone: 'neutral', text: <><b>{ranked[0].isMe ? 'You' : ranked[0].displayName}</b> {ranked[0].isMe ? 'lead' : 'leads'} the board</> });
  return events.slice(0, 6);
}

/** The single hero stat for a metric — used big on the podium. */
function heroStat(stats: RivalPeriodStats, rival: Rival, metric: LeaderboardMetric): { value: string; tone: 'up' | 'down' | 'neutral'; label: string } {
  if (metric === 'winRate') return { value: `${Math.round(stats.winRate)}%`, tone: stats.winRate >= 50 ? 'up' : 'neutral', label: 'Win rate' };
  if (metric === 'consistency') return { value: `${Math.round(stats.consistency)}`, tone: stats.consistency >= 65 ? 'up' : 'neutral', label: 'Consistency' };
  if (metric === 'processScore') return { value: `${Math.round(rival.mascot.stats.processScore)}`, tone: rival.mascot.stats.processScore >= 65 ? 'up' : 'neutral', label: 'Process' };
  return { value: formatCurrency(stats.netPnl), tone: stats.netPnl > 0 ? 'up' : stats.netPnl < 0 ? 'down' : 'neutral', label: 'Net P&L' };
}

// Crafted marks — no emoji in the UI.
function Crown({ size = 22, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size * 0.78} viewBox="0 0 28 22" fill="currentColor" className={className} aria-hidden="true">
      <path d="M2.6 8.1 L7.8 13.6 L13.6 3.4 L19.4 13.6 L24.6 8.1 L22.7 18.4 Q22.4 19.6 21.1 19.6 L6.1 19.6 Q4.8 19.6 4.5 18.4 Z" />
      <circle cx="2.6" cy="6.6" r="2.1" /><circle cx="13.6" cy="2.4" r="2.1" /><circle cx="24.6" cy="6.6" r="2.1" />
    </svg>
  );
}
function Flame({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size * 1.28} viewBox="0 0 14 18" fill="currentColor" className={className} aria-hidden="true">
      <path d="M7 0 C9 4 12.5 5.2 11.4 10.4 A5 5 0 1 1 2 9.6 C1.8 12 3.2 7.8 4.4 8.6 C3.6 4.8 5.4 2.6 7 0 Z" />
    </svg>
  );
}

export default function Rivals() {
  const { rivals, addRival, rivalRequests, respondToRequest, profile } = useRivals();
  const { trades: allMyTrades } = useTrades();
  const [period, setPeriod] = useState<LeaderboardPeriod>('season');
  const [metric, setMetric] = useState<LeaderboardMetric>('netPnl');
  const [selectedRivalId, setSelectedRivalId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [activeChatRival, setActiveChatRival] = useState<Rival | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null);
  const [requestsOpen, setRequestsOpen] = useState(true);
  const [leagueBuilderOpen, setLeagueBuilderOpen] = useState(false);
  const [leagueName, setLeagueName] = useState('');
  const [leagueMembers, setLeagueMembers] = useState<string[]>([]);
  const leagues = useFlyxaStore(state => state.privateLeagues);
  const setPrivateLeagues = useFlyxaStore(state => state.setPrivateLeagues);
  const [activeLeagueId, setActiveLeagueId] = useState('all');
  const [inspectorTab, setInspectorTab] = useState<'overview' | 'progress' | 'trades'>('overview');
  const [sharedTrades, setSharedTrades] = useState<SharedTradeRecord[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [viewingSharedTrade, setViewingSharedTrade] = useState<SharedTradeRecord | null>(null);
  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const [sharingBusy, setSharingBusy] = useState<string | null>(null);
  const [sharedSet, setSharedSet] = useState<Set<string>>(new Set());
  const prevRivalIdRef = useRef<string | null>(null);
  const nowMs = useTicker(1000); // live season countdown

  // One-time migration: leagues used to live in localStorage only. Move them into
  // the store (synced to Supabase) and drop the legacy key.
  useEffect(() => {
    if (useFlyxaStore.getState().privateLeagues.length > 0) return;
    try {
      const raw = localStorage.getItem('flyxa-private-leagues');
      if (!raw) return;
      const parsed = JSON.parse(raw) as League[];
      localStorage.removeItem('flyxa-private-leagues');
      if (Array.isArray(parsed) && parsed.length > 0) setPrivateLeagues(parsed);
    } catch { /* ignore malformed legacy data */ }
  }, [setPrivateLeagues]);

  const currentUser = rivals.find(rival => rival.isMe) ?? rivals[0];
  const activeLeague = leagues.find(league => league.id === activeLeagueId);
  const leagueRivals = activeLeague
    ? rivals.filter(rival => rival.isMe || activeLeague.memberIds.includes(rival.id))
    : rivals;
  const ranked = useMemo(
    () => [...leagueRivals].sort((a, b) => metricValue(b, metric, period) - metricValue(a, metric, period)),
    [leagueRivals, metric, period],
  );
  const selectedRival = rivals.find(rival => rival.id === selectedRivalId) ?? currentUser;
  const pendingRequests = rivalRequests.filter(request => request.status === 'pending');

  // Reset share state when switching rivals
  useEffect(() => {
    if (prevRivalIdRef.current === selectedRivalId) return;
    prevRivalIdRef.current = selectedRivalId;
    setSharedSet(new Set());
    setSharePickerOpen(false);
  }, [selectedRivalId]);

  // Load trades shared WITH me by the selected rival when the Trades tab is open
  useEffect(() => {
    if (inspectorTab !== 'trades') return;
    const rivalUserId = rivals.find(r => r.id === selectedRivalId)?.userId;
    if (!rivalUserId) { setSharedTrades([]); return; }
    setSharesLoading(true);
    tradeSharesApi.getSharedWithMe()
      .then(data => setSharedTrades(data.filter(s => s.sharedByUserId === rivalUserId)))
      .catch(() => setSharedTrades([]))
      .finally(() => setSharesLoading(false));
  }, [inspectorTab, selectedRivalId, rivals]);

  async function handleShareTrade(tradeId: string) {
    const rivalUserId = rivals.find(r => r.id === selectedRivalId)?.userId;
    if (!rivalUserId) return;
    const trade = allMyTrades.find(t => t.id === tradeId);
    if (!trade) return;
    setSharingBusy(tradeId);
    try {
      await tradeSharesApi.share(tradeId, rivalUserId, trade);
      setSharedSet(prev => new Set([...prev, tradeId]));
    } finally {
      setSharingBusy(null);
    }
  }

  if (!currentUser || !selectedRival) return null;

  const selectedStats = getPeriodStats(selectedRival, period);
  const selectedPeriodLabel = PERIODS.find(item => item.value === period)?.label ?? 'selected period';
  const metricLabel = MODES.find(mode => mode.value === metric)?.label ?? 'Net P&L';

  const selectedPosition = ranked.findIndex(rival => rival.id === selectedRival.id) + 1;
  const aheadRival = selectedPosition > 1 ? ranked[selectedPosition - 2] : null;
  const selectedGap = aheadRival
    ? Math.max(0, metricValue(aheadRival, metric, period) - metricValue(selectedRival, metric, period))
    : 0;
  const selectedMovement = rankMovement(selectedRival, leagueRivals, metric, period);

  async function handleRequestAction(id: string, action: 'accept' | 'decline' | 'cancel') {
    setRequestBusyId(id);
    try { await respondToRequest(id, action); } finally { setRequestBusyId(null); }
  }

  function createLeague() {
    const name = leagueName.trim();
    if (!name) return;
    const league: League = { id: `league-${Date.now()}`, name, memberIds: leagueMembers };
    setPrivateLeagues([...leagues, league]);
    setActiveLeagueId(league.id);
    setLeagueName('');
    setLeagueMembers([]);
    setLeagueBuilderOpen(false);
  }

  // Current user's own standing — drives the "your standing" hook bar.
  const myPosition = ranked.findIndex(rival => rival.id === currentUser.id) + 1;
  const myAhead = myPosition > 1 ? ranked[myPosition - 2] : null;
  const myGap = myAhead
    ? Math.max(0, metricValue(myAhead, metric, period) - metricValue(currentUser, metric, period))
    : 0;
  const hasRivals = ranked.length >= 2;
  // Podium shows the top three; the table below is "the rest of the field"
  // (ranks 4+) so no one is ever rendered twice.
  const fieldRivals = ranked.slice(3);

  // Live countdown to the season lock (first of next month).
  const seasonEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime();
  const msLeft = Math.max(0, seasonEnd - nowMs);
  const cd = {
    d: Math.floor(msLeft / 86400000),
    h: Math.floor((msLeft % 86400000) / 3600000),
    m: Math.floor((msLeft % 3600000) / 60000),
    s: Math.floor((msLeft % 60000) / 1000),
  };

  // Chase (person ahead) and Defend (person directly behind).
  const myValue = metricValue(currentUser, metric, period);
  const behindRival = ranked[myPosition] ?? null; // myPosition is 1-based
  const defendGap = behindRival ? Math.max(0, myValue - metricValue(behindRival, metric, period)) : 0;
  const boardValues = ranked.map(r => metricValue(r, metric, period));
  const boardMin = Math.min(...boardValues, 0);
  const boardMax = Math.max(...boardValues, 1);
  const boardSpan = boardMax - boardMin || 1;
  const chaseFillPct = Math.round(((myValue - boardMin) / boardSpan) * 100);
  // Defend bar: how much of your lead over #below remains before they catch you.
  const defendCushion = behindRival
    ? Math.min(100, Math.round((defendGap / (Math.abs(myValue - boardMin) || 1)) * 100))
    : 100;
  const defendUrgent = behindRival ? defendGap < boardSpan * 0.12 : false;

  const activity = buildActivityFeed(ranked, leagueRivals, metric, period);

  // Ghost benchmark — the disciplined baseline a funded trader clears.
  const GHOST_WIN = 55;
  const myWin = Math.round(getPeriodStats(currentUser, period).winRate);
  const beatingGhost = myWin >= GHOST_WIN;

  const btnGhost: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 14px', borderRadius: 9, background: 'var(--app-panel-strong)', border: `1px solid ${LB.border}`, color: LB.text, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
  const btnPrimary: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 16px', borderRadius: 9, background: LB.amber, border: 'none', color: '#000', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
  const kicker: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: LB.subtle };

  return (
    <div className="rv2-page" style={{ color: LB.text }}>

      {/* ── Header ── */}
      <header data-tour-id="rivals-header" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24, padding: '2px 2px 18px' }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="rvc-display" style={{ margin: 0, fontSize: 30, color: LB.text }}>
            {activeLeague?.name ?? 'Rivals'}
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: 13.5, color: LB.muted, lineHeight: 1.6 }}>
            Ranked on <span className="rvc-verified"><Check size={12} strokeWidth={3} /> verified journal data</span> — no screenshots, no claims.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
          <button type="button" onClick={() => setLeagueBuilderOpen(open => !open)} style={btnGhost}>Edit league</button>
          <button type="button" onClick={() => setIsAddOpen(true)} style={btnPrimary}>Invite traders</button>
        </div>
      </header>

      {pendingRequests.length > 0 && (
        <div className="rivals-requests-banner">
          <button type="button" className="rivals-requests-banner-header" onClick={() => setRequestsOpen(open => !open)}>
            <span className="rivals-requests-banner-icon"><Bell size={14} /><span className="rivals-requests-banner-pulse" /></span>
            <span className="rivals-requests-banner-label">Pending invites <span className="rivals-requests-banner-count">{pendingRequests.length}</span></span>
            <ChevronDown size={15} style={{ transform: requestsOpen ? 'rotate(180deg)' : undefined }} />
          </button>
          {requestsOpen && <div className="rivals-requests-banner-body">{pendingRequests.map(request => (
            <RequestRow key={request.id} request={request} busy={requestBusyId === request.id} onAction={action => void handleRequestAction(request.id, action)} />
          ))}</div>}
        </div>
      )}

      {leagueBuilderOpen && (
        <section className="rv-league-builder">
          <div>
            <span className="rv-section-kicker">NEW PRIVATE LEAGUE</span>
            <h3>Build your circle</h3>
            <p>Choose accepted rivals and save a focused leaderboard.</p>
          </div>
          <input value={leagueName} onChange={event => setLeagueName(event.target.value)} placeholder="League name" />
          <div className="rv-member-picks">
            {rivals.filter(rival => !rival.isMe).map(rival => (
              <button type="button" key={rival.id} className={leagueMembers.includes(rival.id) ? 'selected' : ''} onClick={() => setLeagueMembers(current => current.includes(rival.id) ? current.filter(id => id !== rival.id) : [...current, rival.id])}>
                <RivalAvatar rival={rival} /> {rival.displayName} {leagueMembers.includes(rival.id) && <Check size={13} />}
              </button>
            ))}
          </div>
          <button type="button" className="rivals-cta" onClick={createLeague}>Create league</button>
        </section>
      )}

      {/* ── Controls: text tabs + period ── */}
      <div data-tour-id="rivals-controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', margin: '4px 0 6px' }}>
        <div className="rvc-tabs">
          {MODES.map(mode => (
            <button type="button" key={mode.value} title={mode.help} onClick={() => setMetric(mode.value)}
              className={`rvc-tab${metric === mode.value ? ' on' : ''}`}>{mode.label}</button>
          ))}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          {leagues.length > 0 && (
            <div className="rvc-period">
              {[{ id: 'all', name: 'All' }, ...leagues.map(l => ({ id: l.id, name: l.name }))].map(l => (
                <button type="button" key={l.id} onClick={() => setActiveLeagueId(l.id)} className={activeLeagueId === l.id ? 'on' : ''}>{l.name}</button>
              ))}
            </div>
          )}
          <div className="rvc-period">
            {PERIODS.map(item => (
              <button type="button" key={item.value} onClick={() => setPeriod(item.value)} className={period === item.value ? 'on' : ''}>{item.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Countdown: a bare live clock between two hairlines ── */}
      {hasRivals && (<>
        <hr className="rvc-rule" style={{ marginTop: 8 }} />
        <div className="rvc-count rvc-fade">
          <div className="rvc-count-clock">
            {([['Days', cd.d], ['Hrs', cd.h], ['Min', cd.m], ['Sec', cd.s]] as const).map(([label, val], idx) => (
              <div key={label} style={{ display: 'flex', alignItems: 'flex-end', gap: 20 }}>
                {idx > 0 && <span className="rvc-count-colon">:</span>}
                <div className="rvc-count-seg">
                  <span className="rvc-count-num">{idx === 0 ? val : String(val).padStart(2, '0')}</span>
                  <span className="rvc-count-label">{label}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, color: LB.muted, textAlign: 'right', maxWidth: 320, lineHeight: 1.55 }}>
            {seasonLabel()} board locks then. <b style={{ color: LB.text, fontWeight: 600 }}>The champion</b> takes the trophy shelf and the hall of fame.
          </div>
        </div>
        <hr className="rvc-rule" style={{ marginBottom: 22 }} />
      </>)}

      {/* ── Podium: asymmetric — champion carries the mass ── */}
      {hasRivals && (() => {
        const champ = ranked[0];
        const runners = ranked.slice(1, 3);
        const metricNum = (r: Rival) => metric === 'netPnl' ? getPeriodStats(r, period).netPnl : metric === 'winRate' ? getPeriodStats(r, period).winRate : metric === 'consistency' ? getPeriodStats(r, period).consistency : r.mascot.stats.processScore;
        const fmtMetric = (n: number) => metric === 'netPnl' ? formatCurrency(n) : metric === 'winRate' ? `${Math.round(n)}%` : `${Math.round(n)}`;
        const toneColor = (r: Rival) => { const t = heroStat(getPeriodStats(r, period), r, metric).tone; return t === 'up' ? LB.green : t === 'down' ? LB.red : LB.text; };
        const subLine = (r: Rival) => { const s = getPeriodStats(r, period); return `${Math.round(s.winRate)}% win · ${avgRText(r, period)}R · ${Math.round(s.ruleAdherence)}% rules`; };
        const cs = getPeriodStats(champ, period);
        const champStreak = hotStreak(cs);
        return (
          <div className="rvc-podium rvc-fade">
            {/* Champion */}
            <button type="button" onClick={() => { setSelectedRivalId(champ.id); setInspectorOpen(true); }} className="rvc-champ">
              <span className="rvc-champ-num rvc-serif">1</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative', zIndex: 1 }}>
                <Crown size={22} className="rvc-crown rvc-crown--bob" />
                <span className="rvc-eyebrow" style={{ color: 'var(--color-gold, #f6c343)' }}>Champion</span>
                {champStreak >= 2 && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 4, fontSize: 12, fontWeight: 600, color: LB.amber }}><Flame size={12} className="rvc-flame rvc-flame--pulse" />{champStreak}-day run</span>}
                <span style={{ marginLeft: 'auto' }}><MovementBadge delta={rankMovement(champ, leagueRivals, metric, period)} period={period} /></span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginTop: 20, position: 'relative', zIndex: 1 }}>
                <RivalAvatar rival={champ} large />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20, color: LB.text, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{champ.displayName}</span>
                    <Check size={13} strokeWidth={3} color={LB.green} aria-label="Verified" />
                    {champ.isMe && <span className="rvc-you">YOU</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: LB.muted, marginTop: 2 }}>@{champ.username}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 14, marginTop: 22, position: 'relative', zIndex: 1 }}>
                <div className="rvc-champ-pnl" style={{ color: toneColor(champ) }}>
                  <CountUp target={metricNum(champ)} format={fmtMetric} />
                </div>
                <Sparkline stats={cs} up={cs.netPnl >= 0} width={120} height={34} />
              </div>
              <div className="rvc-champ-sub" style={{ marginTop: 16 }}>
                {Math.round(cs.winRate)}% win<span className="rvc-dot">·</span>{avgRText(champ, period)}R avg<span className="rvc-dot">·</span><b style={{ color: cs.ruleAdherence >= 80 ? LB.green : LB.text }}>{Math.round(cs.ruleAdherence)}% rule adherence</b>
              </div>
            </button>
            {/* Runners #2 / #3 */}
            <div className="rvc-runners">
              {runners.map((rival, ri) => {
                const rank = ri + 2;
                const s = getPeriodStats(rival, period);
                const streak = hotStreak(s);
                return (
                  <button key={rival.id} type="button" onClick={() => { setSelectedRivalId(rival.id); setInspectorOpen(true); }} className="rvc-runner">
                    <span className="rvc-runner-num rvc-serif" style={{ color: LB.subtle }}>{rank}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <RivalAvatar rival={rival} />
                        <span style={{ fontSize: 15, fontWeight: 600, color: LB.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rival.displayName}</span>
                        <Check size={11} strokeWidth={3} color={LB.green} aria-label="Verified" />
                        {rival.isMe && <span className="rvc-you">YOU</span>}
                        {streak >= 2 && <Flame size={11} className="rvc-flame rvc-flame--pulse" />}
                      </div>
                      <div className="rvc-runner-sub">{subLine(rival)}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="rvc-runner-pnl" style={{ color: toneColor(rival) }}>{fmtMetric(metricNum(rival))}</div>
                      <div style={{ marginTop: 3, display: 'flex', justifyContent: 'flex-end' }}><MovementBadge delta={rankMovement(rival, leagueRivals, metric, period)} period={period} /></div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Chase & Defend — bare, split by a hairline ── */}
      {hasRivals && (myAhead || behindRival) && (
        <div className="rvc-cd rvc-fade" style={{ marginTop: 26 }}>
          <div className="rvc-cd-col">
            {myAhead ? (<>
              <div className="rvc-cd-head">Chasing <b>{myAhead.displayName}</b></div>
              <div className="rvc-cd-big" style={{ color: LB.amber }}>{formatMetricGap(myGap, metric)}</div>
              <div className="rvc-track"><div className="rvc-track-fill rvc-track-fill--amber" style={{ width: `${Math.max(4, Math.min(100, chaseFillPct))}%` }} /></div>
              <div className="rvc-cd-note">{chaseFillPct}% of the way up the board — {formatMetricGap(myGap, metric)} to take #{myPosition - 1}.</div>
            </>) : (<>
              <div className="rvc-cd-head" style={{ color: LB.green }}>Leading the board</div>
              <div className="rvc-cd-big" style={{ color: LB.green }}>#1</div>
              <div className="rvc-cd-note">Hold the top until the board locks to take the season.</div>
            </>)}
          </div>
          <div className="rvc-cd-col">
            {behindRival ? (<>
              <div className="rvc-cd-head">Defending <b>#{myPosition}</b> from <b>{behindRival.displayName}</b></div>
              <div className="rvc-cd-big" style={{ color: defendUrgent ? LB.red : LB.text }}>{formatMetricGap(defendGap, metric)}</div>
              <div className="rvc-track"><div className={`rvc-track-fill ${defendUrgent ? 'rvc-track-fill--red' : 'rvc-track-fill--green'}`} style={{ width: `${Math.max(4, defendCushion)}%` }} /></div>
              <div className={`rvc-cd-note${defendUrgent ? ' rvc-cd-note--warn' : ''}`}>{defendUrgent ? 'Closing in fast — one red day flips the spot.' : 'A comfortable cushion, for now.'}</div>
            </>) : (<>
              <div className="rvc-cd-head">Back of the board</div>
              <div className="rvc-cd-note" style={{ marginTop: 8 }}>No one behind you yet. Invite more traders to raise the stakes.</div>
            </>)}
          </div>
        </div>
      )}

      {/* ── Benchmark: one quiet sentence ── */}
      {hasRivals && (
        <div className="rvc-bench rvc-fade" style={{ marginTop: 22 }}>
          The average funded trader clears a <b>{GHOST_WIN}% win rate</b>.{' '}
          {beatingGhost
            ? <>You're <span style={{ color: LB.green, fontWeight: 600 }}>ahead of that benchmark</span> at {myWin}%.</>
            : <>You're at {myWin}% — <span style={{ color: LB.text, fontWeight: 600 }}>{GHOST_WIN - myWin} points</span> from clearing it.</>}
        </div>
      )}

      {/* ── Activity: bare feed on hairlines ── */}
      {hasRivals && activity.length > 0 && (
        <div className="rvc-fade" style={{ marginTop: 26 }}>
          <div className="rvc-feed-head">
            <span className="rvc-live-dot" />
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 15, color: LB.text }}>Live</span>
          </div>
          {activity.map(ev => (
            <div key={ev.id} className="rvc-feed-row">
              <span className="rvc-feed-tick" style={{ background: ev.tone === 'up' ? LB.green : ev.tone === 'down' ? LB.red : LB.subtle }} />
              <span>{ev.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Low state: no rivals yet — coach the invite, don't show a bare board ── */}
      {!hasRivals && (
        <div style={{ background: LB.card, border: `1px solid ${LB.border}`, borderRadius: 14, padding: '48px 28px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }} data-tour-id="rivals-standings">
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--app-panel-strong)', border: `1px solid ${LB.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: LB.amber }}>
            <Users size={22} />
          </div>
          <div style={{ maxWidth: 420 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: LB.text }}>Your board is empty</h3>
            <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.6, color: LB.muted }}>
              Rivals compares verified journal stats side by side — profit, consistency, and process. Invite a trading friend by their Flyxa username to start the table.
            </p>
          </div>
          <button type="button" onClick={() => setIsAddOpen(true)} style={{ ...btnPrimary, height: 40 }}><Plus size={14} /> Invite a trader</button>
        </div>
      )}

      {/* ── The rest of the field: ranks 4+ (podium already shows the top 3) ── */}
      {hasRivals && fieldRivals.length > 0 && (
      <div style={{ background: LB.card, border: `1px solid ${LB.border}`, borderRadius: 14, overflow: 'hidden' }} data-tour-id="rivals-standings">
        {(() => {
          const cols = '52px minmax(0, 1fr) 150px 110px 110px 130px';
          return (
            <>
              <div style={{ ...kicker, display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center', padding: '12px 22px', borderBottom: `1px solid ${LB.border}` }}>
                <span>Place</span><span>Trader</span><span>{selectedPeriodLabel} W - L</span><span>Win rate</span><span>Avg R</span>
                <span style={{ textAlign: 'right' }}>{metricLabel}</span>
              </div>
              {fieldRivals.map((rival, i) => {
                const index = i + 3; // real rank index (podium took 0-2)
                const s = getPeriodStats(rival, period);
                const [w, l] = winsLosses(rival, period);
                return (
                  <button key={rival.id} type="button" onClick={() => { setSelectedRivalId(rival.id); setInspectorOpen(true); }}
                    style={{ width: '100%', display: 'grid', gridTemplateColumns: cols, gap: 12, alignItems: 'center', textAlign: 'left', padding: '14px 22px', borderTop: i === 0 ? 'none' : `1px solid ${LB.border}`, borderLeft: rival.isMe ? `2px solid ${LB.amber}` : '2px solid transparent', background: rival.isMe ? LB.rowYou : 'transparent', color: LB.text, cursor: 'pointer', font: 'inherit' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: LB.muted }}>{index + 1}</span>
                      <MovementBadge delta={rankMovement(rival, leagueRivals, metric, period)} period={period} />
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                      <RivalAvatar rival={rival} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <b style={{ fontSize: 13.5, fontWeight: 600, color: LB.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rival.displayName}</b>
                          {rival.isMe && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.08em', padding: '2px 6px', borderRadius: 4, border: `1px solid ${LB.amber}`, color: LB.amber }}>YOU</span>}
                        </div>
                        <div style={{ fontSize: 11.5, color: LB.muted }}>@{rival.username}</div>
                      </div>
                    </div>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: LB.text, display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ borderBottom: `2px solid ${LB.green}`, paddingBottom: 2 }}>{w}</span>
                      <span style={{ color: LB.subtle }}>-</span>
                      <span>{l}</span>
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: LB.text }}>{Math.round(s.winRate)}%</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: LB.text }}>{avgRText(rival, period)}</span>
                    <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500, color: s.netPnl > 0 ? LB.green : s.netPnl < 0 ? LB.red : LB.text }}>{formatCurrency(s.netPnl)}</span>
                  </button>
                );
              })}
              <button type="button" onClick={() => setIsAddOpen(true)} style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '15px 0', borderTop: `1px solid ${LB.border}`, background: 'transparent', border: 'none', color: LB.muted, fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.04em', cursor: 'pointer' }}>
                <Plus size={13} /> Add a rival to the board
              </button>
            </>
          );
        })()}
      </div>
      )}

      {/* ── Grow-the-board CTA when the podium is the whole field ── */}
      {hasRivals && fieldRivals.length === 0 && (
        <button type="button" onClick={() => setIsAddOpen(true)}
          style={{ width: '100%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '16px 0', borderRadius: 14, border: `1px dashed ${LB.border}`, background: 'transparent', color: LB.muted, fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.04em', cursor: 'pointer' }}>
          <Plus size={14} /> Invite more traders to grow the board
        </button>
      )}

      {/* ── Inspector drawer (opens on row click / Show my place) ── */}
      {inspectorOpen && (
        <div onClick={() => setInspectorOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', display: 'flex', justifyContent: 'flex-end' }}>
          <aside className="rv2-me" data-tour-id="rivals-detail" onClick={e => e.stopPropagation()} style={{ position: 'relative', width: 'min(380px, 92vw)', height: '100%', overflowY: 'auto', borderRadius: 0 }}>
            <button type="button" onClick={() => setInspectorOpen(false)} aria-label="Close" style={{ position: 'absolute', top: 12, right: 12, width: 28, height: 28, borderRadius: '50%', border: `1px solid ${LB.border}`, background: 'var(--app-panel-strong)', color: LB.muted, cursor: 'pointer', zIndex: 2 }}>✕</button>
          <div className="rv2-me-hd">
            <RivalAvatar rival={selectedRival} large />
            <div className="rv2-nm">
              <b>{selectedRival.displayName}</b>
              <span>@{selectedRival.username}</span>
            </div>
            {!selectedRival.isMe && selectedRival.userId && (
              <button type="button" className="rv2-chat" aria-label={`Message ${selectedRival.displayName}`} onClick={() => { setActiveChatRival(selectedRival); setChatOpen(true); }}>
                <MessageCircle size={14} />
              </button>
            )}
          </div>

          <div className="rv-inspector-tabs">
            <button type="button" className={inspectorTab === 'overview' ? 'active' : ''} onClick={() => setInspectorTab('overview')}>Overview</button>
            <button type="button" className={inspectorTab === 'progress' ? 'active' : ''} onClick={() => setInspectorTab('progress')}>Progress</button>
            <button type="button" className={inspectorTab === 'trades' ? 'active' : ''} onClick={() => setInspectorTab('trades')}>Trades</button>
          </div>

          {inspectorTab === 'overview' ? (
            <>
              <div className="rv2-me-rank">
                <b>#{selectedPosition}<span> of {ranked.length}</span></b>
                <i>
                  {selectedMovement > 0 ? `▲ ${selectedMovement} THIS ${period === 'week' ? 'WEEK' : 'PERIOD'}`
                    : selectedMovement < 0 ? `▼ ${Math.abs(selectedMovement)} THIS ${period === 'week' ? 'WEEK' : 'PERIOD'}`
                    : 'NO RANK CHANGE'}
                </i>
              </div>
              <div className="rv2-gap">
                {aheadRival
                  ? <><b>{formatMetricGap(selectedGap, metric)}</b> behind #{selectedPosition - 1} on {metricLabel.toLowerCase()}</>
                  : <>Leading this board on <b>{metricLabel.toLowerCase()}</b></>}
              </div>
              <div className="rv2-kv">
                <div className="rv2-kv-cell">
                  <span className="rv2-lbl">{selectedPeriodLabel} P&amp;L</span>
                  <b className={selectedStats.netPnl > 0 ? 'pos' : selectedStats.netPnl < 0 ? 'neg' : ''}>{formatCurrency(selectedStats.netPnl)}</b>
                </div>
                <div className="rv2-kv-cell"><span className="rv2-lbl">Trades</span><b>{selectedStats.tradeCount}</b></div>
                <div className="rv2-kv-cell"><span className="rv2-lbl">Win rate</span><b>{selectedStats.winRate}%</b></div>
                <div className="rv2-kv-cell"><span className="rv2-lbl">Consistency</span><b>{selectedStats.consistency}/100</b></div>
                <div className="rv2-kv-cell">
                  <span className="rv2-lbl">Rule adherence</span>
                  <b>{selectedStats.ruleAdherence > 0 ? `${Math.round(selectedStats.ruleAdherence)}%` : '—'}</b>
                </div>
                <div className="rv2-kv-cell">
                  <span className="rv2-lbl">Green days</span>
                  <b>{selectedStats.greenDays}{selectedStats.tradingDays > 0 ? ` of ${selectedStats.tradingDays}` : ''}</b>
                </div>
              </div>
              <div className="rv2-me-note">{coachingInsight(selectedRival, period)}</div>
            </>
          ) : inspectorTab === 'progress' ? (
            (() => {
              const weekStats = getPeriodStats(selectedRival, 'week');
              const habits = [
                { label: 'Document every trade', pct: Math.round(selectedRival.mascot.stats.tradingJournalScore), value: `${Math.round(selectedRival.mascot.stats.tradingJournalScore)}%` },
                { label: 'Verified rule adherence', pct: Math.round(weekStats.ruleAdherence), value: `${Math.round(weekStats.ruleAdherence)}%` },
                { label: 'Build a green streak', pct: Math.round((weekStats.greenDays / 5) * 100), value: `${Math.min(weekStats.greenDays, 5)}/5` },
              ];
              const milestones = [
                { label: 'Five green days', done: selectedStats.greenDays >= 5 },
                { label: '90% rule adherence', done: selectedStats.ruleAdherence >= 90 },
                { label: 'Controlled drawdown', done: selectedStats.maxDrawdown <= Math.max(100, Math.abs(selectedStats.netPnl) * .3) },
                { label: '10 documented trades', done: selectedStats.tradeCount >= 10 },
                { label: '60% win rate', done: selectedStats.winRate >= 60 },
                { label: '75 consistency score', done: selectedStats.consistency >= 75 },
              ];
              const doneCount = milestones.filter(m => m.done).length;
              return (
                <div className="rv2-prog">
                  <div className="rv2-sec-hd"><span>Weekly habits</span><span>RESETS MONDAY</span></div>
                  {habits.map(habit => (
                    <div key={habit.label} className="rv2-hab">
                      <span className="rv2-hab-name">{habit.label}</span>
                      <span className="rv2-cb"><i style={{ width: `${Math.max(0, Math.min(100, habit.pct))}%` }} /></span>
                      <b>{habit.value}</b>
                    </div>
                  ))}
                  <div className="rv2-sec-hd"><span>Milestones</span><span>{doneCount} OF {milestones.length}</span></div>
                  {milestones.map(milestone => (
                    <div key={milestone.label} className={`rv2-ms${milestone.done ? ' done' : ''}`}>
                      <span>{milestone.label}</span>
                      <b>{milestone.done ? '✓' : '·'}</b>
                    </div>
                  ))}
                </div>
              );
            })()
          ) : (
            /* Trades tab */
            <div className="rv-trades-panel">
              {selectedRival.isMe ? (
                <p className="rv-trades-empty">Select a rival to see trades they've shared with you.</p>
              ) : (
                <>
                  <div className="rv-trades-section-head">
                    <span>Shared by {selectedRival.displayName}</span>
                  </div>

                  {sharesLoading ? (
                    <p className="rv-trades-empty">Loading…</p>
                  ) : sharedTrades.length === 0 ? (
                    <p className="rv-trades-empty">No trades shared with you yet.</p>
                  ) : (
                    sharedTrades.map((record) => {
                      const { shareId, sharedAt, trade } = record;
                      return (<button key={shareId} type="button" className="rv-shared-trade" onClick={() => setViewingSharedTrade(record)}>
                        <div className="rv-st-header">
                          <span className="rv-st-symbol">{trade.symbol}</span>
                          <span className={`rv-st-dir ${trade.direction === 'Long' ? 'long' : 'short'}`}>{trade.direction.toUpperCase()}</span>
                          <span className="rv-st-date">{trade.trade_date}</span>
                          <span className={`rv-st-pnl ${trade.pnl >= 0 ? 'positive' : 'negative'}`}>{formatCurrency(trade.pnl)}</span>
                        </div>
                        <div className="rv-st-meta">
                          <span>Entry {trade.entry_price}</span>
                          <span>Exit {trade.exit_price}</span>
                          <span>{trade.exit_reason}</span>
                          <span className="rv-st-shared-at">{new Date(sharedAt).toLocaleDateString()}</span>
                        </div>
                        {trade.screenshot_url && (
                          <div className="rv-st-screenshot">
                            <img src={trade.screenshot_url} alt="Trade screenshot" />
                          </div>
                        )}
                        {(trade.pre_trade_notes || trade.post_trade_notes) && (
                          <div className="rv-st-notes">
                            {trade.pre_trade_notes && <p>{trade.pre_trade_notes}</p>}
                            {trade.post_trade_notes && <p>{trade.post_trade_notes}</p>}
                          </div>
                        )}
                      </button>
                    );})
                  )}

                  {!selectedRival.isMe && selectedRival.userId && (
                    <>
                      <div className="rv-trades-section-head rv-trades-share-head">
                        <span>Share a trade</span>
                        <button
                          type="button"
                          className="rv-trades-share-toggle"
                          onClick={() => setSharePickerOpen(p => !p)}
                        >
                          <Share2 size={11} />
                          {sharePickerOpen ? 'Cancel' : `With ${selectedRival.displayName}`}
                        </button>
                      </div>

                      {sharePickerOpen && (
                        allMyTrades.length === 0 ? (
                          <p className="rv-trades-empty">No trades found in your journal yet.</p>
                        ) : (
                          <div className="rv-share-picker">
                            {allMyTrades.slice(0, 20).map(trade => {
                              const alreadyShared = sharedSet.has(trade.id);
                              const busy = sharingBusy === trade.id;
                              return (
                                <div key={trade.id} className={`rv-share-trade-row${alreadyShared ? ' shared' : ''}`}>
                                  <span className="rv-st-symbol">{trade.symbol}</span>
                                  <span className={`rv-st-dir ${trade.direction === 'Long' ? 'long' : 'short'}`}>{trade.direction.toUpperCase()}</span>
                                  <span className="rv-st-date">{trade.trade_date}</span>
                                  <span className={`rv-st-pnl ${trade.pnl >= 0 ? 'positive' : 'negative'}`}>{formatCurrency(trade.pnl)}</span>
                                  <button
                                    type="button"
                                    className={`rv-share-btn${alreadyShared ? ' shared' : ''}`}
                                    disabled={busy || alreadyShared}
                                    onClick={() => void handleShareTrade(trade.id)}
                                  >
                                    {alreadyShared ? <><Check size={10} /> Shared</> : busy ? '…' : 'Share'}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}
          </aside>
        </div>
      )}

      <AddRivalModal open={isAddOpen} onClose={() => setIsAddOpen(false)} onSubmit={username => addRival(username)} />
      <RivalChatPanel open={chatOpen} rival={activeChatRival} myUserId={profile?.userId ?? null} onClose={() => setChatOpen(false)} />
      {viewingSharedTrade && (
        <ScreenshotImportModal
          isOpen
          readOnly
          sharedByName={viewingSharedTrade.sharedByProfile?.display_name ?? selectedRival.displayName}
          editTrade={viewingSharedTrade.trade}
          onClose={() => setViewingSharedTrade(null)}
          onSave={async () => {}}
        />
      )}
    </div>
  );
}

function RivalAvatar({ rival, large = false }: { rival: Rival; large?: boolean }) {
  return <span className={`rv-leader-avatar ${large ? 'large' : ''}`} style={{ color: rival.avatarColor, borderColor: `${rival.avatarColor}66`, background: `${rival.avatarColor}18` }}>{rival.avatarUrl ? <img src={rival.avatarUrl} alt="" /> : rival.avatarInitials}</span>;
}

function RequestRow({ request, busy, onAction }: { request: RivalRequestResponse; busy: boolean; onAction: (action: 'accept' | 'decline' | 'cancel') => void }) {
  const rival = request.profile;
  const incoming = request.direction === 'incoming';
  return <div className="rivals-request-row">
    <div className="rivals-request-avatar" style={{ color: rival?.avatarColor, borderColor: `${rival?.avatarColor ?? '#fff'}38`, background: `${rival?.avatarColor ?? '#fff'}14` }}>{rival?.avatarUrl ? <img src={rival.avatarUrl} alt="" /> : rival?.avatarInitials ?? '??'}</div>
    <div className="rivals-request-copy"><strong>{rival?.displayName ?? 'Unknown trader'}</strong><span>{incoming ? 'Wants to join your leaderboard' : 'Invite sent'} · @{rival?.username ?? 'unknown'}</span></div>
    <div className="rivals-request-actions">{incoming ? <><button className="request-accept" disabled={busy} onClick={() => onAction('accept')}><Check size={13} /> Accept</button><button className="request-decline" disabled={busy} onClick={() => onAction('decline')}><X size={13} /> Decline</button></> : <button className="request-decline" disabled={busy} onClick={() => onAction('cancel')}><Clock3 size={13} /> Cancel</button>}</div>
  </div>;
}
