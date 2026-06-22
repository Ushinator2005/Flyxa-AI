import { useEffect, useMemo, useState } from 'react';
import {
  Bell, BookOpen, Check, ChevronDown, Clock3, Flame,
  Gauge, LockKeyhole, MessageCircle, Plus, Search, ShieldCheck,
  TrendingDown, TrendingUp, Trophy, Users, X,
} from 'lucide-react';
import { useRivals } from '../hooks/useRivals.js';
import type { LeaderboardMetric, LeaderboardPeriod, Rival, RivalPeriodStats } from '../types/rivals.js';
import type { RivalRequestResponse } from '../services/api.js';
import AddRivalModal from '../components/rivals/AddRivalModal.js';
import RivalChatPanel from '../components/rivals/RivalChatPanel.js';
import RankMedallion, { getRankFromXP, getXPProgress, RANK_LABELS, RANK_COLORS } from '../components/rivals/RankMedallion.js';
import '../components/rivals/rivals.css';

type League = { id: string; name: string; memberIds: string[] };

const PERIODS: Array<{ value: LeaderboardPeriod; label: string }> = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'season', label: 'Season' },
  { value: 'allTime', label: 'All time' },
];

const MODES: Array<{ value: LeaderboardMetric; label: string }> = [
  { value: 'netPnl', label: 'Net P&L' },
  { value: 'consistency', label: 'Consistency' },
  { value: 'riskAdjusted', label: 'Risk adjusted' },
  { value: 'processScore', label: 'Process' },
  { value: 'journalStreak', label: 'Journal streak' },
];

const EMPTY_PERIOD: RivalPeriodStats = {
  netPnl: 0, winRate: 0, tradeCount: 0, tradingDays: 0, greenDays: 0,
  maxDrawdown: 0, consistency: 0, ruleAdherence: 0, riskAdjusted: 0, equityCurve: [],
};

function formatCurrency(value: number): string {
  const amount = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value > 0 ? `+$${amount}` : value < 0 ? `-$${amount}` : '$0';
}

function getPeriodStats(rival: Rival, period: LeaderboardPeriod): RivalPeriodStats {
  const saved = rival.mascot.stats.periods?.[period];
  if (saved) return saved;
  return {
    ...EMPTY_PERIOD,
    netPnl: rival.mascot.stats.netPnl ?? 0,
    winRate: rival.mascot.stats.winRate ?? 0,
    consistency: rival.mascot.stats.processScore,
  };
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
  if (metric === 'netPnl') return formatCurrency(value);
  if (metric === 'riskAdjusted') return `${value.toFixed(2)}x`;
  if (metric === 'journalStreak') return `${value}d`;
  return `${Math.round(value)}`;
}

function formatMetricGap(value: number, metric: LeaderboardMetric): string {
  if (metric === 'netPnl') return formatCurrency(Math.max(0, value));
  if (metric === 'riskAdjusted') return `${Math.max(0, value).toFixed(2)}x`;
  if (metric === 'journalStreak') return `${Math.ceil(Math.max(0, value))} days`;
  return `${Math.ceil(Math.max(0, value))} points`;
}

