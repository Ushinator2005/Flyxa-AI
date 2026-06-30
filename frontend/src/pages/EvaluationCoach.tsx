import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, ShieldCheck, Sparkles, Trophy } from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Account, Trade } from '../store/types.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { aiApi } from '../services/api.js';
import type { EvaluationProgress, EvaluationAgentAlert } from '../utils/evaluationCoach.js';
import {
  buildEvaluationAgentAlerts,
  computeEvaluationProgress,
  inferEvaluationTemplate,
  tradesForAccount,
} from '../utils/evaluationCoach.js';
import './EvaluationCoach.css';

const money = (value: number) => value.toLocaleString('en-US', {
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

function PassScreen({ account, progress, onDismiss, onMarkFunded }: {
  account: Account; progress: EvaluationProgress; onDismiss: () => void; onMarkFunded: () => void;
}) {
  const pct = Math.round((progress.drawdownUsed / (account.maxDrawdown || 1)) * 100);
  return (
    <div className="ec-pass" data-tour-id="evaluation-overview">
      <div className="ec-pass-inner">
        <div className="ec-pass-icon"><Trophy size={28} /></div>
        <p className="ec-pass-kicker">Evaluation complete</p>
        <h1 className="ec-pass-title">{account.name}</h1>
        <p className="ec-pass-firm">{account.firm}</p>
        <div className="ec-pass-stats">
          <div className="ec-pass-stat"><strong>{money(progress.netPnl)}</strong><span>Net profit</span></div>
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
  const accounts = useFlyxaStore(state => state.accounts);
  const entries = useFlyxaStore(state => state.entries);
  const activeAccountId = useFlyxaStore(state => state.activeAccountId);
  const updateAccount = useFlyxaStore(state => state.updateAccount);
  const { accounts: tradingAccounts, decorateTrades, selectedAccountId: appSelectedId } = useAppSettings();

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

  const [selectedId, setSelectedId] = useState(() => pickDefaultEvalAccount()?.id ?? '');
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

  const alerts = useMemo(
    () => selected && progress ? buildEvaluationAgentAlerts(selected, allTrades, progress) : [],
    [allTrades, progress, selected],
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
    return (
      <PassScreen
        account={selected} progress={progress}
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

  const firmMeta = [
    selected.firm,
    selected.size ? money(selected.size) : null,
    (selected.drawdownType ?? activeTemplate.drawdownType)
      ? `${(selected.drawdownType ?? activeTemplate.drawdownType)?.replace(/_/g, ' ')} drawdown`
      : null,
  ].filter(Boolean).join(' · ');

  // ── Metric computations ─────────────────────────────────────────
  const targetProgressPct = Math.min(100, Math.round(progress.targetProgressPct));
  const drawdownRemainingPct = maxDrawdown > 0 ? Math.min(100, Math.round((progress.drawdownRemaining / maxDrawdown) * 100)) : 0;
  const drawdownUsedPct = 100 - drawdownRemainingPct;
  const drawdownBufferColor = drawdownRemainingPct > 50 ? 'var(--green)' : drawdownRemainingPct >= 20 ? 'var(--amber)' : 'var(--red)';
  const dailyRemaining = dailyLimit > 0 ? Math.max(0, progress.dailyLossRemaining) : null;
  const dailyRemainingPct = dailyLimit > 0 ? Math.min(100, Math.round((Math.max(0, progress.dailyLossRemaining) / dailyLimit) * 100)) : 0;
  const dailyUsedPct = 100 - dailyRemainingPct;
  const dailyBudgetColor = dailyRemainingPct >= 70 ? 'var(--green)' : dailyRemainingPct >= 35 ? 'var(--amber)' : 'var(--red)';
  const daysMet = progress.tradingDays >= progress.minimumTradingDays;

  // ── Pass probability ring ───────────────────────────────────────
  const probColor = progress.passProbability >= 65 ? 'var(--green)' : progress.passProbability >= 40 ? 'var(--amber)' : 'var(--red)';
  const probLabel = progress.passProbability >= 65 ? 'Strong path' : progress.passProbability >= 40 ? 'Recoverable' : 'High risk';

  // ── Pace ────────────────────────────────────────────────────────
  const avgDailyPnl = progress.tradingDays > 0 ? progress.netPnl / progress.tradingDays : 0;
  const daysToTarget = avgDailyPnl > 0 && progress.targetRemaining > 0 ? Math.ceil(progress.targetRemaining / avgDailyPnl) : null;
  const sessionsLeft = avgDailyPnl > 0 && progress.targetRemaining > 0 ? daysToTarget : null;
  const paceNegative = progress.tradingDays > 0 && avgDailyPnl < 0;
  const s = (n: number) => n !== 1 ? 's' : '';

  // ── Path-to-pass context ───────────────────────────────────────
  const allAlerts = [...alerts, ...behavioralWarnings];
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
  const avgWin = (() => {
    const wins = accountTrades.filter(trade => tradeNet(trade) > 0);
    return wins.length ? wins.reduce((sum, trade) => sum + tradeNet(trade), 0) / wins.length : 0;
  })();
  const avgLossAbs = (() => {
    const losses = accountTrades.filter(trade => tradeNet(trade) < 0);
    return losses.length ? Math.abs(losses.reduce((sum, trade) => sum + tradeNet(trade), 0) / losses.length) : 0;
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
  const violationCount = accountTrades.reduce((sum, trade) => sum + (trade.performanceViolations?.length ?? 0), 0);
  const criticalViolationCount = accountTrades.reduce(
    (sum, trade) => sum + (trade.performanceViolations?.filter(item => item.severity === 'critical').length ?? 0),
    0,
  );
  const behavioralFlagCount = accountTrades.reduce((sum, trade) => sum + (trade.behavioralFlags?.length ?? 0), 0);
  const processHealth = (() => {
    if (planAdherencePct === null && violationCount === 0 && behavioralFlagCount === 0) return 'Not enough tags';
    if ((planAdherencePct ?? 100) >= 80 && criticalViolationCount === 0) return 'Clean enough to scale carefully';
    if ((planAdherencePct ?? 100) >= 60 && criticalViolationCount === 0) return 'Trade smaller until rules tighten';
    return 'Protect the account first';
  })();

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
  function exportReport() {
    if (!progress) return;
    const report = {
      generatedAt: new Date().toISOString(),
      account: { name: selected.name, firm: selected.firm, size: selected.size },
      rules: { profitTarget: target, dailyLossLimit: dailyLimit, maxDrawdown, minimumTradingDays: progress.minimumTradingDays },
      progress, agentAlerts: allAlerts,
      disclaimer: 'Verify all rule values against the current terms supplied by the prop firm.',
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `flyxa-eval-${selected.name.replace(/\s+/g, '-').toLowerCase()}.json`; a.click();
    URL.revokeObjectURL(url);
  }

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

  // ── Recent journal post-sessions for this account ───────────────
  const recentJournalReflections = useMemo(() => {
    const accountId = selected.id;
    return entries
      .filter(e => {
        const anyE = e as unknown as { accountIds?: string[]; account?: string; dailyReflection?: { post?: string } };
        const accs = anyE.accountIds?.length ? anyE.accountIds : (anyE.account ? [anyE.account] : []);
        return accs.includes(accountId) && !!(anyE.dailyReflection?.post?.trim());
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3)
      .map(e => {
        const dr = (e as unknown as { dailyReflection: { post: string } }).dailyReflection;
        return { date: e.date, post: dr.post.trim() };
      });
  }, [entries, selected.id]);

  // ── AI mission load ─────────────────────────────────────────────
  // Placed after early returns so it only fires when the page renders
  function loadMission() {
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
          ? `Coach note — What happened: "${saved.what}". Will improve: "${saved.different}".`
          : '';
      } catch { return ''; }
    })() : '';

    const journalContext = recentJournalReflections.length
      ? `Recent journal post-sessions:\n${recentJournalReflections.map(r => `${r.date}: "${r.post}"`).join('\n')}`
      : '';

    const prompt = `You are Flyxa's evaluation coaching system. Give this trader ONE pass-focused directive for the next session.

Account: ${selected.name} (${selected.firm})
Eval status: ${progress.status} — ${drawdownRemainingPct}% drawdown buffer remaining, ${targetProgressPct}% profit progress
Sessions traded: ${progress.tradingDays} | Avg P&L/session: ${money(avgDailyPnl)} | Pass probability: ${progress.passProbability}%
Pace to target: ${paceHeadline} | ${paceDetail}
Suggested risk cap: ${suggestedRiskCap > 0 ? money(suggestedRiskCap) : 'stand down'} | Plan adherence: ${planAdherencePct !== null ? `${planAdherencePct}%` : 'not enough tagged data'}
Main leak: ${primaryLeak ?? 'none detected'}
Last 3 sessions: ${last3 || 'none yet'}
${behavioralWarnings.length ? `Behavioral patterns: ${behavioralWarnings.map(w => w.title).join('; ')}` : ''}
${journalContext}
${debriefNote}

Write exactly ONE coaching directive sentence. Optimize for passing the evaluation without violating drawdown or daily loss rules. Start with an action verb (Focus on..., Limit entries to..., Avoid..., Cut size to..., Target..., etc.). Be specific to this account's current numbers. No greeting, no explanation — just the directive.`;

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

      {/* ── Account header strip ────────────────────────────────────── */}
      <div className="ec-strip">
        <div className="ec-strip-left">
          <div ref={acctDropRef} className="ec-acct-drop">
            <button type="button" className="ec-acct-trigger" onClick={() => setAcctDropOpen(o => !o)}>
              <span className="ec-acct-dot" style={{ background: triggerColor }} />
              <span className="ec-acct-trigger-name">{selected.name}</span>
              <ChevronDown size={11} />
            </button>
            {acctDropOpen && (
              <div className="ec-acct-menu">
                {dropEval.map(({ account }) => <DropRow key={account.id} account={account} />)}
                {dropPassed.length > 0 && (<><div className="ec-acct-sep">Passed</div>{dropPassed.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
                {dropBlown.length > 0 && (<><div className="ec-acct-sep">Blown</div>{dropBlown.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
              </div>
            )}
          </div>
          {firmMeta && <p className="ec-acct-meta">{firmMeta}</p>}
        </div>

        <div className="ec-strip-right">
          <div className="ec-bal-block">
            <span className="ec-bal-label">Current balance</span>
            <div className="ec-bal-row">
              <span className={`ec-bal-val${progress.netPnl >= 0 ? ' pos' : ' neg'}`}>{money(progress.currentBalance)}</span>
              {progress.netPnl !== 0 && (
                <span className={`ec-bal-delta${progress.netPnl >= 0 ? ' pos' : ' neg'}`}>
                  {progress.netPnl > 0 ? '+' : ''}{money(progress.netPnl)}
                </span>
              )}
            </div>
          </div>
          {allAlerts.length > 0 && (
            <button type="button" className="ec-btn-reduce">Reduce Risk</button>
          )}
<button type="button" className="ec-btn-export" onClick={exportReport}>
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {/* ── Alert bar ───────────────────────────────────────────────── */}
      {/* ── Body ────────────────────────────────────────────────────── */}
      <div className="ec-body">

        {/* Top zone: evaluation health metrics */}
        <div className="ec-top-zone">
          <div className="ec-metric-grid">

            {/* Profit needed */}
            <div className="ec-metric-card">
              <span className="ec-metric-lbl">Profit needed</span>
              <strong className="ec-metric-val" style={{ color: 'var(--amber)' }}>{money(progress.targetRemaining)}</strong>
              <div className="ec-metric-track">
                <div className="ec-metric-fill" style={{ width: `${targetProgressPct}%`, background: 'var(--amber)' }} />
              </div>
              <span className="ec-metric-sub">
                {targetProgressPct}% of {money(target)} target · balance {money(progress.currentBalance)}
              </span>
            </div>

            {/* Drawdown buffer */}
            <div className="ec-metric-card">
              <span className="ec-metric-lbl">Drawdown buffer</span>
              <strong className="ec-metric-val" style={{ color: drawdownBufferColor }}>{money(progress.drawdownRemaining)}</strong>
              <div className="ec-metric-track">
                <div className="ec-metric-fill" style={{ width: `${drawdownRemainingPct}%`, background: drawdownBufferColor }} />
              </div>
              <span className="ec-metric-sub">
                {drawdownUsedPct}% of {money(maxDrawdown)} used · floor {money(progress.drawdownFloor)}
              </span>
            </div>

            {/* Daily budget / trading days */}
            {dailyLimit > 0 ? (
              <div className="ec-metric-card">
                <span className="ec-metric-lbl">Daily budget left</span>
                <strong className="ec-metric-val" style={{ color: dailyBudgetColor }}>{money(dailyRemaining ?? 0)}</strong>
                <div className="ec-metric-track">
                  <div className="ec-metric-fill" style={{ width: `${dailyRemainingPct}%`, background: dailyBudgetColor }} />
                </div>
                <span className="ec-metric-sub">
                  {dailyUsedPct}% used · {money(progress.dailyPnl)} today
                </span>
              </div>
            ) : (
              <div className="ec-metric-card">
                <span className="ec-metric-lbl">Trading days</span>
                <strong className="ec-metric-val" style={{ color: progress.minimumTradingDays > 0 && daysMet ? 'var(--green)' : undefined }}>
                  {progress.tradingDays}
                  {progress.minimumTradingDays > 0 && <span className="ec-metric-denom">/{progress.minimumTradingDays}</span>}
                </strong>
                <div className="ec-metric-track">
                  {progress.minimumTradingDays > 0 && (
                    <div className="ec-metric-fill" style={{ width: `${Math.min(100, (progress.tradingDays / progress.minimumTradingDays) * 100)}%`, background: daysMet ? 'var(--green)' : 'var(--amber)' }} />
                  )}
                </div>
                <span className="ec-metric-sub">
                  {progress.minimumTradingDays > 0
                    ? daysMet ? 'Minimum day requirement met' : `${progress.minimumTradingDays - progress.tradingDays} more day${progress.minimumTradingDays - progress.tradingDays === 1 ? '' : 's'} required`
                    : 'No minimum day requirement'}
                </span>
              </div>
            )}
            <div className="ec-metric-card ec-metric-card-probability">
              <span className="ec-metric-lbl">Pass probability</span>
              <strong className="ec-metric-val" style={{ color: probColor }}>{progress.passProbability}%</strong>
              <div className="ec-metric-track">
                <div className="ec-metric-fill" style={{ width: `${progress.passProbability}%`, background: probColor }} />
              </div>
              <span className="ec-metric-sub">
                {probLabel} · weakest: {weakestDriver?.label ?? 'n/a'}
              </span>
            </div>
          </div>

          {/* Legacy side card kept disabled while the strategy panel replaces it */}
          {false && (
          <div className="ec-side-card" style={{ background: 'transparent', borderColor: 'transparent' }}>
            <span className="ec-side-eyebrow">Evaluation status</span>
            <span className="ec-verdict-badge" style={{ color: probColor }}>{probLabel}</span>
            <p className="ec-verdict-reason">{processHealth}</p>
            <div className="ec-side-divider" />
            <div className="ec-prob-row">
              <span className="ec-prob-label">Pass probability</span>
              <span className="ec-prob-val" style={{ color: probColor }}>{progress.passProbability}%</span>
            </div>
            {progress.minimumTradingDays > 0 && (
              <div className="ec-prob-row">
                <span className="ec-prob-label">Min days</span>
                <span className="ec-prob-val" style={{ color: daysMet ? 'var(--green)' : 'var(--amber)' }}>
                  {progress.tradingDays}/{progress.minimumTradingDays}
                </span>
              </div>
            )}
            <div className="ec-prob-row">
              <span className="ec-prob-label">Sessions left</span>
              <span className="ec-prob-val">{sessionsLeft !== null ? `~${sessionsLeft}` : '—'}</span>
            </div>
            <div className="ec-prob-row">
              <span className="ec-prob-label">Target pace</span>
              <span className="ec-prob-val" style={{ color: avgDailyPnl > 0 ? 'var(--green)' : 'var(--red)' }}>{avgDailyPnl > 0 ? 'On track' : 'Behind'}</span>
            </div>
          </div>
          )}
        </div>

        {/* Path to pass */}
        <section className="ec-strategy-card">
          <div className="ec-strategy-head">
            <div>
              <span className="ec-strategy-kicker">Path to pass</span>
              <h2>Protect the account, then earn the target.</h2>
            </div>
            <span className="ec-strategy-status" style={{ color: probColor }}>{probLabel}</span>
          </div>

          <div className="ec-strategy-grid">
            <div className="ec-strategy-item">
              <span>Pace to target</span>
              <strong>{paceHeadline}</strong>
              <small>{paceDetail}</small>
            </div>
            <div className="ec-strategy-item">
              <span>Session risk cap</span>
              <strong>{suggestedRiskCap > 0 ? money(suggestedRiskCap) : 'Stand down'}</strong>
              <small>
                {dailyLimit > 0
                  ? `${money(dailyRemaining ?? 0)} daily room · ${money(progress.drawdownRemaining)} buffer.`
                  : `${money(progress.drawdownRemaining)} drawdown buffer.`}
              </small>
            </div>
            <div className="ec-strategy-item">
              <span>Process edge</span>
              <strong>{planAdherencePct !== null ? `${planAdherencePct}%` : processHealth}</strong>
              <small>
                {planAdherencePct !== null
                  ? `${violationCount} rule break${s(violationCount)} · ${behavioralFlagCount} behavior flag${s(behavioralFlagCount)}.`
                  : 'Tag rule checks to tighten the pass model.'}
              </small>
            </div>
            <div className="ec-strategy-item">
              <span>Average trade</span>
              <strong>{avgWin > 0 ? `${money(avgWin)} avg win` : 'Not enough wins'}</strong>
              <small>{avgLossAbs > 0 ? `${money(avgLossAbs)} avg loss` : 'No average loss yet'} · Main leak: {primaryLeak ?? 'none detected'}.</small>
            </div>
          </div>

          <div className="ec-directive">
            <div className="ec-directive-label">
              <Sparkles size={10} />
              Next session strategy
            </div>
            <p className={`ec-mission-body${missionLoading ? ' loading' : ''}`}>
              {missionDisplay}
            </p>
          </div>
        </section>

        {/* Coaching alerts — only shown when there are alerts */}
        {allAlerts.length > 0 && (
          <div className="ec-alerts-card" ref={alertsRef}>
            <div className="ec-card-hdr">
              <span className="ec-card-hdr-title">Risk leaks to fix</span>
              <span className="ec-card-badge">{allAlerts.length}</span>
            </div>
            {allAlerts.map((alert, i) => (
              <div
                key={alert.id}
                className={`ec-alert-item${i === allAlerts.length - 1 ? ' last' : ''}`}
                style={{ borderLeftColor: alert.severity === 'critical' ? 'var(--red)' : alert.severity === 'warning' ? 'var(--amber)' : 'var(--border)' }}
              >
                <p className="ec-alert-item-title">{alert.title}</p>
                <p className="ec-alert-item-body">{alert.message}</p>
                <p className="ec-alert-item-fix">→ {alert.action}</p>
              </div>
            ))}
          </div>
        )}

        {/* Session debrief — auto-saves */}
        <div className="ec-debrief-card">
          <div className="ec-card-hdr">
            <span className="ec-card-hdr-title">Session Debrief</span>
            {debriefStatus !== 'idle' && (
              <span className={`ec-debrief-status${debriefStatus === 'saved' ? ' saved' : ''}`}>
                {debriefStatus === 'saving' ? 'Saving…' : 'Saved'}
              </span>
            )}
          </div>
          <div className="ec-debrief-body">
            {recentJournalReflections.length > 0 && (
              <div className="ec-debrief-journal">
                <span className="ec-debrief-journal-label">From your journal</span>
                {recentJournalReflections.map(r => (
                  <div key={r.date} className="ec-debrief-journal-entry">
                    <span className="ec-debrief-journal-date">{new Date(r.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                    <p className="ec-debrief-journal-text">{r.post}</p>
                  </div>
                ))}
              </div>
            )}
            <textarea
              className="ec-debrief-textarea"
              placeholder={recentJournalReflections.length > 0 ? 'Anything to flag for tomorrow\'s coaching…' : 'What happened in today\'s session? What will you do differently?'}
              value={debriefWhat}
              onChange={e => { setDebriefWhat(e.target.value); debriefEditedRef.current = true; }}
              rows={3}
            />
          </div>
        </div>

        <p className="ec-disclaimer">
          Firm rules can change. Flyxa's presets are monitoring aids, not the legal source of truth. Verify every limit against your firm dashboard and agreement.
        </p>
      </div>
    </div>
  );
}
