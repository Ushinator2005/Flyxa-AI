import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Bell, Check, ChevronDown, Clock3,
  MessageCircle, Plus, Users, X,
} from 'lucide-react';
import { useRivals } from '../hooks/useRivals.js';
import type { LeaderboardMetric, LeaderboardPeriod, Rival, RivalPeriodStats } from '../types/rivals.js';
import type { RivalRequestResponse } from '../services/api.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { PrivateLeague } from '../store/types.js';
import AddRivalModal from '../components/rivals/AddRivalModal.js';
import RivalChatPanel from '../components/rivals/RivalChatPanel.js';
import '../components/rivals/rivals.css';

type League = PrivateLeague;

const PERIODS: Array<{ value: LeaderboardPeriod; label: string }> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
  { value: 'allTime', label: 'All time' },
];

const MODES: Array<{ value: LeaderboardMetric; label: string; help?: string }> = [
  { value: 'netPnl', label: 'Net P&L' },
  { value: 'avgR', label: 'Avg R' },
  { value: 'winRate', label: 'Win rate' },
  { value: 'processScore', label: 'Process' },
];

// Rules-held (process) colour bands: >=70 green, 50-69 amber, <50 red. Three
// bands so a healthy board is not a christmas tree.
const procColor = (v: number) => (v >= 70 ? 'var(--green)' : v >= 50 ? 'var(--amber)' : 'var(--red)');
const procBand = (v: number) => (v >= 70 ? 'g' : v >= 50 ? 'a' : 'r_');

// Head-to-head delta: a signed figure whose sign drives colour. `kind` sets the
// unit (money / R / points). No em dashes: uses a minus sign for negatives.
function h2hDelta(kind: 'money' | 'r' | 'pts', delta: number): { txt: string; up: boolean } {
  const up = delta >= 0;
  const sign = up ? '+' : '−';
  const txt = kind === 'money'
    ? `${sign}$${Math.abs(Math.round(delta)).toLocaleString('en-US')}`
    : kind === 'r'
      ? `${sign}${Math.abs(delta).toFixed(2)}`
      : `${sign}${Math.abs(Math.round(delta))}`;
  return { txt, up };
}

// Capitalise the first letter of a handle for display (curry -> Curry), so the
// board reads professionally. Applied once to the rivals list, not the stored
// username (which stays as-is for matching).
const capName = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const ordinal = (n: number): string => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

// Natural-language phrase for a period, e.g. "today", "this month".
const periodPhrase = (p: LeaderboardPeriod): string => ({
  day: 'today', week: 'this week', month: 'this month',
  quarter: 'this quarter', year: 'this year', allTime: 'all time',
}[p]);

// Cumulative-R trajectory: the rival's curve (solid amber) over the viewer's
// (dashed grey). Shape comes from each period's equity curve; the endpoint R is
// the checkable figure shown in the legend. One line only in solo mode.
function RivalCurve({ them, me, solo }: { them: number[]; me: number[]; solo: boolean }) {
  const W = 420, H = 130, X0 = 10, X1 = 410, Y0 = 12, Y1 = 108;
  const all = [...them, ...(solo ? [] : me), 0];
  const lo = Math.min(...all), hi = Math.max(...all);
  const span = hi - lo || 1;
  const pts = (s: number[]) => (s.length < 2 ? '' : s.map((v, i) =>
    `${(X0 + (i / (s.length - 1)) * (X1 - X0)).toFixed(0)},${(Y1 - ((v - lo) / span) * (Y1 - Y0)).toFixed(0)}`).join(' '));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rvd-crv" aria-hidden="true">
      <line x1={X0} y1={Y1} x2={X1} y2={Y1} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />
      {!solo && me.length >= 2 && (
        <polyline fill="none" stroke="var(--app-text-muted)" strokeWidth="1.75" strokeDasharray="4 4" strokeLinejoin="round" points={pts(me)} />
      )}
      {them.length >= 2 && (
        <polyline fill="none" stroke="var(--amber)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" points={pts(them)} />
      )}
      <text x={X0} y={126} fontSize="10.5" fill="var(--app-text-muted)" letterSpacing="0.05em">$0</text>
    </svg>
  );
}

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
  // For the rolling windows with no period data, return empty so the filter is clearly reflected.
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
  if (metric === 'processScore') return stats.ruleAdherence;
  if (metric === 'winRate') return stats.winRate;
  if (metric === 'avgR') return stats.avgR ?? 0;
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


