import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, Check, ChevronDown, Clock3, LockKeyhole,
  MessageCircle, Plus, Share2, X,
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
type FormDot = { tone: 'win' | 'loss' | 'empty'; label: string };

const PERIODS: Array<{ value: LeaderboardPeriod; label: string }> = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: '30 days' },
  { value: 'season', label: 'Season' },
  { value: 'allTime', label: 'All time' },
];

const MODES: Array<{ value: LeaderboardMetric; label: string; help?: string }> = [
  { value: 'netPnl', label: 'Net P&L' },
  { value: 'consistency', label: 'Consistency' },
  { value: 'riskAdjusted', label: 'Risk adjusted', help: 'Net P&L divided by max drawdown. 1x is okay, 2x is strong, 4x+ is elite.' },
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

function formatMetricValue(value: number, metric: LeaderboardMetric): string {
  if (metric === 'netPnl') return formatCurrency(value);
  if (metric === 'riskAdjusted') return `${value.toFixed(2)}x`;
  if (metric === 'journalStreak') return `${Math.round(value)}d`;
  return `${Math.round(value)}`;
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

function dateToLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isMarketDay(date: Date): boolean {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function recentMarketDates(): string[] {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const dates: string[] = [];
  const cursor = new Date(now);
  while (dates.length < 5) {
    if (isMarketDay(cursor)) dates.push(dateToLocalIso(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }

  return dates.reverse();
}

function getFormDots(rival: Rival): FormDot[] {
  const stats = getPeriodStats(rival, 'allTime');
  const byDate = new Map((stats.dailyPnl ?? []).map(day => [day.date, day.pnl]));
  return recentMarketDates().map((date) => {
    const pnl = byDate.get(date);
    if (pnl === undefined) return { tone: 'empty', label: `${date}: no trades` };
    if (pnl > 0) return { tone: 'win', label: `${date}: winning day ${formatCurrency(pnl)}` };
    if (pnl < 0) return { tone: 'loss', label: `${date}: losing day ${formatCurrency(pnl)}` };
    return { tone: 'empty', label: `${date}: breakeven day` };
  });
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

  return (
    <div className="rv2-page">

      {/* ── Header ── */}
      <header className="rv2-hd" data-tour-id="rivals-header">
        <div>
          <h1>Leaderboard</h1>
          <p>Compare verified P&amp;L, consistency, and process with your trading circle.</p>
        </div>
        <div className="rv2-acts">
          <button className="rv2-btn" type="button" onClick={() => setLeagueBuilderOpen(open => !open)}>
            <LockKeyhole size={13} /> Private league
          </button>
          <button className="rv2-btn primary" type="button" onClick={() => setIsAddOpen(true)}>
            <Plus size={13} /> Add rival
          </button>
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

      {/* ── Controls: one row, no nested bars ── */}
      <div className="rv2-ctl" data-tour-id="rivals-controls">
        <div className="rv2-ctl-grp">
          <span className="rv2-lbl">Rank by</span>
          <div className="rv2-seg">
            {MODES.map(mode => (
              <button type="button" key={mode.value} title={mode.help} className={metric === mode.value ? 'on' : ''} onClick={() => setMetric(mode.value)}>
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rv2-ctl-grp">
          {leagues.length > 0 && (
            <div className="rv2-seg">
              <button type="button" className={activeLeagueId === 'all' ? 'on' : ''} onClick={() => setActiveLeagueId('all')}>All rivals</button>
              {leagues.map(league => (
                <button key={league.id} type="button" className={activeLeagueId === league.id ? 'on' : ''} onClick={() => setActiveLeagueId(league.id)}>{league.name}</button>
              ))}
            </div>
          )}
          <div className="rv2-seg">
            {PERIODS.map(item => (
              <button type="button" key={item.value} className={period === item.value ? 'on' : ''} onClick={() => setPeriod(item.value)}>{item.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Standings table + selected trader rail ── */}
      <div className="rv2-grid">
        <div className="rv2-tbl" data-tour-id="rivals-standings">
          <div className="rv2-tbl-hd">
            <b>{activeLeague?.name ?? 'Standings'}</b>
          </div>
          <div className="rv2-thead" aria-hidden="true">
            <span>#</span><span>Trader</span><span>Last 5</span>
            <span className="r">Trades</span><span className="r">Win</span><span className="r">Avg R</span>
            <span className="r">Consist</span><span className="r">{metricLabel}</span>
          </div>
          {ranked.map((rival, index) => {
            const stats = getPeriodStats(rival, period);
            const position = index + 1;
            const isSelected = selectedRival.id === rival.id;
            const formDots = getFormDots(rival);
            const rivalValue = metricValue(rival, metric, period);
            return (
              <button
                key={rival.id}
                type="button"
                aria-pressed={isSelected}
                className={['rv2-trow', rival.isMe ? 'you' : '', isSelected ? 'sel' : ''].filter(Boolean).join(' ')}
                onClick={() => setSelectedRivalId(rival.id)}
              >
                <span className={`rv2-rank${position === 1 ? ' first' : ''}`}>{position}</span>
                <div className="rv2-who">
                  <RivalAvatar rival={rival} />
                  <div className="rv2-nm">
                    <b>{rival.displayName}</b>
                    <span>@{rival.username}</span>
                  </div>
                  {rival.isMe && <span className="rv2-yt">YOU</span>}
                </div>
                <div className="rv2-l5" title="Last 5 market days: green = winning day, red = losing day, hollow = no trades.">
                  {formDots.map((dot, dotIndex) => <i key={`${rival.id}-${dotIndex}`} className={dot.tone === 'win' ? 'w' : dot.tone === 'loss' ? 'l' : ''} title={dot.label} />)}
                </div>
                <span className="rv2-num r">{stats.tradeCount}</span>
                <span className="rv2-num r">{stats.winRate}%</span>
                <span className="rv2-num r">{stats.avgR == null ? '—' : `${stats.avgR.toFixed(2)}R`}</span>
                <div className="rv2-consist">
                  <span className="rv2-cb"><i style={{ width: `${Math.max(0, Math.min(100, stats.consistency))}%` }} /></span>
                  <span className="rv2-num">{stats.consistency}</span>
                </div>
                <span className={`rv2-pnl${metric === 'netPnl' ? (rivalValue > 0 ? ' pos' : rivalValue < 0 ? ' neg' : '') : ''}`}>
                  {formatMetricValue(rivalValue, metric)}
                </span>
              </button>
            );
          })}
          <button type="button" className="rv2-add-row" onClick={() => setIsAddOpen(true)}>
            <Plus size={12} /> Add a rival to the board
          </button>
        </div>

        {/* ── Right rail: the selected trader, made actionable ── */}
        <aside className="rv2-me" data-tour-id="rivals-detail">
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
