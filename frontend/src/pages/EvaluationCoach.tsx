import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Download, ShieldCheck, Trophy } from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Account } from '../store/types.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { propFirmRulesApi } from '../services/api.js';
import type { EvaluationProgress, EvaluationTemplate, PropFirmRuleRecord } from '../utils/evaluationCoach.js';
import {
  buildEvaluationAgentAlerts,
  computeEvaluationProgress,
  getEvaluationTemplates,
  inferEvaluationTemplate,
  ruleRecordToTemplate,
  tradesForAccount,
} from '../utils/evaluationCoach.js';
import './EvaluationCoach.css';

const money = (value: number) => value.toLocaleString('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

const STATUS_COLOR: Record<string, string> = {
  Blown: '#ef4444', Passed: '#22c55e', Funded: '#22c55e', Live: '#f59e0b', Eval: '#3b82f6',
};

function PassScreen({ account, progress, onDismiss, onMarkFunded }: {
  account: Account; progress: EvaluationProgress; onDismiss: () => void; onMarkFunded: () => void;
}) {
  const pct = Math.round((progress.drawdownUsed / (account.maxDrawdown || 1)) * 100);
  return (
    <div className="eval-pass" data-tour-id="evaluation-overview">
      <div className="eval-pass-inner">
        <div className="eval-pass-icon"><Trophy size={28} /></div>
        <p className="eval-pass-kicker">Evaluation complete</p>
        <h1 className="eval-pass-title">{account.name}</h1>
        <p className="eval-pass-firm">{account.firm}</p>
        <div className="eval-pass-stats">
          <div className="eval-pass-stat"><strong>{money(progress.netPnl)}</strong><span>Net profit</span></div>
          <div className="eval-pass-stat"><strong>{progress.tradingDays}</strong><span>Trading days</span></div>
          <div className="eval-pass-stat"><strong>{pct}%</strong><span>Drawdown used</span></div>
        </div>
        <p className="eval-pass-note">Verify the result in your firm's dashboard before requesting a funded account.</p>
        <div className="eval-pass-actions">
          <button type="button" className="eval-pass-btn-primary" onClick={onMarkFunded}>Move to funded account</button>
          <button type="button" className="eval-pass-btn-ghost" onClick={onDismiss}>Stay on this view</button>
        </div>
      </div>
    </div>
  );
}

function EmptyEvaluation() {
  return (
    <div className="eval-empty" data-tour-id="evaluation-overview">
      <ShieldCheck size={30} />
      <h2>No evaluation account found</h2>
      <p>Add an account with its type or phase set to evaluation. Flyxa will monitor its rules and progress.</p>
    </div>
  );
}

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

  const [templateId, setTemplateId] = useState('');
  const [remoteTopstepTemplates, setRemoteTopstepTemplates] = useState<EvaluationTemplate[]>([]);
  const [useOptionalDailyLoss, setUseOptionalDailyLoss] = useState(false);
  const [dismissPass, setDismissPass] = useState(false);
  const [acctDropOpen, setAcctDropOpen] = useState(false);
  const acctDropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onOut = (e: MouseEvent) => {
      if (acctDropRef.current && !acctDropRef.current.contains(e.target as Node)) setAcctDropOpen(false);
    };
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, []);

  useEffect(() => {
    let cancelled = false;
    propFirmRulesApi.getTopstep()
      .then(result => {
        if (cancelled) return;
        setRemoteTopstepTemplates(result.rules.map(rule => ruleRecordToTemplate(rule as PropFirmRuleRecord)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const allTrades = useMemo(
    () => decorateTrades(entries.flatMap(e => e.trades)),
    [entries, decorateTrades],
  );

  const selected = evaluationAccounts.find(a => a.id === selectedId) ?? evaluationAccounts[0];

  const templates = useMemo(() => {
    const bundled = getEvaluationTemplates();
    if (!remoteTopstepTemplates.length) return bundled;
    return [...remoteTopstepTemplates, ...bundled.filter(t => t.firm !== 'Topstep')];
  }, [remoteTopstepTemplates]);

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

  const tradeStats = useMemo(() => {
    if (!accountTrades.length) return null;
    const nets = accountTrades.map(t => Number(t.pnl ?? 0) - Number(t.commission ?? 0));
    const wins = nets.filter(n => n > 0).length;
    const winRate = Math.round((wins / nets.length) * 100);
    const avgPnl = nets.reduce((s, n) => s + n, 0) / nets.length;
    const byDay = new Map<string, number>();
    accountTrades.forEach((t, i) => byDay.set(t.date, (byDay.get(t.date) ?? 0) + nets[i]));
    const dayValues = [...byDay.values()];
    const bestDay = dayValues.length ? Math.max(...dayValues) : 0;
    const worstDay = dayValues.length ? Math.min(...dayValues) : 0;
    const greenDayPct = dayValues.length ? Math.round((dayValues.filter(v => v > 0).length / dayValues.length) * 100) : 0;
    return { tradeCount: nets.length, winRate, avgPnl, bestDay, worstDay, greenDayPct };
  }, [accountTrades]);

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
  const selectedTemplate = templates.find(t => t.id === templateId) ?? activeTemplate;
  const target = selected.profitTarget ?? activeTemplate.profitTarget;
  const maxDrawdown = selected.maxDrawdown || activeTemplate.maxDrawdown;
  const dailyLimit = selected.dailyLossLimit || activeTemplate.dailyLossLimit;
  const maxContracts = selected.maxContracts ?? activeTemplate.maxContracts;

  const decision = progress.status === 'violated'
    ? { label: 'Stop trading', tone: 'danger' as const, reason: progress.warnings[0] ?? 'An evaluation limit has been reached.' }
    : progress.status === 'passed'
      ? { label: 'Conditions reached', tone: 'good' as const, reason: 'Protect the result and verify the pass in your firm dashboard.' }
      : progress.warnings.length
        ? { label: 'Reduce risk', tone: 'warning' as const, reason: progress.warnings[0] }
        : { label: 'Within limits', tone: 'good' as const, reason: '' };

  const probColor = progress.passProbability >= 65 ? '#34d399' : progress.passProbability >= 35 ? '#f59e0b' : '#f87171';
  const toneColor = { good: '#34d399', warning: '#f59e0b', danger: '#f87171' } as const;

  function applyTemplate(account: Account) {
    updateAccount(account.id, {
      evaluationTemplateId: selectedTemplate.id,
      firmRuleVersionId: selectedTemplate.id,
      evaluationPath: selectedTemplate.path === 'no_activation_fee' ? 'no_activation_fee' : 'standard',
      dailyLossMode: useOptionalDailyLoss ? 'purchase_fixed' : 'none',
      size: selectedTemplate.accountSize,
      startingBalance: selectedTemplate.accountSize,
      profitTarget: selectedTemplate.profitTarget,
      dailyLossLimit: useOptionalDailyLoss
        ? selectedTemplate.optionalDailyLossLimit ?? selectedTemplate.dailyLossLimit
        : selectedTemplate.dailyLossLimit,
      maxDrawdown: selectedTemplate.maxDrawdown,
      minimumTradingDays: selectedTemplate.minimumTradingDays,
      maxContracts: selectedTemplate.maxContracts,
      consistencyLimitPct: selectedTemplate.consistencyLimitPct,
      drawdownType: selectedTemplate.drawdownType,
      evaluationStartedAt: account.evaluationStartedAt ?? new Date().toISOString(),
    });
  }

  function exportReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      account: { name: selected.name, firm: selected.firm, size: selected.size },
      rules: { profitTarget: target, dailyLossLimit: dailyLimit, maxDrawdown, minimumTradingDays: progress.minimumTradingDays, maxContracts, drawdownType: selected.drawdownType ?? activeTemplate.drawdownType },
      progress, agentAlerts: alerts,
      disclaimer: 'Verify all rule values against the current terms supplied by the prop firm.',
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `flyxa-eval-${selected.name.replace(/\s+/g, '-').toLowerCase()}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  const selStatus = statusById.get(selected.id) ?? 'Eval';
  const triggerColor = STATUS_COLOR[selStatus] ?? 'var(--app-text-subtle)';
  const dropEval   = comparisons.filter(c => c.status === 'Eval');
  const dropPassed = comparisons.filter(c => c.status === 'Passed');
  const dropBlown  = comparisons.filter(c => c.status === 'Blown');

  function DropRow({ account }: { account: Account }) {
    const isSelected = account.id === selected.id;
    const st = statusById.get(account.id) ?? 'Eval';
    const col = STATUS_COLOR[st] ?? 'var(--app-text-subtle)';
    return (
      <button type="button"
        className={`eval-acct-row${isSelected ? ' selected' : ''}${st === 'Blown' ? ' blown' : ''}`}
        onClick={() => { setSelectedId(account.id); setAcctDropOpen(false); }}
      >
        <div className="eval-acct-row-info">
          <strong>{account.name}</strong>
          {account.firm && <small>{account.firm}</small>}
        </div>
        <span className="eval-acct-pill" style={{ color: col, background: col + '18', borderColor: col + '40' }}>{st}</span>
      </button>
    );
  }

  const drawdownPct = maxDrawdown > 0 ? Math.round((progress.drawdownUsed / maxDrawdown) * 100) : 0;
  const drawdownTone = drawdownPct >= 75 ? 'danger' : drawdownPct >= 50 ? 'warning' : 'good';
  const dailyPct = dailyLimit > 0 && Number.isFinite(progress.dailyLossRemaining)
    ? Math.round(((dailyLimit - Math.max(0, progress.dailyLossRemaining)) / dailyLimit) * 100)
    : null;
  const dailyTone = dailyPct !== null && dailyPct >= 75 ? 'danger' : dailyPct !== null && dailyPct >= 50 ? 'warning' : 'good';
  const daysMet = progress.tradingDays >= progress.minimumTradingDays;

  const avgDailyPnl = progress.tradingDays > 0 ? progress.netPnl / progress.tradingDays : 0;
  const daysToTarget = avgDailyPnl > 0 && progress.targetRemaining > 0 ? Math.ceil(progress.targetRemaining / avgDailyPnl) : null;
  const s = (n: number) => n !== 1 ? 's' : '';
  const paceText = progress.tradingDays === 0 ? ''
    : avgDailyPnl > 0 && daysToTarget !== null
      ? `Averaging ${money(avgDailyPnl)}/session across ${progress.tradingDays} session${s(progress.tradingDays)}. At this pace, ~${daysToTarget} more session${s(daysToTarget)} to reach the ${money(target)} target.`
      : avgDailyPnl > 0
        ? `Averaging ${money(avgDailyPnl)}/session across ${progress.tradingDays} session${s(progress.tradingDays)}.`
        : `Averaging ${money(avgDailyPnl)}/session across ${progress.tradingDays} session${s(progress.tradingDays)}. ${money(progress.targetRemaining)} still needed to reach the ${money(target)} target.`;
  const paceNegative = progress.tradingDays > 0 && avgDailyPnl < 0;

  const firmMeta = [
    selected.firm,
    selected.size ? money(selected.size) : null,
    (selected.drawdownType ?? activeTemplate.drawdownType)
      ? `${(selected.drawdownType ?? activeTemplate.drawdownType)?.replace(/_/g, ' ')} drawdown`
      : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="eval-page" data-tour-id="evaluation-overview">

      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="eval-header">
        <div className="eval-header-left">
          <div ref={acctDropRef} className="eval-acct-drop">
            <button type="button" className="eval-acct-trigger" onClick={() => setAcctDropOpen(o => !o)}>
              <span className="eval-acct-dot" style={{ background: triggerColor }} />
              <span className="eval-acct-trigger-name">{selected.name}</span>
              <ChevronDown size={11} />
            </button>
            {acctDropOpen && (
              <div className="eval-acct-menu">
                {dropEval.map(({ account }) => <DropRow key={account.id} account={account} />)}
                {dropPassed.length > 0 && (<><div className="eval-acct-sep">Passed</div>{dropPassed.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
                {dropBlown.length > 0 && (<><div className="eval-acct-sep">Blown</div>{dropBlown.map(({ account }) => <DropRow key={account.id} account={account} />)}</>)}
              </div>
            )}
          </div>
          {firmMeta && <span className="eval-header-firm">{firmMeta}</span>}
        </div>
        <div className="eval-header-right">
          <div className="eval-header-bal-group">
            <span className={`eval-header-bal${progress.netPnl >= 0 ? ' pos' : ' neg'}`}>
              {money(progress.currentBalance)}
            </span>
            {progress.netPnl !== 0 && (
              <span className={`eval-header-delta${progress.netPnl >= 0 ? ' pos' : ' neg'}`}>
                {progress.netPnl > 0 ? '+' : ''}{money(progress.netPnl)}
              </span>
            )}
          </div>
          <div className={`eval-status-pill eval-status-pill-${decision.tone}`}>{decision.label}</div>
          <button type="button" className="eval-export-btn" onClick={exportReport}>
            <Download size={12} /> Export
          </button>
        </div>
      </div>

      {/* ── Warning / danger reason ─────────────────────────────────── */}
      {decision.tone !== 'good' && decision.reason && (
        <div className={`eval-reason-bar eval-reason-bar-${decision.tone}`}>{decision.reason}</div>
      )}

      {/* ── 3 Key metrics ───────────────────────────────────────────── */}
      <div className="eval-metrics">

        {/* Profit progress */}
        <div className="eval-metric" style={{ '--mc-acc': '#f59e0b' } as React.CSSProperties}>
          <span className="eval-metric-lbl">Profit needed</span>
          <strong className="eval-metric-val">{money(progress.targetRemaining)}</strong>
          <div className="eval-metric-track">
            <div className="eval-metric-fill" style={{ width: `${Math.min(100, progress.targetProgressPct)}%` }} />
          </div>
          <span className="eval-metric-note">
            {Math.round(progress.targetProgressPct)}% of {money(target)} target
            <span className="eval-metric-note-sep">·</span>
            balance {money(progress.currentBalance)}
          </span>
        </div>

        {/* Drawdown buffer */}
        <div className="eval-metric" style={{ '--mc-acc': toneColor[drawdownTone] } as React.CSSProperties}>
          <span className="eval-metric-lbl">Drawdown buffer</span>
          <strong className="eval-metric-val" style={{ color: toneColor[drawdownTone] }}>
            {money(progress.drawdownRemaining)}
          </strong>
          <div className="eval-metric-track">
            <div className="eval-metric-fill" style={{ width: `${drawdownPct}%` }} />
          </div>
          <span className="eval-metric-note">
            {drawdownPct}% of {money(maxDrawdown)} used
            <span className="eval-metric-note-sep">·</span>
            floor {money(progress.drawdownFloor)}
          </span>
        </div>

        {/* Daily budget or trading days */}
        {dailyLimit > 0 ? (
          <div className="eval-metric" style={{ '--mc-acc': toneColor[dailyTone] } as React.CSSProperties}>
            <span className="eval-metric-lbl">Daily budget left</span>
            <strong className="eval-metric-val" style={{ color: dailyTone !== 'good' ? toneColor[dailyTone] : undefined }}>
              {money(Math.max(0, progress.dailyLossRemaining))}
            </strong>
            <div className="eval-metric-track">
              <div className="eval-metric-fill" style={{ width: `${dailyPct ?? 0}%` }} />
            </div>
            <span className="eval-metric-note">
              {dailyPct ?? 0}% of {money(dailyLimit)} used
              <span className="eval-metric-note-sep">·</span>
              {money(progress.dailyPnl)} today
            </span>
          </div>
        ) : (
          <div className="eval-metric" style={{ '--mc-acc': daysMet ? '#34d399' : '#f59e0b' } as React.CSSProperties}>
            <span className="eval-metric-lbl">Trading days</span>
            <strong className="eval-metric-val" style={{ color: progress.minimumTradingDays > 0 && daysMet ? '#34d399' : undefined }}>
              {progress.tradingDays}
              {progress.minimumTradingDays > 0 && <span className="eval-metric-denom">/{progress.minimumTradingDays}</span>}
            </strong>
            <div className="eval-metric-track">
              {progress.minimumTradingDays > 0 && (
                <div className="eval-metric-fill" style={{ width: `${Math.min(100, (progress.tradingDays / progress.minimumTradingDays) * 100)}%` }} />
              )}
            </div>
            <span className="eval-metric-note">
              {progress.minimumTradingDays > 0
                ? daysMet
                  ? 'Minimum day requirement met'
                  : `${progress.minimumTradingDays - progress.tradingDays} more day${progress.minimumTradingDays - progress.tradingDays === 1 ? '' : 's'} required`
                : 'No minimum day requirement'}
            </span>
          </div>
        )}
      </div>

      {/* ── Stats grid ──────────────────────────────────────────────── */}
      {tradeStats ? (
        <div className="eval-stats">
          {([
            { lbl: 'Trades',      val: String(tradeStats.tradeCount),                                              color: undefined },
            { lbl: 'Win rate',    val: `${tradeStats.winRate}%`,                                                   color: tradeStats.winRate >= 50 ? '#34d399' : '#f87171' },
            { lbl: 'Avg / trade', val: `${tradeStats.avgPnl >= 0 ? '+' : ''}${money(tradeStats.avgPnl)}`,          color: tradeStats.avgPnl >= 0 ? '#34d399' : '#f87171' },
            { lbl: 'Best day',    val: `${tradeStats.bestDay > 0 ? '+' : ''}${money(tradeStats.bestDay)}`,         color: tradeStats.bestDay >= 0 ? '#34d399' : '#f87171' },
            { lbl: 'Worst day',   val: money(tradeStats.worstDay),                                                  color: tradeStats.worstDay < 0 ? '#f87171' : '#34d399' },
            { lbl: 'Green days',  val: `${tradeStats.greenDayPct}%`,                                               color: tradeStats.greenDayPct >= 50 ? '#34d399' : '#f87171' },
          ] as { lbl: string; val: string; color: string | undefined }[]).map(({ lbl, val, color }) => (
            <div key={lbl} className="eval-stat">
              <span className="eval-stat-val" style={{ color }}>{val}</span>
              <span className="eval-stat-lbl">{lbl}</span>
            </div>
          ))}
          <div className="eval-stat eval-stat-prob">
            <span className="eval-stat-val" style={{ color: probColor }}>{progress.passProbability}%</span>
            <span className="eval-stat-lbl">Pass probability</span>
          </div>
          {progress.minimumTradingDays > 0 && (
            <div className="eval-stat">
              <span className="eval-stat-val" style={{ color: daysMet ? '#34d399' : undefined }}>
                {progress.tradingDays}/{progress.minimumTradingDays}
              </span>
              <span className="eval-stat-lbl">Min days</span>
            </div>
          )}
        </div>
      ) : (
        <div className="eval-no-trades">No trades recorded for this account yet.</div>
      )}

      {/* ── Pace note ───────────────────────────────────────────────── */}
      {paceText && (
        <p className={`eval-pace${paceNegative ? ' neg' : ''}`}>{paceText}</p>
      )}

      {/* ── Alerts ──────────────────────────────────────────────────── */}
      {alerts.length > 0 && (
        <div className="eval-alerts">
          {alerts.map(alert => (
            <div key={alert.id} className={`eval-alert eval-alert-${alert.severity}`}>
              <div className="eval-alert-main">
                <strong>{alert.title}</strong>
                <p>{alert.message}</p>
              </div>
              <span className="eval-alert-action">{alert.action}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Rules preset ────────────────────────────────────────────── */}
      <div className="eval-preset">
        <div className="eval-preset-info">
          <span className="eval-preset-lbl">Rules preset</span>
          <span className="eval-preset-sub">
            {selectedTemplate.program ?? 'Evaluation'} · verified {selectedTemplate.verifiedAt ? new Date(selectedTemplate.verifiedAt).toLocaleDateString() : 'locally'}
          </span>
        </div>
        {selectedTemplate.optionalDailyLossLimit && (
          <label className="eval-dll-toggle">
            <input type="checkbox" checked={useOptionalDailyLoss} onChange={e => setUseOptionalDailyLoss(e.target.checked)} />
            {money(selectedTemplate.optionalDailyLossLimit)} daily limit
          </label>
        )}
        <select value={selectedTemplate.id} onChange={e => setTemplateId(e.target.value)}>
          {templates.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <button type="button" onClick={() => applyTemplate(selected)}>Apply</button>
      </div>

      <p className="eval-disclaimer">
        Firm rules can change. Flyxa's presets are monitoring aids, not the legal source of truth. Verify every limit against your firm dashboard and agreement.
      </p>
    </div>
  );
}
