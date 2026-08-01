import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ShieldCheck, Trophy } from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Account, Trade } from '../store/types.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { aiApi } from '../services/api.js';
import type { EvaluationProgress, EvaluationAgentAlert } from '../utils/evaluationCoach.js';
import {
  buildEvaluationAgentAlerts,
  computeEvaluationProgress,
  computeMllSeries,
  inferEvaluationTemplate,
  tradesForAccount,
} from '../utils/evaluationCoach.js';
import './EvaluationCoach.css';

const money = (value: number) => (Number.isFinite(value) ? value : 0).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

const tradeNet = (trade: Trade) => Number(trade.pnl ?? 0) - Number(trade.commission ?? 0);

const roundTo = (value: number, step = 25) => {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(step, Math.round(value / step) * step);
};

const STATUS_COLOR: Record<string, string> = {
  Blown: '#ef4444', Passed: '#22c55e', Funded: '#22c55e', Live: '#f59e0b', Eval: 'var(--cobalt)',
};

const DD_TYPE_LABEL: Record<string, string> = {
  static: 'static',
  eod_trailing: 'EOD trailing',
  intraday_trailing: 'real-time trailing',
};

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Behavioral warnings ──────────────────────────────────────────────────────

function computeBehavioralWarnings(trades: Trade[]): EvaluationAgentAlert[] {
  if (trades.length < 5) return [];
  const warnings: EvaluationAgentAlert[] = [];

  const byDate = new Map<string, Trade[]>();
  for (const t of trades) {
    const d = t.date ?? '';
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(t);
  }

  const overallWins = trades.filter(t => t.pnl > 0).length;
  const overallWR = trades.length ? (overallWins / trades.length) * 100 : 0;

  // Post-loss re-entry pattern
  const postLossTrades: Trade[] = [];
  for (const dayTrades of byDate.values()) {
    const sorted = [...dayTrades].sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i - 1].pnl < 0) postLossTrades.push(sorted[i]);
    }
  }
  if (postLossTrades.length >= 4) {
    const plWins = postLossTrades.filter(t => t.pnl > 0).length;
    const plWR = (plWins / postLossTrades.length) * 100;
    const drop = overallWR - plWR;
    if (plWR < overallWR - 12) {
      warnings.push({
        id: 'behavioral-post-loss',
        severity: 'warning',
        title: `Post-loss WR drops ${Math.round(drop)}% on re-entry`,
        message: `After a losing trade, your win rate falls from ${Math.round(overallWR)}% to ${Math.round(plWR)}% across ${postLossTrades.length} post-loss trades in this evaluation.`,
        action: 'Mandatory 15-min break after any loss before re-entering.',
      });
    }
  }

  // Day-of-week pattern
  const byDow = new Map<string, number[]>();
  for (const t of trades) {
    if (!t.date) continue;
    const d = new Date(`${t.date}T00:00:00`);
    if (isNaN(d.getTime())) continue;
    const dow = DOW[d.getDay()];
    if (!byDow.has(dow)) byDow.set(dow, []);
    byDow.get(dow)!.push(t.pnl);
  }
  const dowEntries = [...byDow.entries()].filter(([, ps]) => ps.length >= 3);
  if (dowEntries.length >= 2) {
    const dowNet = (ps: number[]) => ps.reduce((s, p) => s + p, 0);
    const worst = dowEntries.sort((a, b) => dowNet(a[1]) - dowNet(b[1]))[0];
    const worstNet = dowNet(worst[1]);
    if (worstNet < -200) {
      warnings.push({
        id: 'behavioral-worst-dow',
        severity: 'info',
        title: `${worst[0]}s: ${money(worstNet)} net drag`,
        message: `Your ${worst[0]} sessions are the weakest in this evaluation (${worst[1].length} sessions, ${money(worstNet)} net).`,
        action: `Reduce size or skip ${worst[0]} sessions until pattern reverses.`,
      });
    }
  }

  // Overtrading signal
  const dayTradeCounts = [...byDate.entries()];
  const highDays = dayTradeCounts.filter(([, ts]) => ts.length >= 4);
  const lowDays = dayTradeCounts.filter(([, ts]) => ts.length <= 2);
  if (highDays.length >= 3 && lowDays.length >= 3) {
    const avgWR = (days: [string, Trade[]][]) => {
      const all = days.flatMap(([, ts]) => ts);
      return all.length ? (all.filter(t => t.pnl > 0).length / all.length) * 100 : 0;
    };
    const highWR = avgWR(highDays);
    const lowWR = avgWR(lowDays);
    if (lowWR > highWR + 10) {
      warnings.push({
        id: 'behavioral-overtrading',
        severity: 'warning',
        title: `4+ trade days underperform by ${Math.round(lowWR - highWR)}% WR`,
        message: `Low-volume days (≤2 trades): ${Math.round(lowWR)}% WR. High-volume days (4+ trades): ${Math.round(highWR)}% WR. Selective trading is outperforming busy days.`,
        action: 'Cap at 3 trades per session and stop early on the third loss.',
      });
    }
  }

  return warnings;
}

// (computeDayVerdict imported from evaluationCoach.ts)

// ─── Sub-components ───────────────────────────────────────────────────────────