function rivalXP(rival: Rival): number {
  const s = rival.mascot.stats;
  return s.dailyJournalStreak * 2 + s.dailyJournalScore + s.tradingJournalScore + s.processScore + (s.backtestSessions ?? 0) * 2;
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

export default function Rivals() {
  const { rivals, addRival, rivalRequests, respondToRequest, profile } = useRivals();
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
  const [inspectorTab, setInspectorTab] = useState<'overview' | 'progress'>('overview');

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
  const pendingRequests = rivalRequests.filter(request => request.status === 'pending');

  if (!currentUser || !selectedRival) return null;

  const selectedStats = getPeriodStats(selectedRival, period);
  const selectedXP = rivalXP(selectedRival);
  const selectedRankTier = getRankFromXP(selectedXP);
  const myXP = rivalXP(currentUser);
  const myXPProgress = getXPProgress(myXP);
  const myRankTier = myXPProgress.rank;

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
        <header className="rv-league-header">
          <div>
            <div className="rv-page-kicker">RIVALS / SEASON {String(new Date().getMonth() + 1).padStart(2, '0')}</div>
            <h1>Trading league</h1>
            <p>Compete on profitability, discipline and repeatable execution.</p>
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

        <section className="rv-command-bar">
          <div className="rv-command-selects">
            <label className="rv-control-field">
              <span>Rank by</span>
              <select value={metric} onChange={event => setMetric(event.target.value as LeaderboardMetric)}>
                {MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
              </select>
            </label>
            <div className="rv-period-tabs">
              {PERIODS.map(item => <button type="button" key={item.value} className={period === item.value ? 'active' : ''} onClick={() => setPeriod(item.value)}>{item.label}</button>)}
            </div>
          </div>
          <div className="rv-command-tools">
            <label><Search size={13} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search traders" /></label>
          </div>
        </section>

        <section className="rv-summary-bar">
          <div className="rv-summary-identity">
            <RivalAvatar rival={currentUser} />
            <div><span>Your standing</span><strong>#{myRank || '—'} of {ranked.length}</strong></div>
          </div>
          <div className="rv-summary-metric">
            <span>{MODES.find(mode => mode.value === metric)?.label}</span>
            <strong className={metricValue(currentUser, metric, period) >= 0 ? 'positive' : 'negative'}>{formatMetric(currentUser, metric, period)}</strong>
          </div>
          <div className="rv-summary-context">
            {myRank === 1 ? <><Trophy size={14} /> Leading this board</> : <>{formatMetricGap(gapToNext, metric)} to rank #{Math.max(1, myRank - 1)}</>}
          </div>
          <div className="rv-summary-division">
            <RankMedallion rank={myRankTier} size={38} />
            <div><span style={{ color: RANK_COLORS[myRankTier] }}>{RANK_LABELS[myRankTier]} rank</span><small>{myXP} XP{myXPProgress.next ? ` · ${myXPProgress.xpToNext} to ${RANK_LABELS[myXPProgress.next]}` : ' · Max rank'}</small></div>
            <i><u style={{ width: `${myXPProgress.pct}%` }} /></i>
          </div>
          <Sparkline values={getPeriodStats(currentUser, period).equityCurve} />
        </section>

        <div className="rv-competition-layout">
          <main className="rv-ranking-card">
            <div className="rv-ranking-title"><div><h2>{activeLeague?.name ?? 'Standings'}</h2><p>Updated from saved journal trades</p></div><span className="rv-live-indicator"><i /> Live</span></div>
            <div className="rv-pro-table">
              <div className="rv-pro-head"><span>Rank</span><span>Trader / equity</span><span>Net P&L</span><span>Win rate</span><span>Avg R</span><span>Consistency</span><span>Move</span></div>
              {filtered.map((rival) => {
                const stats = getPeriodStats(rival, period);
                const movement = rankMovement(rival, leagueRivals, metric, period);
                return (
                  <button key={rival.id} type="button" aria-pressed={selectedRival.id === rival.id} className={`rv-pro-row ${rival.isMe ? 'me' : ''} ${selectedRival.id === rival.id ? 'selected' : ''}`} onClick={() => setSelectedRivalId(rival.id)}>
                    <span className="rv-pro-rank"><RankMedallion rank={getRankFromXP(rivalXP(rival))} size={20} />{String(ranked.findIndex(item => item.id === rival.id) + 1).padStart(2, '0')}</span>
                    <span className="rv-pro-trader"><RivalAvatar rival={rival} /><span><strong>{rival.displayName}{rival.isMe && <em>You</em>}</strong><small>@{rival.username}</small></span><Sparkline values={stats.equityCurve} compact /></span>
                    <span className={stats.netPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(stats.netPnl)}</span>
                    <span>{stats.winRate}%</span>
                    <span>{rival.mascot.stats.avgR == null ? '—' : `${rival.mascot.stats.avgR.toFixed(2)}R`}</span>
                    <span><div className="rv-consistency-cell"><b>{stats.consistency}</b><i><u style={{ width: `${stats.consistency}%` }} /></i></div></span>
                    <span className={`rv-movement ${movement > 0 ? 'up' : movement < 0 ? 'down' : ''}`}>{movement > 0 ? <><TrendingUp size={12} />{movement}</> : movement < 0 ? <><TrendingDown size={12} />{Math.abs(movement)}</> : '—'}</span>
                  </button>
                );
              })}
            </div>
          </main>

          <aside className="rv-competitive-rail">
            <section className="rv-trader-insight">
              <div className="rv-insight-head"><RivalAvatar rival={selectedRival} large /><div><h3>{selectedRival.displayName}</h3><small>@{selectedRival.username}</small></div>{!selectedRival.isMe && selectedRival.userId && <button aria-label={`Message ${selectedRival.displayName}`} onClick={() => { setActiveChatRival(selectedRival); setChatOpen(true); }}><MessageCircle size={14} /></button>}</div>
              <div className="rv-inspector-tabs">
                <button type="button" className={inspectorTab === 'overview' ? 'active' : ''} onClick={() => setInspectorTab('overview')}>Overview</button>
                <button type="button" className={inspectorTab === 'progress' ? 'active' : ''} onClick={() => setInspectorTab('progress')}>Progress</button>
              </div>
              {inspectorTab === 'overview' ? (
                <>
                  <div className="rv-inspector-meta">
                    <div className="rv-division-badge"><RankMedallion rank={selectedRankTier} size={24} /><span style={{ color: RANK_COLORS[selectedRankTier] }}>{RANK_LABELS[selectedRankTier]}</span></div>
                    <span>Rank #{ranked.findIndex(rival => rival.id === selectedRival.id) + 1}</span>
                  </div>
                  <div className="rv-insight-equity"><div><span>{PERIODS.find(item => item.value === period)?.label} equity</span><strong className={selectedStats.netPnl >= 0 ? 'positive' : 'negative'}>{formatCurrency(selectedStats.netPnl)}</strong></div><Sparkline values={selectedStats.equityCurve} large /></div>
                  <div className="rv-insight-kpis">
                    <Stat label="Trading days" value={String(selectedStats.tradingDays)} />
                    <Stat label="Win rate" value={`${selectedStats.winRate}%`} />
                    <Stat label="Max drawdown" value={formatCurrency(-selectedStats.maxDrawdown)} />
                    <Stat label="Consistency" value={`${selectedStats.consistency}/100`} />
                  </div>
                  <p className="rv-trader-note">{selectedStats.consistency >= 75 ? 'High consistency with controlled downside.' : selectedStats.netPnl > 0 ? 'Profitable, with room to tighten consistency.' : 'Process metrics are the clearest route back up the table.'}</p>
                </>
              ) : (
                <div className="rv-inspector-progress">
                  <div className="rv-inspector-section-head"><h4>Weekly habits</h4><span>Resets Monday</span></div>
                  <Challenge icon={<BookOpen size={14} />} title="Document every trade" value={selectedRival.mascot.stats.tradingJournalScore} target={100} suffix="%" />
                  <Challenge icon={<ShieldCheck size={14} />} title="Respect the plan" value={getPeriodStats(selectedRival, 'week').ruleAdherence} target={100} suffix="%" />
                  <Challenge icon={<Flame size={14} />} title="Build a green streak" value={getPeriodStats(selectedRival, 'week').greenDays} target={5} suffix="/5" />
                  <div className="rv-inspector-section-head rv-milestone-head"><h4>Milestones</h4><span>Verified data</span></div>
                  <div className="rv-achievement-list">
                    <Badge unlocked={selectedStats.greenDays >= 5} icon={<TrendingUp size={14} />} title="Five green days" />
                    <Badge unlocked={selectedStats.ruleAdherence >= 90} icon={<ShieldCheck size={14} />} title="No rule breaks" />
                    <Badge unlocked={selectedStats.maxDrawdown <= Math.max(100, Math.abs(selectedStats.netPnl) * .3)} icon={<Gauge size={14} />} title="Controlled drawdown" />
                    <Badge unlocked={selectedStats.tradeCount >= 10} icon={<BookOpen size={14} />} title="10 documented trades" />
                  </div>
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>

      <AddRivalModal open={isAddOpen} onClose={() => setIsAddOpen(false)} onSubmit={username => addRival(username)} />
      <RivalChatPanel open={chatOpen} rival={activeChatRival} myUserId={profile?.userId ?? null} onClose={() => setChatOpen(false)} />
    </div>
  );
}

function Sparkline({ values, compact = false, large = false }: { values: number[]; compact?: boolean; large?: boolean }) {
  const points = values.length > 1 ? values : [0, values[0] ?? 0];
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = Math.max(1, max - min);
  const width = large ? 260 : compact ? 76 : 120;
  const height = large ? 62 : compact ? 28 : 40;
  const path = points.map((value, index) => `${(index / Math.max(1, points.length - 1)) * width},${height - ((value - min) / range) * (height - 4) - 2}`).join(' ');
  const positive = points[points.length - 1] >= points[0];
  return <svg className={`rv-sparkline ${large ? 'large' : ''}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><polyline points={path} fill="none" stroke={positive ? '#34d399' : '#f87171'} strokeWidth={large ? 2 : 1.5} vectorEffect="non-scaling-stroke" /></svg>;
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