function avgRText(rival: Rival, period: LeaderboardPeriod): string {
  const r = getPeriodStats(rival, period).avgR ?? rival.mascot.stats.avgR ?? null;
  return r == null ? '—' : r.toFixed(2);
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

// Tone drives colour: green for gains/streaks, red for slips/losing days,
// amber for rank changes, muted for neutral notes.
type PulseTone = 'gain' | 'loss' | 'rank' | 'neutral';
interface PulseEvent { id: string; text: ReactNode; tone: PulseTone; when: string; rival: Rival }

const RELATIVE_WHEN = ['just now', '2h ago', '5h ago', 'yesterday', '2d ago', '3d ago'];

/** Derives a live-feeling activity feed from real, verifiable board data —
 *  rank moves, hot streaks, best/worst days, and the current leader. No
 *  fabrication. Ordered most-recent first; timestamps are relative. */
function buildActivityFeed(
  ranked: Rival[], leagueRivals: Rival[], metric: LeaderboardMetric, period: LeaderboardPeriod,
): PulseEvent[] {
  const raw: Omit<PulseEvent, 'when'>[] = [];
  ranked.forEach((rival) => {
    const name = rival.isMe ? 'You' : rival.displayName;
    const move = rankMovement(rival, leagueRivals, metric, period);
    const rank = ranked.findIndex(r => r.id === rival.id) + 1;
    if (move > 0) raw.push({ id: `mv-${rival.id}`, rival, tone: 'rank', text: <><b>{name}</b> climbed to #{rank}</> });
    else if (move < 0) raw.push({ id: `mv-${rival.id}`, rival, tone: 'rank', text: <><b>{name}</b> slipped to #{rank}</> });
    const streak = hotStreak(getPeriodStats(rival, period));
    if (streak >= 2) raw.push({ id: `st-${rival.id}`, rival, tone: 'gain', text: <><b>{name}</b> on a {streak}-day green streak</> });
    const daily = getPeriodStats(rival, period).dailyPnl ?? [];
    if (daily.length) {
      const best = Math.max(...daily.map(d => d.pnl));
      const worst = Math.min(...daily.map(d => d.pnl));
      if (best >= 500) raw.push({ id: `bd-${rival.id}`, rival, tone: 'gain', text: <><b>{name}</b> booked a {formatCurrency(best)} day</> });
      if (worst <= -500) raw.push({ id: `wd-${rival.id}`, rival, tone: 'loss', text: <><b>{name}</b> took a {formatCurrency(worst)} day</> });
    }
  });
  if (ranked[0]) raw.push({ id: 'leader', rival: ranked[0], tone: 'neutral', text: <><b>{ranked[0].isMe ? 'You' : ranked[0].displayName}</b> {ranked[0].isMe ? 'lead' : 'leads'} the board</> });
  return raw.slice(0, 6).map((ev, i) => ({ ...ev, when: RELATIVE_WHEN[i] ?? `${i + 1}d ago` }));
}

/** The single hero stat for a metric — used big on the podium. */
export default function Rivals() {
  const { rivals: rawRivals, addRival, rivalRequests, respondToRequest, profile } = useRivals();
  // Display handles capitalised (curry -> Curry) everywhere the board reads them.
  const rivals = useMemo(() => rawRivals.map(r => ({ ...r, displayName: capName(r.displayName) })), [rawRivals]);
  const [period, setPeriod] = useState<LeaderboardPeriod>('month');
  const [metric, setMetric] = useState<LeaderboardMetric>('netPnl');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  // Sorting lives on the column headers: click a column to sort by it, click the
  // active column again to flip direction. The board (rank, ordering) re-derives.
  const onSort = (m: LeaderboardMetric) => {
    if (m === metric) setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    else { setMetric(m); setSortDir('desc'); }
  };
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
  const [activityExpanded, setActivityExpanded] = useState(false);

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
  const ranked = useMemo(() => {
    const dir = sortDir === 'desc' ? 1 : -1;
    return [...leagueRivals].sort((a, b) => (metricValue(b, metric, period) - metricValue(a, metric, period)) * dir);
  }, [leagueRivals, metric, period, sortDir]);
  const selectedRival = rivals.find(rival => rival.id === selectedRivalId) ?? currentUser;
  const pendingRequests = rivalRequests.filter(request => request.status === 'pending');

  if (!currentUser || !selectedRival) return null;

  const selectedStats = getPeriodStats(selectedRival, period);
  const selectedPosition = ranked.findIndex(rival => rival.id === selectedRival.id) + 1;

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

  // Current user's standing and the traders directly ahead / behind (used by
  // the read and the head-to-head).
  const myPosition = ranked.findIndex(rival => rival.id === currentUser.id) + 1;
  const myAhead = myPosition > 1 ? ranked[myPosition - 2] : null;
  const behindRival = ranked[myPosition] ?? null; // myPosition is 1-based
  const hasRivals = ranked.length >= 2;

  const activity = buildActivityFeed(ranked, leagueRivals, metric, period);

  const btnGhost: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 14px', borderRadius: 9, background: 'var(--app-panel-strong)', border: `1px solid ${LB.border}`, color: LB.text, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' };
  const btnPrimary: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, height: 36, padding: '0 16px', borderRadius: 9, background: LB.amber, border: 'none', color: '#000', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' };

  return (
    <div className="rv2-page" style={{ color: LB.text }}>

      {/* ── Header ── */}
      <header data-tour-id="rivals-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '2px 2px 20px' }}>
        <h1 style={{ margin: 0, minWidth: 0, fontFamily: 'var(--font-sans)', fontSize: 28, fontWeight: 600, letterSpacing: '-0.03em', color: LB.text, lineHeight: 1.1 }}>
          {activeLeague?.name ?? 'Rivals'}
        </h1>
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
      <div data-tour-id="rivals-controls" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16, flexWrap: 'wrap', margin: '4px 0 6px' }}>
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

      {hasRivals && <hr className="rvc-rule" style={{ marginTop: 8, marginBottom: 22 }} />}

      {/* ── Standings table: rank · avatar · trader+share · P&L · Avg R · Win · Rules held ── */}
      {hasRivals && (() => {
        const st = (r: Rival) => getPeriodStats(r, period);
        const pnlColor = (v: number) => (v > 0 ? LB.green : v < 0 ? LB.red : LB.muted);
        const cols: Array<[LeaderboardMetric, string]> = [['netPnl', 'Net P&L'], ['avgR', 'Avg R'], ['winRate', 'Win'], ['processScore', 'Rules held']];
        return (
          <div className="rvc-fade" data-tour-id="rivals-standings">
            <div className="rvt-thead">
              <span /><span /><span>Trader</span>
              {cols.map(([m, label]) => (
                <button key={m} type="button" className={`rvt-r rvt-sort${metric === m ? ' on' : ''}`} onClick={() => onSort(m)}>
                  {label}{metric === m && <span className="rvt-arw">{sortDir === 'desc' ? '▾' : '▴'}</span>}
                </button>
              ))}
            </div>
            {ranked.map((r, i) => {
              const s = st(r);
              const adh = Math.round(s.ruleAdherence);
              return (
                <button key={r.id} type="button" className={`rvt-row${r.isMe ? ' you' : ''}`}
                  onClick={() => { setSelectedRivalId(r.id); setInspectorOpen(true); }}>
                  <span className="rvt-rk">{i + 1}</span>
                  <span className="rvt-av" aria-hidden="true">
                    {r.avatarUrl ? <img src={r.avatarUrl} alt="" /> : (r.displayName[0] ?? '?').toUpperCase()}
                  </span>
                  <div className="rvt-who">
                    <div className="rvt-nm">
                      <b>{r.displayName}</b>
                      {r.isMe && <span className="rvt-youtag">YOU</span>}
                    </div>
                  </div>
                  <span className="rvt-pnl" style={{ color: pnlColor(s.netPnl) }}>{formatCurrency(s.netPnl)}</span>
                  <span className="rvt-cell">{avgRText(r, period)}R</span>
                  <span className="rvt-cell">{Math.round(s.winRate)}%</span>
                  <span className={`rvt-proc ${procBand(adh)}`}>
                    <span className="rvt-bar"><i style={{ width: `${Math.min(100, adh)}%` }} /></span>
                    <span className="rvt-pv">{adh}%</span>
                  </span>
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* ── The read + head-to-head against the trader directly ahead ── */}
      {hasRivals && (() => {
        const st = (r: Rival) => getPeriodStats(r, period);
        const me = st(currentUser);
        const foe = myAhead ?? behindRival; // the trader directly ahead, or the challenger if leading
        const lowest = ranked.reduce((lo, r) => (st(r).ruleAdherence < st(lo).ruleAdherence ? r : lo), ranked[0]);
        const myAvgR = me.avgR;
        const bestAvgR = myAvgR != null && ranked.every(r => (st(r).avgR ?? -Infinity) <= myAvgR);
        return (
          <div className="rvt-read rvc-fade">
            <div className="rvt-col">
              <h2>The read</h2>
              {myAhead ? (
                <p>You are <b style={{ color: LB.amber }}>{formatCurrency(Math.max(0, st(myAhead).netPnl - me.netPnl)).replace('+', '')}</b> behind {myAhead.displayName}, who holds rules on <b style={{ color: procColor(st(myAhead).ruleAdherence) }}>{Math.round(st(myAhead).ruleAdherence)}%</b> of trades{lowest.id === myAhead.id ? ', the lowest here' : ''}.</p>
              ) : (
                <p>You lead the board on {(MODES.find(m => m.value === metric)?.label ?? 'this metric').toLowerCase()}. Hold it by keeping your process clean.</p>
              )}
              {bestAvgR
                ? <p>Your {myAvgR.toFixed(2)}R is the best average trade on the board. You trail on money, not on edge.</p>
                : <p>Your process holds at {Math.round(me.ruleAdherence)}%. The board rewards steadier rule-following over more trades.</p>}
            </div>
            {foe && (
              <div className="rvt-col">
                <h2>You vs {foe.displayName}</h2>
                <div className="rvt-h2h">
                  <div className="rvt-hh"><span>Measure</span><span>{foe.displayName}</span><span>You</span><span>Gap</span></div>
                  {([
                    ['Net P&L', formatCurrency(st(foe).netPnl).replace('+', ''), formatCurrency(me.netPnl).replace('+', ''), h2hDelta('money', me.netPnl - st(foe).netPnl)],
                    ['Avg R', `${avgRText(foe, period)}R`, `${avgRText(currentUser, period)}R`, h2hDelta('r', (me.avgR ?? 0) - (st(foe).avgR ?? 0))],
                    ['Win rate', `${Math.round(st(foe).winRate)}%`, `${Math.round(me.winRate)}%`, h2hDelta('pts', Math.round(me.winRate) - Math.round(st(foe).winRate))],
                    ['Rules held', `${Math.round(st(foe).ruleAdherence)}%`, `${Math.round(me.ruleAdherence)}%`, h2hDelta('pts', Math.round(me.ruleAdherence) - Math.round(st(foe).ruleAdherence))],
                  ] as const).map(([k, them, mine, d]) => (
                    <div key={k} className="rvt-h2r">
                      <span className="k">{k}</span>
                      <span className="v">{them}</span>
                      <span className="v me">{mine}</span>
                      <span className={`d ${d.up ? 'up' : 'dn'}`}>{d.txt}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Recent: a calm footnote — restrained type, quiet timestamps ── */}
      {hasRivals && activity.length > 0 && (() => {
        const shown = activityExpanded ? activity : activity.slice(0, 3);
        return (
          <div className="rvc-fade" style={{ marginTop: 34 }}>
            <div className="rvc-recent-head">Recent</div>
            <div className="rvc-recent">
              {shown.map(ev => (
                <div key={ev.id} className="rvc-recent-row">
                  <span className="rvc-recent-text">{ev.text}</span>
                  <span className="rvc-recent-when">{ev.when}</span>
                </div>
              ))}
            </div>
            {activity.length > 3 && (
              <button type="button" className="rvc-showall" onClick={() => setActivityExpanded(v => !v)}>
                {activityExpanded ? 'Show less' : 'Show all'}
              </button>
            )}
          </div>
        );
      })()}

      {/* ── Low state: no rivals yet — coach the invite, don't show a bare board ── */}
      {!hasRivals && (
        <div style={{ background: LB.card, border: `1px solid ${LB.border}`, borderRadius: 14, padding: '48px 28px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }} data-tour-id="rivals-standings">
          <div style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--app-panel-strong)', border: `1px solid ${LB.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: LB.amber }}>
            <Users size={22} />
          </div>
          <div style={{ maxWidth: 420 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: LB.text }}>Your board is empty</h3>
            <p style={{ margin: '8px 0 0', fontSize: 13, lineHeight: 1.6, color: LB.muted }}>
              Rivals compares verified journal stats side by side, profit, consistency, and process. Invite a trading friend by their Flyxa username to start the table.
            </p>
          </div>
          <button type="button" onClick={() => setIsAddOpen(true)} style={{ ...btnPrimary, height: 40 }}><Plus size={14} /> Invite a trader</button>
        </div>
      )}

      {/* ── Inspector drawer (opens on row click / Show my place) ── */}
      {inspectorOpen && (
        <div onClick={() => setInspectorOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.55)', display: 'flex', justifyContent: 'flex-end' }}>
          <aside className="rv2-me" data-tour-id="rivals-detail" onClick={e => e.stopPropagation()} style={{ position: 'relative', width: 'min(460px, 92vw)', height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 0 }}>
            <button type="button" onClick={() => setInspectorOpen(false)} aria-label="Close" style={{ position: 'absolute', top: 12, right: 12, width: 28, height: 28, borderRadius: '50%', border: `1px solid ${LB.border}`, background: 'var(--app-panel-strong)', color: LB.muted, cursor: 'pointer', zIndex: 2 }}>✕</button>
          <div className="rv2-me-hd">
            <RivalAvatar rival={selectedRival} large />
            <div className="rv2-nm">
              <b>{selectedRival.displayName}</b>
            </div>
            {!selectedRival.isMe && selectedRival.userId && (
              <button type="button" className="rv2-chat" aria-label={`Message ${selectedRival.displayName}`} onClick={() => { setActiveChatRival(selectedRival); setChatOpen(true); }}>
                <MessageCircle size={14} />
              </button>
            )}
          </div>

          <div className="rvd-scroll">
          {(() => {
            // The drawer opens as a comparison, not a profile: the four board
            // metrics, their value, your value, the signed gap. Own row goes
            // solo (You/Gap hidden via .solo). All from real period stats.
            const meStats = getPeriodStats(currentUser, period);
            const isSolo = Boolean(selectedRival.isMe);
            const cmp: Array<[string, string, string, ReturnType<typeof h2hDelta>]> = [
              ['Net P&L', formatCurrency(selectedStats.netPnl), formatCurrency(meStats.netPnl), h2hDelta('money', meStats.netPnl - selectedStats.netPnl)],
              ['Avg R', `${avgRText(selectedRival, period)}R`, `${avgRText(currentUser, period)}R`, h2hDelta('r', (meStats.avgR ?? 0) - (selectedStats.avgR ?? 0))],
              ['Win rate', `${Math.round(selectedStats.winRate)}%`, `${Math.round(meStats.winRate)}%`, h2hDelta('pts', Math.round(meStats.winRate) - Math.round(selectedStats.winRate))],
              ['Rules held', `${Math.round(selectedStats.ruleAdherence)}%`, `${Math.round(meStats.ruleAdherence)}%`, h2hDelta('pts', Math.round(meStats.ruleAdherence) - Math.round(selectedStats.ruleAdherence))],
            ];
            return (
            <div className={`rvd${isSolo ? ' solo' : ''}`}>
              <div className="rvd-meta">{ordinal(selectedPosition)} of {ranked.length} · {selectedStats.tradeCount} trade{selectedStats.tradeCount === 1 ? '' : 's'} {periodPhrase(period)}</div>

              <div className="rvd-sec">
                <h3>{isSolo ? 'Your standing' : 'Against you'}</h3>
                <div className="rvd-cmp">
                  <div className="rvd-ch"><span>Measure</span><span>{isSolo ? 'You' : selectedRival.displayName}</span><span>You</span><span>Gap</span></div>
                  {cmp.map(([k, them, mine, d]) => (
                    <div key={k} className="rvd-cr">
                      <span className="k">{k}</span>
                      <span className="v th">{them}</span>
                      <span className="v mine">{mine}</span>
                      <span className={`d ${d.up ? 'up' : 'dn'}`}>{d.txt}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rvd-sec">
                <h3>Cumulative P&amp;L · {periodPhrase(period)}</h3>
                <RivalCurve them={selectedStats.equityCurve} me={meStats.equityCurve} solo={isSolo} />
                <div className="rvd-kx">
                  <span><i style={{ background: LB.amber }} /><b>{isSolo ? 'You' : selectedRival.displayName} {formatCurrency(selectedStats.netPnl)}</b></span>
                  {!isSolo && <span><i style={{ background: LB.muted }} />You {formatCurrency(meStats.netPnl)}</span>}
                </div>
              </div>

              {!isSolo && selectedRival.userId && (
                <div className="rvd-act">
                  <button type="button" className="rvd-btn pri" onClick={() => { setActiveChatRival(selectedRival); setChatOpen(true); }}>
                    Challenge {selectedRival.displayName}
                  </button>
                </div>
              )}

              <p className="rvd-priv">This league shares <b>metrics, cumulative R and rule adherence</b>. Trades, journal entries and account size stay private for everyone.</p>
            </div>
            );
          })()}
          </div>
          </aside>
        </div>
      )}

      <AddRivalModal open={isAddOpen} onClose={() => setIsAddOpen(false)} onSubmit={username => addRival(username)} />
      <RivalChatPanel open={chatOpen} rival={activeChatRival} myUserId={profile?.userId ?? null} onClose={() => setChatOpen(false)} />
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
    <div className="rivals-request-copy"><strong>{capName(rival?.displayName ?? 'Unknown trader')}</strong><span>{incoming ? 'Wants to join your leaderboard' : 'Invite sent'} · @{rival?.username ?? 'unknown'}</span></div>
    <div className="rivals-request-actions">{incoming ? <><button className="request-accept" disabled={busy} onClick={() => onAction('accept')}><Check size={13} /> Accept</button><button className="request-decline" disabled={busy} onClick={() => onAction('decline')}><X size={13} /> Decline</button></> : <button className="request-decline" disabled={busy} onClick={() => onAction('cancel')}><Clock3 size={13} /> Cancel</button>}</div>
  </div>;
}