// The whole evaluation in one picture: the balance line running between the
// MLL (dashed, below — stepped when it trails the trader's highs) and the
// profit target (dashed, above).
function EquitySpark({ points, target, floor, floorSeries, dates }: {
  points: number[]; target: number; floor: number; floorSeries?: number[]; dates?: string[];
}) {
  if (points.length < 2 || !Number.isFinite(target) || !Number.isFinite(floor) || points.some(v => !Number.isFinite(v))) return null;
  const floors = floorSeries && floorSeries.length === points.length && floorSeries.every(v => Number.isFinite(v))
    ? floorSeries
    : null;
  // Taller viewBox to match the enlarged .ec-spark render height — a squat
  // viewBox stretched vertically fattens every stroke.
  const W = 340, H = 164, PAD = 10;
  const lo = Math.min(...points, ...(floors ?? [floor]));
  const hi = Math.max(...points, target);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  // Soft amber fill between the balance line and the MLL — the buffer, visualized.
  const fillPath = `${path} L${x(points.length - 1).toFixed(1)} ${y(floor).toFixed(1)} L${x(0).toFixed(1)} ${y(floor).toFixed(1)} Z`;
  // Step path: the MLL holds through each day and ratchets as a day settles.
  const floorPath = floors
    ? floors.map((v, i) => i === 0
        ? `M${x(0).toFixed(1)} ${y(v).toFixed(1)}`
        : `L${x(i).toFixed(1)} ${y(floors[i - 1]).toFixed(1)} L${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
      .join(' ')
    : null;
  const last = points[points.length - 1];

  // Percent positions for HTML overlays (SVG text would distort under
  // preserveAspectRatio="none").
  const pct = (v: number) => (y(v) / H) * 100;
  // Weight capped at 500 — DM Mono has no bolder cut, and synthetic bold
  // renders thick and fuzzy.
  const labelStyle = (color: string): React.CSSProperties => ({
    position: 'absolute',
    right: 8,
    fontFamily: 'var(--font-mono)',
    fontSize: 9.5,
    fontWeight: 500,
    letterSpacing: '0.07em',
    color,
    background: 'var(--app-panel)',
    padding: '0 4px',
    lineHeight: '13px',
    pointerEvents: 'none',
  });

  const fmtAxisDate = (slice: string) => {
    const parsed = new Date(`${slice}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? slice : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <div>
      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="ec-spark" preserveAspectRatio="none" aria-hidden="true">
          <line x1={PAD} x2={W - PAD} y1={y(target)} y2={y(target)} stroke="var(--green)" strokeOpacity=".38" strokeDasharray="3 5" strokeWidth="1" />
          {floorPath
            ? <path d={floorPath} fill="none" stroke="var(--red)" strokeOpacity=".45" strokeDasharray="3 5" strokeWidth="1" />
            : <line x1={PAD} x2={W - PAD} y1={y(floor)} y2={y(floor)} stroke="var(--red)" strokeOpacity=".4" strokeDasharray="3 5" strokeWidth="1" />}
          <path d={fillPath} fill="rgba(245,158,11,0.05)" stroke="none" />
          <path d={path} fill="none" stroke="var(--amber)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(points.length - 1)} cy={y(last)} r="3" fill="var(--amber)" />
        </svg>
        {/* Line labels pinned to the lines they describe. The balance label
            drops out when it would sit on top of the target/floor labels —
            e.g. a passed run finishing right at target. */}
        <span style={{ ...labelStyle('var(--green)'), top: `calc(${pct(target)}% + 2px)` }}>
          {money(target)}
        </span>
        <span style={{ ...labelStyle('var(--red)'), top: `calc(${pct(floor)}% - 13px)` }}>
          {money(floor)}
        </span>
        {Math.abs(pct(last) - pct(target)) > 16 && Math.abs(pct(last) - pct(floor)) > 16 && (
          <span style={{ ...labelStyle('var(--amber)'), top: `calc(${pct(last)}% - 5px)`, right: 16 }}>
            {money(last)}
          </span>
        )}
      </div>
      {dates && dates.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em', color: 'var(--txt-3, var(--app-text-subtle))' }}>
            {fmtAxisDate(dates[0])}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em', color: 'var(--txt-3, var(--app-text-subtle))' }}>
            {dates.length} SESSION{dates.length !== 1 ? 'S' : ''}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.06em', color: 'var(--txt-3, var(--app-text-subtle))' }}>
            {fmtAxisDate(dates[dates.length - 1])}
          </span>
        </div>
      )}
    </div>
  );
}

function PassScreen({ account, progress, equity, onDismiss, onMarkFunded }: {
  account: Account; progress: EvaluationProgress; onDismiss: () => void; onMarkFunded: () => void;
  equity?: { points: number[]; target: number; floor: number; dates: string[] };
}) {
  // When the floor is unlocked, used + remaining equals the configured max
  // drawdown exactly — a safe base even when account.maxDrawdown is unset.
  const pct = Math.round((progress.drawdownUsed / (account.maxDrawdown || progress.drawdownUsed + progress.drawdownRemaining || 1)) * 100);
  return (
    <div className="ec-pass" data-tour-id="evaluation-overview">
      <div className="ec-pass-inner">
        <div className="ec-pass-medal"><Trophy size={22} /></div>
        <p className="ec-pass-kicker"><span className="ec-pass-rule" />Evaluation complete<span className="ec-pass-rule" /></p>
        <h1 className="ec-pass-title">Passed.</h1>
        <p className="ec-pass-sub">{account.name} · {account.firm}</p>
        {equity && equity.points.length >= 2 && (
          <div className="ec-pass-proof">
            <div className="ec-pass-proof-head">
              <span>The run</span>
              <span>Target cleared</span>
            </div>
            <EquitySpark points={equity.points} target={equity.target} floor={equity.floor} dates={equity.dates} />
          </div>
        )}
        <div className="ec-pass-stats">
          <div className="ec-pass-stat"><strong className="ec-pass-pos">{money(progress.netPnl)}</strong><span>Net profit</span></div>
          <div className="ec-pass-stat"><strong>{progress.tradingDays}</strong><span>Trading days</span></div>
          <div className="ec-pass-stat"><strong>{pct}%</strong><span>Drawdown used</span></div>
        </div>
        <p className="ec-pass-note">Verify the result in your firm's dashboard before requesting a funded account.</p>
        <div className="ec-pass-actions">
          <button type="button" className="ec-pass-btn-primary" onClick={onMarkFunded}>Move to funded account</button>
          <button type="button" className="ec-pass-btn-ghost" onClick={onDismiss}>Stay on this view</button>
        </div>
      </div>
    </div>
  );
}

