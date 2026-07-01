import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell, BookOpen, Check, ChevronDown, Clock3, Flame,
  Gauge, LockKeyhole, MessageCircle, Plus, Search, Share2, ShieldCheck,
  TrendingDown, TrendingUp, Trophy, Users, X,
} from 'lucide-react';
import { useRivals } from '../hooks/useRivals.js';
import type { LeaderboardMetric, LeaderboardPeriod, Rival, RivalPeriodStats } from '../types/rivals.js';
import type { RivalRequestResponse, SharedTradeRecord } from '../services/api.js';
import { tradeSharesApi } from '../services/api.js';
import { useTrades } from '../hooks/useTrades.js';
import AddRivalModal from '../components/rivals/AddRivalModal.js';
import RivalChatPanel from '../components/rivals/RivalChatPanel.js';
import ScreenshotImportModal from '../components/scanner/ScreenshotImportModal.js';
import '../components/rivals/rivals.css';

type League = { id: string; name: string; memberIds: string[] };
type FormDot = { tone: 'win' | 'loss' | 'empty'; label: string };

const PERIODS: Array<{ value: LeaderboardPeriod; label: string }> = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'Last 30 days' },
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

function formatMetric(rival: Rival, metric: LeaderboardMetric, period: LeaderboardPeriod): string {
  const value = metricValue(rival, metric, period);
  return formatMetricValue(value, metric);
}

function formatMetricValue(value: number, metric: LeaderboardMetric): string {
  if (metric === 'netPnl') return formatCurrency(value);
  if (metric === 'riskAdjusted') return `${value.toFixed(2)}x`;
  if (metric === 'journalStreak') return `${Math.round(value)}d`;
  return `${Math.round(value)}`;
}

function formatMetricGap(value: number, metric: LeaderboardMetric): string {
  if (metric === 'netPnl') return formatCurrency(Math.max(0, value));
  if (metric === 'riskAdjusted') return `${Math.max(0, value).toFixed(2)}x`;
  if (metric === 'journalStreak') return `${Math.ceil(Math.max(0, value))} days`;
  return `${Math.ceil(Math.max(0, value))} points`;
}

function riskAdjustedGrade(value: number): string {
  if (value < 0) return 'Losing after drawdown';
  if (value < 1) return 'Below 1x: risk is not paying yet';
  if (value < 2) return '1x+: acceptable';
  if (value < 4) return '2x+: strong';
  return '4x+: elite';
}

