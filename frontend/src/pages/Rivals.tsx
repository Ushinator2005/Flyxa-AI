import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  ArrowUp, ArrowDown, Bell, Check, ChevronDown, Clock3,
  MessageCircle, Minus, Plus, Share2, Trophy, Users, X,
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

// The season is the calendar month; standings reset on the 1st. Days-left is
// the honest, low-key way to say that — no ticking clock implying live stakes.
function countdownDaysLeft(): number {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86400000));
}

function seasonLabel(): string {
  const now = new Date();
  return now.toLocaleString('en-US', { month: 'long' });
}

// A neutral flavour tier derived from the trader's strongest attribute.
// Deliberately non-punitive — the down case is "Building", never a red badge.
function tierFor(rival: Rival, period: LeaderboardPeriod): string {
  const s = getPeriodStats(rival, period);
  const process = rival.mascot.stats.processScore ?? 0;
  if (s.winRate >= 55 && s.netPnl > 0) return 'Apex';
  if (process >= 65 || s.ruleAdherence >= 80) return 'Disciplined';
  if (s.consistency >= 55) return 'Consistent';
  if (s.tradeCount === 0) return 'On deck';
  return 'Building';
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
  const myMovement = rankMovement(currentUser, leagueRivals, metric, period);
  const hasRivals = ranked.length >= 2;
  // Podium is the celebratory top-3; the table below is "the rest of the
  // field" (ranks 4+) so no one is ever rendered twice.
  const podiumRivals = ranked.slice(0, 3);
  const fieldRivals = ranked.slice(3);
  const daysToSeasonEnd = Number(countdownDaysLeft());

  const btnGhost: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 14px', borderRadius: 9, background: 'var(--app-panel-strong)', border: `1px solid ${LB.border}`, color: LB.text, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
  const btnPrimary: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 16px', borderRadius: 9, background: LB.amber, border: 'none', color: '#000', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };
  const kicker: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 500, letterSpacing: '0.14em', textTransform: 'uppercase', color: LB.subtle };

  return (
    <div className="rv2-page" style={{ color: LB.text }}>

      {/* ── Header ── */}
      <header data-tour-id="rivals-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, padding: '4px 2px 22px' }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', color: LB.text }}>
            {activeLeague?.name ?? 'Rivals'}
          </h1>
          <p style={{ margin: '7px 0 0', fontSize: 13, lineHeight: 1.6, color: LB.muted, maxWidth: 520 }}>
            <b style={{ color: LB.text, fontWeight: 600 }}>{ranked.length}</b> {ranked.length === 1 ? 'trader' : 'traders'} · ranked on verified journal data — no screenshots, no claims.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 14, flexShrink: 0 }}>
          <div style={{ ...kicker, whiteSpace: 'nowrap' }}>
            {seasonLabel()} season · resets in {daysToSeasonEnd} {daysToSeasonEnd === 1 ? 'day' : 'days'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <button type="button" onClick={() => setLeagueBuilderOpen(open => !open)} style={btnGhost}>Edit league</button>
            <button type="button" onClick={() => setIsAddOpen(true)} style={btnPrimary}>Invite traders</button>
          </div>
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

      {/* ── Controls: rank-by tabs + period filters ── */}
      <div data-tour-id="rivals-controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', margin: '2px 0 18px' }}>
        <div style={{ display: 'inline-flex', gap: 3, padding: 4, background: LB.card, borderRadius: 11, border: `1px solid ${LB.border}` }}>
          {MODES.map(mode => {
            const on = metric === mode.value;
            return (
              <button type="button" key={mode.value} title={mode.help} onClick={() => setMetric(mode.value)}
                style={{ padding: '7px 15px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, background: on ? LB.amber : 'transparent', color: on ? '#000' : LB.muted }}>
                {mode.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {leagues.length > 0 && (
            <div style={{ display: 'inline-flex', gap: 3, padding: 4, background: LB.card, borderRadius: 11, border: `1px solid ${LB.border}` }}>
              {[{ id: 'all', name: 'All' }, ...leagues.map(l => ({ id: l.id, name: l.name }))].map(l => {
                const on = activeLeagueId === l.id;
                return <button type="button" key={l.id} onClick={() => setActiveLeagueId(l.id)} style={{ padding: '7px 13px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: on ? 'var(--app-panel-strong)' : 'transparent', color: on ? LB.text : LB.muted }}>{l.name}</button>;
              })}
            </div>
          )}
          <div style={{ display: 'inline-flex', gap: 3, padding: 4, background: LB.card, borderRadius: 11, border: `1px solid ${LB.border}` }}>
            {PERIODS.map(item => {
              const on = period === item.value;
              return <button type="button" key={item.value} onClick={() => setPeriod(item.value)} style={{ padding: '7px 13px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: on ? 'var(--app-panel-strong)' : 'transparent', color: on ? LB.text : LB.muted }}>{item.label}</button>;
            })}
          </div>
          <button type="button" onClick={() => { setSelectedRivalId(currentUser.id); setInspectorOpen(true); }} style={{ ...btnGhost, height: 38 }}>Show my place</button>
        </div>
      </div>

      {/* ── Your standing: the hook. Rank, movement, and the gap to close. ── */}
      {hasRivals && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', background: LB.card, border: `1px solid ${LB.borderHi}`, borderRadius: 14, padding: '16px 22px', marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
            <RivalAvatar rival={currentUser} />
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: LB.text, fontFamily: 'var(--font-sans)' }}>#{myPosition}</span>
                <span style={{ fontSize: 12.5, color: LB.muted }}>of {ranked.length} on {metricLabel}</span>
                <MovementBadge delta={myMovement} period={period} />
              </div>
              <div style={{ marginTop: 3, fontSize: 12.5, color: LB.muted }}>
                {myAhead
                  ? <>{formatMetricGap(myGap, metric)} behind <b style={{ color: LB.text, fontWeight: 600 }}>{myAhead.displayName}</b> to move up</>
                  : <b style={{ color: LB.green, fontWeight: 600 }}>Leading the board</b>}
              </div>
            </div>
          </div>
          <div style={{ fontSize: 12.5, color: LB.muted, maxWidth: 360, textAlign: 'right' }}>{coachingInsight(currentUser, period)}</div>
        </div>
      )}

      {/* ── Podium: the celebratory top three ── */}
      {hasRivals && (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(3, podiumRivals.length)}, minmax(0, 1fr))`, gap: 16, marginBottom: 16 }}>
        {podiumRivals.map((rival, i) => {
          const s = getPeriodStats(rival, period);
          const trophyColor = i === 0 ? 'var(--color-gold)' : i === 1 ? 'var(--color-silver)' : 'var(--color-bronze)';
          const podStat = (label: string, value: string, color?: string) => (
            <div style={{ minWidth: 0 }}>
              <div style={kicker}>{label}</div>
              <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: color ?? LB.text }}>{value}</div>
            </div>
          );
          const ahead = i > 0 ? ranked[i - 1] : null;
          const gap = ahead ? Math.max(0, metricValue(ahead, metric, period) - metricValue(rival, metric, period)) : 0;
          const movement = rankMovement(rival, leagueRivals, metric, period);
          return (
            <button key={rival.id} type="button" onClick={() => { setSelectedRivalId(rival.id); setInspectorOpen(true); }}
              style={{ textAlign: 'left', font: 'inherit', cursor: 'pointer', background: LB.card, border: `1px solid ${rival.isMe ? LB.borderHi : LB.border}`, borderRadius: 14, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                  <RivalAvatar rival={rival} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <b style={{ fontSize: 15, fontWeight: 600, color: LB.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rival.displayName}</b>
                      {rival.isMe && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 600, letterSpacing: '0.08em', padding: '2px 6px', borderRadius: 4, border: `1px solid ${LB.amber}`, color: LB.amber }}>YOU</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 1 }}>
                      <span style={{ fontSize: 12, color: LB.muted }}>@{rival.username}</span>
                      <MovementBadge delta={movement} period={period} />
                    </div>
                  </div>
                </div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: trophyColor }}>#{i + 1}</span>
                  <Trophy size={18} color={trophyColor} strokeWidth={1.7} />
                </div>
              </div>
              <div style={{ marginTop: 15, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: LB.text }}>
                  <span style={{ color: LB.amber, fontSize: 10 }}>◆</span> {tierFor(rival, period)}
                </span>
                <span style={{ fontSize: 11.5, color: LB.muted }}>
                  {ahead ? `${formatMetricGap(gap, metric)} behind #${i}` : 'Board leader'}
                </span>
              </div>
              <div style={{ marginTop: 16, display: 'flex', gap: 26 }}>
                {podStat('Net P&L', formatCurrency(s.netPnl), s.netPnl > 0 ? LB.green : s.netPnl < 0 ? LB.red : LB.text)}
                {podStat('Win rate', `${Math.round(s.winRate)}%`)}
                {podStat('Avg R', avgRText(rival, period))}
              </div>
            </button>
          );
        })}
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