function EmptyEvaluation() {
  return (
    <div className="ec-empty" data-tour-id="evaluation-overview">
      <ShieldCheck size={30} />
      <h2>No evaluation account found</h2>
      <p>Add an account with its type or phase set to evaluation. Flyxa will monitor its rules and progress.</p>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function EvaluationCoach() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const accounts = useFlyxaStore(state => state.accounts);
  const entries = useFlyxaStore(state => state.entries);
  const activeAccountId = useFlyxaStore(state => state.activeAccountId);
  const updateAccount = useFlyxaStore(state => state.updateAccount);
  const { accounts: tradingAccounts, decorateTrades, selectedAccountId: appSelectedId, preferences } = useAppSettings();

  const statusById = useMemo(
    () => new Map(tradingAccounts.map(ta => [ta.id, ta.status])),
    [tradingAccounts],
  );

  const EVAL_STATUSES = new Set(['Eval', 'Passed', 'Blown']);
  const evaluationAccounts = useMemo(
    () => accounts.filter(a => EVAL_STATUSES.has(statusById.get(a.id) ?? '') || a.type === 'eval' || a.phase === 'eval'),
    [accounts, statusById],
  );

  const latestEntryDateForAccount = useCallback((accountId: string): string => {
    let latest = '';
    for (const entry of entries) {
      const accs = entry.accountIds?.length ? entry.accountIds : (entry.account ? [entry.account] : []);
      if (accs.includes(accountId) && entry.date > latest) latest = entry.date;
    }
    return latest;
  }, [entries]);

  const pickDefaultEvalAccount = useCallback(() => {
    const explicit = evaluationAccounts.find(a => a.id === appSelectedId)
      ?? evaluationAccounts.find(a => a.id === activeAccountId);
    if (explicit) return explicit;
    const sorted = [...evaluationAccounts].sort((a, b) => {
      const blownA = statusById.get(a.id) === 'Blown' ? 1 : 0;
      const blownB = statusById.get(b.id) === 'Blown' ? 1 : 0;
      if (blownA !== blownB) return blownA - blownB;
      return latestEntryDateForAccount(b.id).localeCompare(latestEntryDateForAccount(a.id));
    });
    return sorted[0] ?? null;
  }, [evaluationAccounts, appSelectedId, activeAccountId, statusById, latestEntryDateForAccount]);

  const [selectedId, setSelectedId] = useState(() => {
    const fromParam = searchParams.get('account');
    if (fromParam) return fromParam;
    return pickDefaultEvalAccount()?.id ?? '';
  });
  useEffect(() => {
    if (selectedId && evaluationAccounts.find(a => a.id === selectedId)) return;
    const preferred = pickDefaultEvalAccount();
    if (preferred) setSelectedId(preferred.id);
  }, [evaluationAccounts, pickDefaultEvalAccount]);

  const [dismissPass, setDismissPass] = useState(false);
  const [acctDropOpen, setAcctDropOpen] = useState(false);

  // Coaching state
  const [missionText, setMissionText] = useState('');
  const [missionLoading, setMissionLoading] = useState(false);
  const [missionLoadedFor, setMissionLoadedFor] = useState('');
  const [debriefWhat, setDebriefWhat] = useState('');
  const [debriefStatus, setDebriefStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const debriefEditedRef = useRef(false);

  const acctDropRef = useRef<HTMLDivElement>(null);
  const alertsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOut = (e: MouseEvent) => {
      if (acctDropRef.current && !acctDropRef.current.contains(e.target as Node)) setAcctDropOpen(false);
    };
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, []);

  const allTrades = useMemo(
    () => decorateTrades(entries.flatMap(e => e.trades)),
    [entries, decorateTrades],
  );

  const selected = evaluationAccounts.find(a => a.id === selectedId) ?? evaluationAccounts[0];

  const progress = useMemo(
    () => selected ? computeEvaluationProgress(selected, allTrades) : null,
    [allTrades, selected],
  );

  // MLL per trading day — plotted under the equity path so the rising floor
  // is visible, not just its current value.
  const mllSeries = useMemo(
    () => selected ? computeMllSeries(selected, allTrades) : [],
    [allTrades, selected],
  );

  const alerts = useMemo(
    () => selected && progress ? buildEvaluationAgentAlerts(selected, allTrades, progress, preferences.sessionTimes) : [],
    [allTrades, progress, selected, preferences.sessionTimes],
  );

  const accountTrades = useMemo(
    () => selected ? tradesForAccount(allTrades, selected.id) : [],
    [allTrades, selected],
  );

  // ── Day map (used in multiple places) ──────────────────────────
  const byDayMap = useMemo(() => {
    const m = new Map<string, number>();
    accountTrades.forEach(t => m.set(t.date, (m.get(t.date) ?? 0) + Number(t.pnl ?? 0) - Number(t.commission ?? 0)));
    return m;
  }, [accountTrades]);

  const dayDates = useMemo(() => [...byDayMap.keys()].sort().reverse(), [byDayMap]);

  const comparisons = useMemo(
    () => evaluationAccounts.map(a => ({
      account: a,
      progress: computeEvaluationProgress(a, allTrades),
      status: statusById.get(a.id) ?? 'Eval',
    })).sort((a, b) => {
      const order: Record<string, number> = { Eval: 0, Passed: 1, Blown: 2 };
      return (order[a.status] ?? 3) - (order[b.status] ?? 3);
    }),
    [allTrades, evaluationAccounts, statusById],
  );

  // ── Behavioral warnings ─────────────────────────────────────────
  const behavioralWarnings = useMemo(() => computeBehavioralWarnings(accountTrades), [accountTrades]);

  // Recent journal post-sessions for this account. MUST live above the early
  // returns — a hook after a conditional return changes the hook count when a
  // passed account renders the PassScreen, and React throws.
  const recentJournalReflections = useMemo(() => {
    const accountId = selected?.id;
    if (!accountId) return [] as Array<{ date: string; post: string }>;
    return entries
      .filter(e => {
        const accs = e.accountIds?.length ? e.accountIds : (e.account ? [e.account] : []);
        return accs.includes(accountId) && Boolean(e.dailyReflection?.post?.trim());
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3)
      .map(e => ({ date: e.date, post: (e.dailyReflection?.post ?? '').trim() }));
  }, [entries, selected?.id]);

  // ── Load debrief from saved account notes ───────────────────────
  useEffect(() => {
    debriefEditedRef.current = false;
    setDebriefStatus('idle');
    if (!selected?.coachingNotes) {
      setDebriefWhat('');
      return;
    }
    try {
      const saved = JSON.parse(selected.coachingNotes) as { what?: string; different?: string };
      setDebriefWhat(saved.what ?? '');
    } catch {
      setDebriefWhat('');
    }
  }, [selected?.id]);

  // ── Auto-save debrief ────────────────────────────────────────────
  useEffect(() => {
    if (!debriefEditedRef.current) return;
    setDebriefStatus('saving');
    const accountId = selectedId;
    const timer = setTimeout(() => {
      updateAccount(accountId, {
        coachingNotes: JSON.stringify({ what: debriefWhat, savedAt: new Date().toISOString() }),
      });
      debriefEditedRef.current = false;
      setDebriefStatus('saved');
      setTimeout(() => setDebriefStatus('idle'), 2000);
    }, 1500);
    return () => clearTimeout(timer);
  }, [debriefWhat, selectedId]);

  if (!selected || !progress) return <EmptyEvaluation />;

  if (progress.status === 'passed' && !dismissPass) {
    // Rebuild the equity run here — the main-view series below is computed
    // after this early return.
    const passStart = Number(selected.size) > 0
      ? Number(selected.size)
      : progress.currentBalance - progress.netPnl;
    const passDates = [...byDayMap.keys()].sort();
    let passBal = passStart;
    const passPoints = [passBal];
    for (const d of passDates) { passBal += Number(byDayMap.get(d) ?? 0); passPoints.push(passBal); }
    const passTarget = passStart + Number(selected.profitTarget ?? inferEvaluationTemplate(selected).profitTarget);
    return (
      <PassScreen
        account={selected} progress={progress}
        equity={{ points: passPoints, target: passTarget, floor: Number(progress.drawdownFloor), dates: passDates }}
        onDismiss={() => setDismissPass(true)}
        onMarkFunded={() => { updateAccount(selected.id, { phase: 'funded', type: 'live' }); setDismissPass(true); }}
      />
    );
  }

  const activeTemplate = inferEvaluationTemplate(selected);
  const target = selected.profitTarget ?? activeTemplate.profitTarget;
  const maxDrawdown = selected.maxDrawdown || activeTemplate.maxDrawdown;
  const dailyLimit = selected.dailyLossLimit || activeTemplate.dailyLossLimit;

  const selStatus = statusById.get(selected.id) ?? 'Eval';
  const triggerColor = STATUS_COLOR[selStatus] ?? 'var(--txt-3)';
  const dropEval   = comparisons.filter(c => c.status === 'Eval');
  const dropPassed = comparisons.filter(c => c.status === 'Passed');
  const dropBlown  = comparisons.filter(c => c.status === 'Blown');

  const ddTypeLabel = DD_TYPE_LABEL[progress.drawdownType] ?? progress.drawdownType;
  const firmMeta = [
    selected.firm,
    selected.size ? money(selected.size) : null,
    `${ddTypeLabel} MLL`,
  ].filter(Boolean).join(' · ');

  // ── Metric computations ─────────────────────────────────────────
  const targetProgressPct = Math.min(100, Math.round(progress.targetProgressPct));
  const drawdownRemainingPct = maxDrawdown > 0 ? Math.min(100, Math.round((progress.drawdownRemaining / maxDrawdown) * 100)) : 0;
  const drawdownUsedPct = 100 - drawdownRemainingPct;
  const dailyRemaining = dailyLimit > 0 ? Math.max(0, progress.dailyLossRemaining) : null;
  const dailyRemainingPct = dailyLimit > 0 ? Math.min(100, Math.round((Math.max(0, progress.dailyLossRemaining) / dailyLimit) * 100)) : 0;
  const dailyUsedPct = 100 - dailyRemainingPct;
  const daysMet = progress.tradingDays >= progress.minimumTradingDays;

  // ── Pass probability ────────────────────────────────────────────
  const probLabel = progress.passProbability >= 65 ? 'Strong path' : progress.passProbability >= 40 ? 'Recoverable' : 'High risk';
  const probColor = progress.passProbability >= 65 ? 'var(--green)' : progress.passProbability >= 40 ? 'var(--amber)' : 'var(--red)';

  // ── Equity path (hero chart) ────────────────────────────────────
  // Derive the baseline from progress (currentBalance − netPnl = the exact
  // starting balance) so the equity line shares the MLL series' anchor —
  // using account.size here desyncs the chart whenever size ≠ startingBalance.
  const startBalance = progress.currentBalance - progress.netPnl;
  const equityDates = [...byDayMap.keys()].sort();
  const equityPoints = (() => {
    let bal = startBalance;
    const pts = [bal];
    for (const d of equityDates) { bal += Number(byDayMap.get(d) ?? 0); pts.push(bal); }
    return pts;
  })();
  const targetBalance = startBalance + Number(target);

  // ── Pace ────────────────────────────────────────────────────────
  const avgDailyPnl = progress.tradingDays > 0 ? progress.netPnl / progress.tradingDays : 0;
  const daysToTarget = avgDailyPnl > 0 && progress.targetRemaining > 0 ? Math.ceil(progress.targetRemaining / avgDailyPnl) : null;
  const sessionsLeft = avgDailyPnl > 0 && progress.targetRemaining > 0 ? daysToTarget : null;
  const paceNegative = progress.tradingDays > 0 && avgDailyPnl < 0;
  const s = (n: number) => n !== 1 ? 's' : '';

  // ── Path-to-pass context ───────────────────────────────────────
  const allAlerts = [...alerts, ...behavioralWarnings];
  // Resolved checklist row: the leaks card reads as a checklist, not a lone
  // warning, when the daily budget is actually being respected.
  const dailyRespectSessions = dailyLimit > 0 ? [...byDayMap.values()].filter(pnl => pnl > -dailyLimit).length : 0;
  const dailyOkRow = dailyLimit > 0 && byDayMap.size > 0 && dailyRespectSessions === byDayMap.size && !allAlerts.some(a => /daily/i.test(a.title))
    ? `${dailyRespectSessions} of ${byDayMap.size} session${byDayMap.size !== 1 ? 's' : ''} closed inside the ${money(dailyLimit)} daily budget.`
    : null;
  const remainingMinDays = Math.max(0, progress.minimumTradingDays - progress.tradingDays);
  const paceHeadline = progress.targetRemaining <= 0
    ? 'Target reached'
    : sessionsLeft !== null
      ? `~${sessionsLeft} session${s(sessionsLeft)}`
      : money(progress.targetRemaining);
  const paceDetail = progress.targetRemaining <= 0
    ? remainingMinDays > 0
      ? `${remainingMinDays} minimum trading day${s(remainingMinDays)} still required.`
      : 'Profit target and minimum days are complete.'
    : sessionsLeft !== null
      ? `Based on your current ${money(avgDailyPnl)}/session average.`
      : `Current average is ${money(avgDailyPnl)}/session, so there is no reliable pass pace yet.`;
  const avgLossAbs = (() => {
    const losses = accountTrades.filter(trade => tradeNet(trade) < 0);
    return losses.length ? Math.abs(losses.reduce((sum, trade) => sum + tradeNet(trade), 0) / losses.length) : 0;
  })();
  // Hold-time asymmetry feeds the AI directive — only from known durations.
  const { avgWinHoldMin, avgLossHoldMin } = (() => {
    const holdOf = (trade: Trade): number | null => {
      if (typeof trade.duration === 'number' && trade.duration > 0) return trade.duration;
      if (typeof trade.durationMinutes === 'number' && trade.durationMinutes > 0) return trade.durationMinutes;
      return null;
    };
    const average = (values: number[]) => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
    return {
      avgWinHoldMin: average(accountTrades.filter(t => tradeNet(t) > 0).map(holdOf).filter((v): v is number => v !== null)),
      avgLossHoldMin: average(accountTrades.filter(t => tradeNet(t) < 0).map(holdOf).filter((v): v is number => v !== null)),
    };
  })();
  const riskFromDaily = dailyLimit > 0
    ? Math.max(0, Math.min(dailyRemaining ?? dailyLimit, dailyLimit * (drawdownRemainingPct < 40 ? 0.2 : 0.3)))
    : Infinity;
  const riskFromBuffer = progress.drawdownRemaining * (drawdownRemainingPct < 40 ? 0.1 : 0.15);
  const suggestedRiskCap = roundTo(Math.min(
    riskFromDaily,
    riskFromBuffer,
    avgLossAbs > 0 ? avgLossAbs : Math.max(100, dailyLimit > 0 ? dailyLimit * 0.25 : riskFromBuffer),
  ));
  const planLogged = accountTrades.filter(trade => typeof trade.reflection?.followedPlan === 'boolean');
  const planAdherencePct = planLogged.length
    ? Math.round((planLogged.filter(trade => trade.reflection?.followedPlan === true).length / planLogged.length) * 100)
    : null;
  // ── Probability drivers ────────────────────────────────────────
  const probabilityDrivers = [
    { label: 'Target progress', value: progress.probabilityFactors.targetScore },
    { label: 'Buffer health', value: progress.probabilityFactors.survivalScore },
    { label: 'Recent win rate', value: progress.probabilityFactors.recentWinRate },
    { label: 'Green days', value: progress.probabilityFactors.dayQuality },
  ];
  const weakestDriver = [...probabilityDrivers].sort((a, b) => a.value - b.value)[0];
  const primaryLeak = allAlerts[0]?.title
    ?? (planAdherencePct !== null && planAdherencePct < 70 ? 'Plan adherence is holding back probability' : weakestDriver?.label);

  // ── AI mission (loaded async) ───────────────────────────────────
  const missionCacheKey = `${selected.id}-${new Date().toISOString().slice(0, 10)}-${progress.tradingDays}`;

  // Fallback static insight text (shown while mission loads or on error)
  const insightFallback = (() => {
    if (progress.tradingDays === 0) return 'No trades recorded yet. Add your first session to see coaching insights.';
    if (paceNegative && drawdownRemainingPct <= 30) {
      return `Buffer critical at ${drawdownRemainingPct}%. At current pace, the evaluation expires before target. Reduce risk to preserve the remaining buffer.`;
    }
    if (daysToTarget !== null) {
      return `Averaging ${money(avgDailyPnl)}/session. At this pace, approximately ${daysToTarget} more session${s(daysToTarget)} to reach the ${money(target)} target.`;
    }
    return `Averaging ${money(avgDailyPnl)}/session across ${progress.tradingDays} session${s(progress.tradingDays)}. ${money(progress.targetRemaining)} still needed.`;
  })();

  // ── Alert bar ───────────────────────────────────────────────────

  // ── All alerts (risk + behavioral) ─────────────────────────────
  function DropRow({ account }: { account: Account }) {
    const isSelected = account.id === selected.id;
    const st = statusById.get(account.id) ?? 'Eval';
    const col = STATUS_COLOR[st] ?? 'var(--txt-3)';
    return (
      <button type="button"
        className={`ec-acct-row${isSelected ? ' selected' : ''}${st === 'Blown' ? ' blown' : ''}`}
        onClick={() => { setSelectedId(account.id); setAcctDropOpen(false); }}
      >
        <div className="ec-acct-row-info">
          <strong>{account.name}</strong>
          {account.firm && <small>{account.firm}</small>}
        </div>
        <span className="ec-acct-pill" style={{ color: col, background: col + '18', borderColor: col + '40' }}>{st}</span>
      </button>
    );
  }

  // ── AI mission load ─────────────────────────────────────────────
  // Placed after early returns so it only fires when the page renders
  function loadMission() {
    // The early return above guarantees progress, but TS cannot narrow a
    // captured variable inside a nested function — re-check locally.
    if (!progress) return;
    if (missionLoadedFor === missionCacheKey || missionLoading) return;
    if (progress.tradingDays === 0) {
      setMissionText('');
      setMissionLoadedFor(missionCacheKey);
      return;
    }
    const last3 = dayDates.slice(0, 3).map(d => money(byDayMap.get(d) ?? 0)).join(', ');

    // Build coaching context from saved debrief notes + journal post-sessions
    const debriefNote = selected.coachingNotes ? (() => {
      try {
        const saved = JSON.parse(selected.coachingNotes!) as { what?: string; different?: string };
        return saved.what || saved.different
          ? `Coach note, What happened: "${saved.what}". Will improve: "${saved.different}".`
          : '';
      } catch { return ''; }
    })() : '';

    const journalContext = recentJournalReflections.length
      ? `Recent journal post-sessions:\n${recentJournalReflections.map(r => `${r.date}: "${r.post}"`).join('\n')}`
      : '';

    const prompt = `You are Flyxa's evaluation coaching system. Give this trader ONE pass-focused directive for the next session.

Account: ${selected.name} (${selected.firm})
Eval status: ${progress.status}, ${drawdownRemainingPct}% drawdown buffer remaining, ${targetProgressPct}% profit progress
MLL: balance must stay above ${money(progress.drawdownFloor)} (${ddTypeLabel}${progress.floorLocked ? ', locked' : progress.trailingStopsAt !== null ? `, locks at ${money(progress.trailingStopsAt)}` : ''})
${progress.consistencyLimitPct !== null && progress.consistencyPct !== null ? `Consistency: biggest day is ${progress.consistencyPct}% of profit (firm limit ${progress.consistencyLimitPct}%)${progress.consistencyPct > progress.consistencyLimitPct ? ', NOT met, needs steadier days' : ''}` : ''}
Sessions traded: ${progress.tradingDays} | Avg P&L/session: ${money(avgDailyPnl)} | Pass probability: ${progress.passProbability}%
Pace to target: ${paceHeadline} | ${paceDetail}
Suggested risk cap: ${suggestedRiskCap > 0 ? money(suggestedRiskCap) : 'stand down'} | Plan adherence: ${planAdherencePct !== null ? `${planAdherencePct}%` : 'not enough tagged data'}
${avgWinHoldMin > 0 && avgLossHoldMin > 0 ? `Hold time: winners avg ${Math.round(avgWinHoldMin)}m, losers ${Math.round(avgLossHoldMin)}m${avgLossHoldMin > avgWinHoldMin * 1.5 ? ', losers held too long' : ''}` : ''}
Main leak: ${primaryLeak ?? 'none detected'}
Last 3 sessions: ${last3 || 'none yet'}
${behavioralWarnings.length ? `Behavioral patterns: ${behavioralWarnings.map(w => w.title).join('; ')}` : ''}
${journalContext}
${debriefNote}

Write exactly ONE coaching directive sentence. Optimize for passing the evaluation without violating drawdown or daily loss rules. Start with an action verb (Focus on..., Limit entries to..., Avoid..., Cut size to..., Target..., etc.). Be specific to this account's current numbers. No greeting, no explanation, just the directive.`;

    setMissionLoading(true);
    aiApi.flyxaChat(prompt, [])
      .then(({ reply }) => {
        setMissionText(reply.trim());
        setMissionLoadedFor(missionCacheKey);
      })
      .catch(() => {
        setMissionText('');
        setMissionLoadedFor(missionCacheKey);
      })
      .finally(() => setMissionLoading(false));
  }

  // Call mission load on render (idempotent due to key check)
  if (missionLoadedFor !== missionCacheKey && !missionLoading && progress.tradingDays > 0) {
    loadMission();
  }

  const missionDisplay = missionLoading
    ? 'Loading today\'s directive…'
    : (missionText || insightFallback);

  return (
    <div className="ec-page" data-tour-id="evaluation-overview">

      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="ec-body">

        {/* ── Page header: account + vitals in one meta row ──────────── */}
        <div className="ec-evhd">
          <div>
            <div ref={acctDropRef} className="ec-acct-drop">
              <button type="button" className="ec-acct-trigger ec-acct-trigger--h1" onClick={() => setAcctDropOpen(o => !o)}>
                <span className="ec-acct-dot" style={{ background: triggerColor }} />
                <span className="ec-acct-trigger-name">{selected.name}</span>
                <ChevronDown size={13} />
              </button>
              {acctDropOpen && (
                <div className="ec-acct-menu">
                  {dropEval.map(({ account }) => <DropRow key={account.id} account={account} />)}
                  {dropPassed.length > 0 && (<><div className="ec-acct-sep">Passed</div>{dropPassed.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
                  {dropBlown.length > 0 && (<><div className="ec-acct-sep">Blown</div>{dropBlown.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
                </div>
              )}
            </div>
            <div className="ec-evhd-meta">
              {firmMeta && <><span>{firmMeta}</span><em>·</em></>}
              <span>Balance <i>{money(progress.currentBalance)}</i></span>
              <em>·</em>
              <span>Target <i>{money(targetBalance)}</i></span>
              <em>·</em>
              <span className="ec-evhd-mll" title={progress.floorLocked
                ? 'The MLL has stopped trailing. The account is closed if balance touches this.'
                : `${ddTypeLabel} MLL. The account is closed if balance touches this.`}
              >
                MLL <i>{money(progress.drawdownFloor)}{progress.floorLocked ? ' locked' : ''}</i>
              </span>
              <em>·</em>
              <span>Day {progress.tradingDays}</span>
            </div>
          </div>
          <span className="ec-phase" style={{ ['--phase-dot' as never]: probColor, color: probColor }}>
            {paceNegative ? 'AT RISK' : 'ON TRACK'}
          </span>
        </div>

        {/* ── Hero: pass probability + drivers | equity path ─────────── */}
        <div className="ec-hero">
          <div className="ec-prob">
            <span className="ec-metric-lbl">Pass probability</span>
            <div className="ec-prob-big" style={{ color: probColor }}>
              <b>{progress.passProbability}</b><span>%</span>
            </div>
            <span className="ec-prob-verdict" style={{ color: probColor }}>{probLabel}</span>
            <div className="ec-prob-bar"><i style={{ width: `${progress.passProbability}%`, background: probColor }} /></div>
            <div className="ec-drv">
              {probabilityDrivers.map(driver => (
                <div key={driver.label} className={`ec-drv-r${driver === weakestDriver ? ' weak' : ''}`}>
                  {driver.label}
                  <b>{Math.round(driver.value)}%</b>
                </div>
              ))}
            </div>
          </div>
          <div className="ec-hero-chart">
            <div className="ec-hero-chart-head">
              <span className="ec-metric-lbl">Equity path</span>
              <span className="ec-hero-chart-meta">
                {money(progress.currentBalance - progress.drawdownFloor)} above MLL ·{' '}
                <b>{progress.targetRemaining <= 0 ? 'target reached' : `${money(progress.targetRemaining)} to target`}</b>
              </span>
            </div>
            {equityPoints.length >= 2
              ? <EquitySpark points={equityPoints} target={targetBalance} floor={Number(progress.drawdownFloor)} floorSeries={mllSeries} dates={equityDates} />
              : <p className="ec-no-data">No sessions recorded yet, the balance line starts with your first trade.</p>}
          </div>
        </div>

        {/* ── Ledger strip: the four numbers that decide the eval ────── */}
        <div className="ec-metric-grid">
          <div className="ec-metric-card">
            <span className="ec-metric-lbl">Profit needed</span>
            <strong className="ec-metric-val">{money(progress.targetRemaining)}</strong>
            <div className="ec-metric-track"><div className="ec-metric-fill" style={{ width: `${targetProgressPct}%` }} /></div>
            <span className="ec-metric-sub">{targetProgressPct}% of {money(target)} target</span>
          </div>

          <div
            className="ec-metric-card"
            title={progress.drawdownType === 'static'
              ? 'Static, the MLL never moves.'
              : progress.floorLocked
                ? 'Locked, the MLL has stopped trailing.'
                : `${ddTypeLabel === 'EOD trailing' ? 'Rises with end-of-day balance highs' : 'Rises with every new balance high'}.`}
          >
            <span className="ec-metric-lbl">Room above MLL</span>
            <strong className="ec-metric-val" style={drawdownRemainingPct < 20 ? { color: 'var(--red)' } : undefined}>{money(progress.drawdownRemaining)}</strong>
            <div className="ec-metric-track"><div className="ec-metric-fill" style={{ width: `${drawdownRemainingPct}%` }} /></div>
            <span className="ec-metric-sub">
              {drawdownUsedPct}% of buffer used{!progress.floorLocked && progress.trailingStopsAt !== null ? ` · locks at ${money(progress.trailingStopsAt)}` : ''}
            </span>
          </div>

          {dailyLimit > 0 ? (
            <div className="ec-metric-card">
              <span className="ec-metric-lbl">Daily budget left</span>
              <strong className="ec-metric-val" style={dailyRemainingPct < 35 ? { color: 'var(--red)' } : undefined}>{money(dailyRemaining ?? 0)}</strong>
              <div className="ec-metric-track"><div className="ec-metric-fill" style={{ width: `${dailyRemainingPct}%` }} /></div>
              <span className="ec-metric-sub">{dailyUsedPct}% used · {money(progress.dailyPnl)} today</span>
            </div>
          ) : (
            <div className="ec-metric-card">
              <span className="ec-metric-lbl">Trading days</span>
              <strong className="ec-metric-val">
                {progress.tradingDays}
                {progress.minimumTradingDays > 0 && <span className="ec-metric-denom">/{progress.minimumTradingDays}</span>}
              </strong>
              <div className="ec-metric-track">
                {progress.minimumTradingDays > 0 && (
                  <div className="ec-metric-fill" style={{ width: `${Math.min(100, (progress.tradingDays / progress.minimumTradingDays) * 100)}%` }} />
                )}
              </div>
              <span className="ec-metric-sub">
                {progress.minimumTradingDays > 0
                  ? daysMet ? 'Minimum day requirement met' : `${progress.minimumTradingDays - progress.tradingDays} more day${s(progress.minimumTradingDays - progress.tradingDays)} required`
                  : 'No minimum day requirement'}
              </span>
            </div>
          )}

          <div className="ec-metric-card">
            <span className="ec-metric-lbl">Pace to target</span>
            <strong className="ec-metric-val">{paceHeadline}</strong>
            <span className="ec-metric-sub">{paceDetail}</span>
          </div>
        </div>

        {/* ── The directive: one branded callout, not a shouting headline ── */}
        <section className="ec-dir">
          <img src="/logo.svg" alt="" className="ec-dir-glyph" />
          <div className="ec-dir-body">
            <span className="ec-metric-lbl">Next session strategy</span>
            <p className={missionLoading ? 'loading' : undefined}>{missionDisplay}</p>
          </div>
          <button type="button" className="ec-dir-ask" onClick={() => navigate('/flyxa-ai/ask')}>
            Ask Flyxa
          </button>
        </section>

        {/* Bottom two-up: risk leaks beside the debrief */}
        <div className="ec-bottom-two">
          {(allAlerts.length > 0 || dailyOkRow) && (
            <div className="ec-alerts-card" ref={alertsRef}>
              <div className="ec-card-hdr">
                <span className="ec-card-hdr-title">Risk leaks to fix</span>
                <span className={`ec-leak-cnt${allAlerts.length === 0 ? ' clear' : ''}`}>
                  {allAlerts.length > 0 ? `${allAlerts.length} OPEN` : 'ALL CLEAR'}
                </span>
              </div>
              {allAlerts.map(alert => (
                <div key={alert.id} className="ec-leak">
                  <div className="ec-leak-t">
                    <b>
                      {alert.severity === 'critical' && <span className="ec-alert-severity critical">Critical · </span>}
                      {alert.title}
                    </b>
                    <p>{alert.message}</p>
                    <span className="ec-leak-fix">FIX → {alert.action}</span>
                  </div>
                </div>
              ))}
              {dailyOkRow && (
                <div className="ec-leak ok">
                  <div className="ec-leak-t">
                    <b>Daily loss limit respected</b>
                    <p>{dailyOkRow}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Session debrief — auto-saves */}
          <div className="ec-debrief-card">
            <div className="ec-card-hdr">
              <span className="ec-card-hdr-title">Session debrief</span>
              {debriefStatus !== 'idle' ? (
                <span className={`ec-debrief-status${debriefStatus === 'saved' ? ' saved' : ''}`}>
                  {debriefStatus === 'saving' ? 'Saving…' : 'Saved'}
                </span>
              ) : (
                <span className="ec-metric-lbl" style={{ marginBottom: 0 }}>Feeds tomorrow's coaching</span>
              )}
            </div>
            {recentJournalReflections.length > 0 && (
              <div className="ec-jq">
                <span className="ec-jq-d">
                  {new Date(recentJournalReflections[0].date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}
                </span>
                <p>&ldquo;{recentJournalReflections[0].post}&rdquo;</p>
              </div>
            )}
            <div className="ec-deb-in">
              <textarea
                className="ec-debrief-textarea"
                placeholder={recentJournalReflections.length > 0 ? 'Anything to flag for tomorrow\'s coaching…' : 'What happened in today\'s session? What will you do differently?'}
                value={debriefWhat}
                onChange={e => { setDebriefWhat(e.target.value); debriefEditedRef.current = true; }}
                rows={4}
              />
              <div className="ec-deb-rmeta">
                <span>FLYXA READS THIS · IT SHAPES YOUR NEXT DIRECTIVE</span>
                <span>AUTOSAVES</span>
              </div>
            </div>
          </div>
        </div>

        <p className="ec-disclaimer">
          Firm rules can change. Flyxa's presets are monitoring aids, not the legal source of truth. Verify every limit against your firm dashboard and agreement.
        </p>
      </div>
    </div>
  );
}