function positionStripeColor(position: number, isMe: boolean | undefined): string {
  if (isMe) return 'var(--rv-blue)';
  if (position === 1) return 'var(--rv-gold)';
  if (position === 2) return 'var(--rv-silver)';
  if (position === 3) return 'var(--rv-bronze)';
  return 'var(--rv-text-3)';
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

function getSeasonProgress() {
  const now = new Date();
  const season = String(now.getMonth() + 1).padStart(2, '0');
  const day = Math.max(1, Math.min(90, now.getDate()));
  return { label: `SEASON ${season} · DAY ${day} / 90`, pct: Math.min(100, (day / 90) * 100) };
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
  const [query, setQuery] = useState('');
  const [selectedRivalId, setSelectedRivalId] = useState<string | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [activeChatRival, setActiveChatRival] = useState<Rival | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null);
  const [requestsOpen, setRequestsOpen] = useState(true);
  const [leagueBuilderOpen, setLeagueBuilderOpen] = useState(false);
  const [leagueName, setLeagueName] = useState('');
  const [leagueMembers, setLeagueMembers] = useState<string[]>([]);
  const [leagues, setLeagues] = useState<League[]>(() => {
    try { return JSON.parse(localStorage.getItem('flyxa-private-leagues') ?? '[]') as League[]; } catch { return []; }
  });
  const [activeLeagueId, setActiveLeagueId] = useState('all');
  const [inspectorTab, setInspectorTab] = useState<'overview' | 'progress' | 'ranks' | 'trades'>('overview');
  const [sharedTrades, setSharedTrades] = useState<SharedTradeRecord[]>([]);
  const [sharesLoading, setSharesLoading] = useState(false);
  const [viewingSharedTrade, setViewingSharedTrade] = useState<SharedTradeRecord | null>(null);
  const [sharePickerOpen, setSharePickerOpen] = useState(false);
  const [sharingBusy, setSharingBusy] = useState<string | null>(null);
  const [sharedSet, setSharedSet] = useState<Set<string>>(new Set());
  const prevRivalIdRef = useRef<string | null>(null);

  useEffect(() => {
    localStorage.setItem('flyxa-private-leagues', JSON.stringify(leagues));
  }, [leagues]);

  const currentUser = rivals.find(rival => rival.isMe) ?? rivals[0];
  const activeLeague = leagues.find(league => league.id === activeLeagueId);
  const leagueRivals = activeLeague
    ? rivals.filter(rival => rival.isMe || activeLeague.memberIds.includes(rival.id))
    : rivals;
  const ranked = useMemo(
    () => [...leagueRivals].sort((a, b) => metricValue(b, metric, period) - metricValue(a, metric, period)),
    [leagueRivals, metric, period],
  );
  const filtered = ranked.filter(rival => `${rival.displayName} ${rival.username}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedRival = rivals.find(rival => rival.id === selectedRivalId) ?? currentUser;
  const myRank = currentUser ? ranked.findIndex(rival => rival.id === currentUser.id) + 1 : 0;
  const nextRival = myRank > 1 ? ranked[myRank - 2] : null;
  const gapToNext = currentUser && nextRival
    ? metricValue(nextRival, metric, period) - metricValue(currentUser, metric, period)
    : 0;
  const seasonProgress = useMemo(() => getSeasonProgress(), []);
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

  async function handleRequestAction(id: string, action: 'accept' | 'decline' | 'cancel') {
    setRequestBusyId(id);
    try { await respondToRequest(id, action); } finally { setRequestBusyId(null); }
  }

  function createLeague() {
    const name = leagueName.trim();
    if (!name) return;
    const league: League = { id: `league-${Date.now()}`, name, memberIds: leagueMembers };
    setLeagues(current => [...current, league]);
    setActiveLeagueId(league.id);
    setLeagueName('');
    setLeagueMembers([]);
    setLeagueBuilderOpen(false);
  }

  return (
    <div className="rivals-page rv-competitive-page">
      <div className="rivals-shell rv-league-shell">
        <header className="rv-league-header" data-tour-id="rivals-header">
          <div>
            <div className="rv-page-kicker">RIVALS</div>
            <h1>Leaderboard</h1>
            <p>Compare verified P&L, consistency, and process with your trading circle.</p>
          </div>
          <div className="rv-header-actions">
            <button className="rv-secondary-button" type="button" onClick={() => setLeagueBuilderOpen(open => !open)}>
              <LockKeyhole size={14} /> Private league
            </button>
            <button className="rivals-cta" type="button" onClick={() => setIsAddOpen(true)}>
              <Plus size={14} /> Add rival
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

        <nav className="rv-league-tabs">
          <button className={activeLeagueId === 'all' ? 'active' : ''} onClick={() => setActiveLeagueId('all')}><Users size={13} /> All rivals</button>
          {leagues.map(league => <button key={league.id} className={activeLeagueId === league.id ? 'active' : ''} onClick={() => setActiveLeagueId(league.id)}><LockKeyhole size={12} /> {league.name}</button>)}
        </nav>

        <section className="rv-command-bar" data-tour-id="rivals-controls">
          <div className="rv-command-selects">
            <div className="rv-metric-tabs">
              {MODES.map(mode => <button type="button" key={mode.value} title={mode.help} className={metric === mode.value ? 'active' : ''} onClick={() => setMetric(mode.value)}>{mode.label}</button>)}
            </div>
            <div className="rv-period-tabs">
              {PERIODS.map(item => <button type="button" key={item.value} className={period === item.value ? 'active' : ''} onClick={() => setPeriod(item.value)}>{item.label}</button>)}
            </div>
          </div>
          <div className="rv-command-tools">
            <label><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search traders" /></label>
          </div>
        </section>

        <section className="rv-summary-bar" data-tour-id="rivals-summary">
          <div className="rv-summary-identity">
            <RivalAvatar rival={currentUser} />
            <div><span>Your standing</span><strong>#{myRank || '—'} of {ranked.length}</strong></div>
          </div>
          <div className="rv-season-progress">
            <span>{seasonProgress.label}</span>
            <i><u style={{ width: `${seasonProgress.pct}%` }} /></i>
          </div>
          <div className="rv-summary-metric">
            <span>{MODES.find(mode => mode.value === metric)?.label}</span>
            <AnimatedMetric rival={currentUser} metric={metric} period={period} className={metricValue(currentUser, metric, period) >= 0 ? 'positive' : 'negative'} />
            {metric === 'riskAdjusted' && (
              <small className="rv-risk-inline-key">
                <span>{riskAdjustedGrade(metricValue(currentUser, metric, period))}</span>
                <i title="Risk adjusted = net P&L / max drawdown"><b>1x</b><b>2x</b><b>4x+</b></i>
              </small>
            )}
          </div>
          <div className="rv-summary-context">
            {myRank === 1 ? (
              <span className="rv-leading-badge"><Trophy size={12} /><span>Leading this board</span></span>
            ) : (
              <>
                <span className="rv-summary-gap">{formatMetricGap(gapToNext, metric)}</span>
                <span>to rank</span>
                <span className="rv-summary-rank-target">#{Math.max(1, myRank - 1)}</span>
              </>
            )}
          </div>
        </section>

        <div className="rv-competition-layout">
          <main className="rv-ranking-card" data-tour-id="rivals-standings">
            <div className="rv-ranking-title"><div><h2>{activeLeague?.name ?? 'Standings'}</h2><p>Updated from saved journal trades</p></div><span className="rv-live-indicator"><i /> Live</span></div>
            <div className="rv-card-grid">
              {filtered.map((rival) => {
                const stats = getPeriodStats(rival, period);
                const movement = rankMovement(rival, leagueRivals, metric, period);
                const position = ranked.findIndex(item => item.id === rival.id) + 1;
                const stripeColor = positionStripeColor(position, rival.isMe);
                const isSelected = selectedRival.id === rival.id;
                const formDots = getFormDots(rival);
                const rivalValue = metricValue(rival, metric, period);
                const ahead = position > 1 ? ranked[position - 2] : null;
                const gapToAhead = ahead ? Math.max(0, metricValue(ahead, metric, period) - rivalValue) : 0;
                return (
                  <button
                    key={rival.id}
                    type="button"
                    aria-pressed={isSelected}
                    className={['rv-rival-card', rival.isMe ? 'me' : '', isSelected ? 'selected' : '', movement !== 0 ? 'rank-flash' : ''].filter(Boolean).join(' ')}
                    style={{ '--rv-card-tier-color': stripeColor } as React.CSSProperties}
                    onClick={() => setSelectedRivalId(rival.id)}
                  >
                    <div className="rv-card-rank">
                      <span className="rv-card-pos">#{position}</span>
                    </div>
                    <RivalAvatar rival={rival} />
                    <div className="rv-card-identity">
                      <strong>{rival.displayName}{rival.isMe && <em>You</em>}</strong>
                      <small>@{rival.username}</small>
                      {rival.isMe && <span className="rv-card-coach">{coachingInsight(rival, period)}</span>}
                    </div>
                    <div className="rv-form-dots" aria-label="Last 5 market days. Green means winning day, red means losing day, hollow means no trades." title="Last 5 market days: green = winning day, red = losing day, hollow = no trades.">
                      {formDots.map((dot, index) => <span key={`${rival.id}-${index}-${dot.tone}`} className={`rv-form-dot ${dot.tone}`} title={dot.label} />)}
                    </div>
                    <span className="rv-card-volume" title={`Trades in ${selectedPeriodLabel}`}>
                      <b>{stats.tradeCount}</b> trade{stats.tradeCount === 1 ? '' : 's'}
                    </span>
                    <div className="rv-card-stats">
                      <div className="rv-card-stat">
                        <span>Win</span>
                        <strong>{stats.winRate}%</strong>
                      </div>
                      <div className="rv-card-stat">
                        <span>Avg R</span>
                        <strong>{stats.avgR == null ? '—' : `${stats.avgR.toFixed(2)}R`}</strong>
                      </div>
                      <div className="rv-card-stat">
                        <span>Consist.</span>
                        <strong>{stats.consistency}</strong>
                        <i className="rv-card-stat-bar"><u style={{ width: `${stats.consistency}%` }} /></i>
                      </div>
                    </div>
                    <div className="rv-card-pnl">
                      <AnimatedMetric rival={rival} metric={metric} period={period} className={rivalValue >= 0 ? 'positive' : 'negative'} />
                      <small className="rv-row-hover-meta">{ahead ? `${formatMetricGap(gapToAhead, metric)} behind #${position - 1}` : 'View profile'}</small>
                      <span className={`rv-movement ${movement > 0 ? 'up' : movement < 0 ? 'down' : ''}`}>
                        {movement > 0 ? <><TrendingUp size={11} />{movement}</> : movement < 0 ? <><TrendingDown size={11} />{Math.abs(movement)}</> : <span className="rv-card-neutral">—</span>}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </main>

          <aside className="rv-competitive-rail" data-tour-id="rivals-detail">
            <section className="rv-trader-insight">
              <div className="rv-insight-head"><RivalAvatar rival={selectedRival} large /><div><h3>{selectedRival.displayName}</h3><small>@{selectedRival.username}</small></div>{!selectedRival.isMe && selectedRival.userId && <button aria-label={`Message ${selectedRival.displayName}`} onClick={() => { setActiveChatRival(selectedRival); setChatOpen(true); }}><MessageCircle size={14} /></button>}</div>
              <div className="rv-inspector-tabs">
                <button type="button" className={inspectorTab === 'overview' ? 'active' : ''} onClick={() => setInspectorTab('overview')}>Overview</button>
                <button type="button" className={inspectorTab === 'progress' ? 'active' : ''} onClick={() => setInspectorTab('progress')}>Progress</button>
                <button type="button" className={inspectorTab === 'ranks' ? 'active' : ''} onClick={() => setInspectorTab('ranks')}>Ranks</button>
                <button type="button" className={inspectorTab === 'trades' ? 'active' : ''} onClick={() => setInspectorTab('trades')}>Trades</button>
              </div>
              {inspectorTab === 'overview' ? (
                <>
                  <div className="rv-inspector-meta">
                    <span>Rank #{ranked.findIndex(rival => rival.id === selectedRival.id) + 1} of {ranked.length}</span>
                  </div>
                  <div className="rv-insight-equity"><div><span>{PERIODS.find(item => item.value === period)?.label} equity</span><strong className={selectedStats.netPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(selectedStats.netPnl)}</strong></div><Sparkline values={selectedStats.equityCurve} large /></div>
                  <div className="rv-insight-kpis">
                    <Stat label="Trades" value={String(selectedStats.tradeCount)} />
                    <Stat label="Trading days" value={String(selectedStats.tradingDays)} />
                    <Stat label="Win rate" value={`${selectedStats.winRate}%`} />
                    <Stat label="Consistency" value={`${selectedStats.consistency}/100`} />
                  </div>
                  <p className="rv-trader-note">{selectedStats.consistency >= 75 ? 'High consistency with controlled downside.' : selectedStats.netPnl > 0 ? 'Profitable, with room to tighten consistency.' : 'Process metrics are the clearest route back up the table.'}</p>
                </>
              ) : inspectorTab === 'progress' ? (
                <div className="rv-inspector-progress">
                  <div className="rv-inspector-section-head"><h4>Weekly habits</h4><span>Resets Monday</span></div>
                  <Challenge icon={<BookOpen size={14} />} title="Document every trade" value={selectedRival.mascot.stats.tradingJournalScore} target={100} suffix="%" />
                  <Challenge icon={<ShieldCheck size={14} />} title="Verified + reported adherence" value={getPeriodStats(selectedRival, 'week').ruleAdherence} target={100} suffix="%" />
                  <Challenge icon={<Flame size={14} />} title="Build a green streak" value={getPeriodStats(selectedRival, 'week').greenDays} target={5} suffix="/5" />
                  <div className="rv-inspector-section-head rv-milestone-head"><h4>Milestones</h4><span>Verified data</span></div>
                  <div className="rv-achievement-list">
                    <Badge unlocked={selectedStats.greenDays >= 5} icon={<TrendingUp size={14} />} title="Five green days" />
                    <Badge unlocked={selectedStats.ruleAdherence >= 90} icon={<ShieldCheck size={14} />} title="90% rule adherence" />
                    <Badge unlocked={selectedStats.maxDrawdown <= Math.max(100, Math.abs(selectedStats.netPnl) * .3)} icon={<Gauge size={14} />} title="Controlled drawdown" />
                    <Badge unlocked={selectedStats.tradeCount >= 10} icon={<BookOpen size={14} />} title="10 documented trades" />
                  </div>
                </div>
              ) : inspectorTab === 'ranks' ? (
                <div className="rv-inspector-progress">
                  <div className="rv-inspector-section-head"><h4>Milestone achievements</h4><span>Verified data</span></div>
                  <div className="rv-achievement-list">
                    <Badge unlocked={selectedStats.greenDays >= 5} icon={<TrendingUp size={14} />} title="Five green days" />
                    <Badge unlocked={selectedStats.ruleAdherence >= 90} icon={<ShieldCheck size={14} />} title="90% rule adherence" />
                    <Badge unlocked={selectedStats.maxDrawdown <= Math.max(100, Math.abs(selectedStats.netPnl) * .3)} icon={<Gauge size={14} />} title="Controlled drawdown" />
                    <Badge unlocked={selectedStats.tradeCount >= 10} icon={<BookOpen size={14} />} title="10 documented trades" />
                    <Badge unlocked={selectedStats.winRate >= 60} icon={<Trophy size={14} />} title="60% win rate" />
                    <Badge unlocked={selectedStats.consistency >= 75} icon={<ShieldCheck size={14} />} title="75 consistency score" />
                  </div>
                </div>
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
            </section>
          </aside>
        </div>
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

function Sparkline({ values, compact = false, large = false, ambient = false }: { values: number[]; compact?: boolean; large?: boolean; ambient?: boolean }) {
  const pts = values.length > 1 ? values : [0, values[0] ?? 0];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const range = Math.max(1, max - min);
  const W = large ? 260 : compact ? 76 : 120;
  const H = large ? 62 : compact ? 28 : 40;
  const PAD = 3;
  const xOf = (i: number) => (i / Math.max(1, pts.length - 1)) * (W - PAD * 2) + PAD;
  const yOf = (v: number) => H - PAD - ((v - min) / range) * (H - PAD * 2);
  const linePts = pts.map((v, i) => `${xOf(i)},${yOf(v)}`).join(' ');
  const areaPts = [`${PAD},${H}`, ...pts.map((v, i) => `${xOf(i)},${yOf(v)}`), `${W - PAD},${H}`].join(' ');
  const positive = pts[pts.length - 1] >= pts[0];
  const color = positive ? '#34d399' : '#f87171';
  const fillId = `rv-spk-fill-${React.useId().replace(/:/g, '')}`;
  return (
    <svg className={`rv-sparkline ${large ? 'large' : ''} ${ambient ? 'ambient' : ''}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={areaPts} fill={`url(#${fillId})`} />
      <polyline className="rv-sparkline-path" points={linePts} fill="none" stroke={color} strokeWidth={ambient ? 2.2 : large ? 1.5 : 1.2} vectorEffect="non-scaling-stroke" pathLength={1} />
    </svg>
  );
}

function AnimatedMetric({ rival, metric, period, className }: { rival: Rival; metric: LeaderboardMetric; period: LeaderboardPeriod; className?: string }) {
  const target = metricValue(rival, metric, period);
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    let frame = 0;
    const start = performance.now();
    const duration = 420;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(target * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);

  return <strong className={className}>{formatMetricValue(displayValue, metric)}</strong>;
}

function RivalAvatar({ rival, large = false }: { rival: Rival; large?: boolean }) {
  return <span className={`rv-leader-avatar ${large ? 'large' : ''}`} style={{ color: rival.avatarColor, borderColor: `${rival.avatarColor}66`, background: `${rival.avatarColor}18` }}>{rival.avatarUrl ? <img src={rival.avatarUrl} alt="" /> : rival.avatarInitials}</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Challenge({ icon, title, value, target, suffix }: { icon: React.ReactNode; title: string; value: number; target: number; suffix: string }) {
  const progress = Math.max(0, Math.min(100, (value / target) * 100));
  return <div className="rv-challenge"><span className="rv-challenge-icon">{icon}</span><div><strong>{title}</strong><i><u style={{ width: `${progress}%` }} /></i></div><b>{Math.min(value, target)}{suffix}</b></div>;
}

function Badge({ unlocked, icon, title }: { unlocked: boolean; icon: React.ReactNode; title: string }) {
  return <div className={unlocked ? 'unlocked' : ''}><span>{icon}</span><strong>{title}</strong>{unlocked ? <Check size={12} /> : <LockKeyhole size={11} />}</div>;
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
