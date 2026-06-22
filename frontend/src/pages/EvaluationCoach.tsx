import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Download, ShieldCheck, Trophy } from 'lucide-react';
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
    <div className="eval-pass">
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
    <div className="eval-empty">
      <ShieldCheck size={30} />
      <h2>No evaluation account found</h2>
      <p>Add an account with its type or phase set to evaluation. Flyxa will monitor its rules and progress.</p>
    </div>
  );
}

function ProbabilityGauge({ pct, color }: { pct: number; color: string }) {
  const r = 44, cx = 60, cy = 60;
  const circ = 2 * Math.PI * r;
  const arcLen = circ * 0.75;
  const fillLen = arcLen * Math.min(pct, 100) / 100;
  return (
    <svg viewBox="0 0 120 120" className="eval-gauge-svg" aria-hidden="true">
      <circle
        cx={cx} cy={cy} r={r}
        fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8"
        strokeDasharray={`${arcLen} ${circ - arcLen}`}
        strokeLinecap="round"
        transform={`rotate(135 ${cx} ${cy})`}
      />
      <circle
        cx={cx} cy={cy} r={r}
        fill="none" stroke={color} strokeWidth="8"
        strokeDasharray={`${fillLen} ${circ - fillLen}`}
        strokeLinecap="round"
        transform={`rotate(135 ${cx} ${cy})`}
        className="eval-gauge-fill"
      />
    </svg>
  );
}

export default function EvaluationCoach() {
  const accounts = useFlyxaStore(state => state.accounts);
  const entries = useFlyxaStore(state => state.entries);
  const activeAccountId = useFlyxaStore(state => state.activeAccountId);
  const updateAccount = useFlyxaStore(state => state.updateAccount);
  const { accounts: tradingAccounts, decorateTrades } = useAppSettings();

  const statusById = useMemo(
    () => new Map(tradingAccounts.map(ta => [ta.id, ta.status])),
    [tradingAccounts],
  );

  const EVAL_STATUSES = new Set(['Eval', 'Passed', 'Blown']);
  const evaluationAccounts = useMemo(
    () => accounts.filter(a => EVAL_STATUSES.has(statusById.get(a.id) ?? '') || a.type === 'eval' || a.phase === 'eval'),
    [accounts, statusById],
  );

  const [selectedId, setSelectedId] = useState(
    evaluationAccounts.find(a => a.id === activeAccountId)?.id ?? evaluationAccounts[0]?.id ?? '',
  );
  const [templateId, setTemplateId] = useState('');
  const [remoteTopstepTemplates, setRemoteTopstepTemplates] = useState<EvaluationTemplate[]>([]);
  const [rulesCatalogSource, setRulesCatalogSource] = useState('bundled verified catalog');
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
        setRemoteTopstepTemplates(
          result.rules.map(rule => ruleRecordToTemplate(rule as PropFirmRuleRecord)),
        );
        setRulesCatalogSource(result.fallback ? 'bundled verified catalog' : 'versioned rules database');
      })
      .catch(() => {
        if (!cancelled) setRulesCatalogSource('bundled verified catalog');
      });
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
    return [
      ...remoteTopstepTemplates,
      ...bundled.filter(template => template.firm !== 'Topstep'),
    ];
  }, [remoteTopstepTemplates]);

  const progress = useMemo(
    () => selected ? computeEvaluationProgress(selected, allTrades) : null,
    [allTrades, selected],
  );
  const alerts = useMemo(
    () => selected && progress ? buildEvaluationAgentAlerts(selected, allTrades, progress) : [],
    [allTrades, progress, selected],
  );

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
        : { label: 'Within limits', tone: 'good' as const, reason: 'No current evaluation rule is close to its limit.' };

  const probColor = progress.passProbability >= 65 ? '#34d399' : progress.passProbability >= 35 ? '#f59e0b' : '#f87171';

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

  // Dropdown
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

  // Derived values
  const drawdownPct = maxDrawdown > 0 ? Math.round((progress.drawdownUsed / maxDrawdown) * 100) : 0;
  const drawdownTone = drawdownPct >= 75 ? 'danger' : drawdownPct >= 50 ? 'warning' : 'good';
  const dailyPct = dailyLimit > 0 && Number.isFinite(progress.dailyLossRemaining)
    ? Math.round(((dailyLimit - Math.max(0, progress.dailyLossRemaining)) / dailyLimit) * 100)
    : null;
  const dailyTone = dailyPct !== null && dailyPct >= 75 ? 'danger' : dailyPct !== null && dailyPct >= 50 ? 'warning' : 'good';
  const daysMet = progress.tradingDays >= progress.minimumTradingDays;
  const toneColor = { good: '#34d399', warning: '#f59e0b', danger: '#f87171' } as const;

  // Pace projections
  const avgDailyPnl = progress.tradingDays > 0 ? progress.netPnl / progress.tradingDays : 0;
  const daysToTarget = avgDailyPnl > 0 && progress.targetRemaining > 0
    ? Math.ceil(progress.targetRemaining / avgDailyPnl) : null;

  const paceText = progress.tradingDays === 0
    ? 'No trades recorded yet — start trading to see pace projections.'
    : avgDailyPnl <= 0
      ? `Averaging ${money(avgDailyPnl)}/session — the target is moving away. A profitable run is needed to get back on track.`
      : `Averaging ${money(avgDailyPnl)}/session across ${progress.tradingDays} session${progress.tradingDays !== 1 ? 's' : ''}. At this pace, approximately ${daysToTarget} more session${daysToTarget !== 1 ? 's' : ''} to reach the ${money(target)} target.`;

  const paceNegative = progress.tradingDays > 0 && avgDailyPnl <= 0;

  // Probability factor breakdown
  const { targetScore, survivalScore, recentWinRate, dayQuality } = progress.probabilityFactors;
  const factorColor = (v: number) => v >= 60 ? '#34d399' : v >= 30 ? '#f59e0b' : '#f87171';
  const probFactors = [
    { label: 'Target pace', score: targetScore },
    { label: 'Survival', score: survivalScore },
    { label: 'Win rate', score: recentWinRate },
    { label: 'Day quality', score: dayQuality },
  ];
  const weakest = [...probFactors].sort((a, b) => a.score - b.score)[0];
  const strongest = [...probFactors].sort((a, b) => b.score - a.score)[0];
  const probDriverText = progress.tradingDays === 0
    ? 'Start trading to generate a meaningful estimate.'
    : weakest.score < 35
      ? `${weakest.label} is the main drag. Improving it will raise the probability the most.`
      : strongest.score > 75
        ? `${strongest.label} is the strongest factor. Keep it up.`
        : 'Probability is balanced across all factors.';

  return (
    <div className="eval-page">

      {/* Top bar */}
      <div className="eval-topbar">
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
        <button type="button" className="eval-topbar-btn" onClick={exportReport}>
          <Download size={13} /> Export
        </button>
      </div>

      {/* Pass probability hero */}
      <div className="eval-prob-hero">
        <div className="eval-prob-left">
          <p className="eval-prob-kicker">{selected.firm} · {money(selected.size)} · {selected.drawdownType ?? activeTemplate.drawdownType} drawdown</p>
          <h1 className="eval-prob-name">{selected.name}</h1>
          <div className={`eval-prob-badge eval-prob-badge-${decision.tone}`}>
            <span className="eval-prob-badge-dot" style={{ background: toneColor[decision.tone] }} />
            {decision.label}
          </div>
          <p className="eval-prob-reason">{decision.reason}</p>
        </div>
        <div className="eval-prob-dial">
          <div className="eval-gauge-wrap">
            <ProbabilityGauge pct={progress.passProbability} color={probColor} />
            <div className="eval-gauge-inner">
              <span className="eval-prob-pct">{progress.passProbability}<span className="eval-prob-pct-sign">%</span></span>
              <span className="eval-prob-label">pass probability</span>
            </div>
          </div>
          <div className="eval-prob-factors">
            {probFactors.map(f => (
              <div key={f.label} className="eval-prob-factor">
                <span className="eval-prob-factor-lbl">{f.label}</span>
                <div className="eval-prob-factor-track">
                  <div className="eval-prob-factor-fill" style={{ width: `${f.score}%`, background: factorColor(f.score) }} />
                </div>
                <span className="eval-prob-factor-val" style={{ color: factorColor(f.score) }}>{f.score}</span>
              </div>
            ))}
            <p className="eval-prob-driver">{probDriverText}</p>
          </div>
        </div>
      </div>

      {/* Path to pass — 3 cards */}
      <div className="eval-path">

        {/* Profit progress */}
        <div className="eval-path-card" style={{ '--card-accent': '#f59e0b' } as React.CSSProperties}>
          <span className="eval-path-label">Profit needed</span>
          <strong className="eval-path-value">{money(progress.targetRemaining)}</strong>
          <div className="eval-path-track">
            <div className="eval-path-fill" style={{ width: `${Math.min(100, progress.targetProgressPct)}%`, background: '#f59e0b' }} />
          </div>
          <span className="eval-path-note">{Math.round(progress.targetProgressPct)}% of {money(target)} reached · {money(progress.currentBalance)} balance</span>
        </div>

        {/* Drawdown buffer */}
        <div className="eval-path-card" style={{ '--card-accent': toneColor[drawdownTone] } as React.CSSProperties}>
          <span className="eval-path-label">Drawdown buffer</span>
          <strong className="eval-path-value" style={{ color: toneColor[drawdownTone] }}>{money(progress.drawdownRemaining)}</strong>
          <div className="eval-path-track">
            <div className="eval-path-fill" style={{ width: `${drawdownPct}%`, background: toneColor[drawdownTone] }} />
          </div>
          <span className="eval-path-note">{drawdownPct}% of {money(maxDrawdown)} used</span>
        </div>

        {/* Daily budget or trading days */}
        {dailyLimit > 0 ? (
          <div className="eval-path-card" style={{ '--card-accent': toneColor[dailyTone] } as React.CSSProperties}>
            <span className="eval-path-label">Daily budget left</span>
            <strong className="eval-path-value" style={{ color: dailyTone !== 'good' ? toneColor[dailyTone] : 'var(--app-text)' }}>
              {money(Math.max(0, progress.dailyLossRemaining))}
            </strong>
            <div className="eval-path-track">
              <div className="eval-path-fill" style={{ width: `${dailyPct ?? 0}%`, background: toneColor[dailyTone] }} />
            </div>
            <span className="eval-path-note">{money(dailyLimit)} limit · {money(progress.dailyPnl)} today</span>
          </div>
        ) : (
          <div className="eval-path-card" style={{ '--card-accent': daysMet ? '#34d399' : '#f59e0b' } as React.CSSProperties}>
            <span className="eval-path-label">Trading days</span>
            <strong className="eval-path-value" style={{ color: progress.minimumTradingDays > 0 && daysMet ? '#34d399' : 'var(--app-text)' }}>
              {progress.tradingDays}
              {progress.minimumTradingDays > 0 && <span className="eval-path-denom">/{progress.minimumTradingDays}</span>}
            </strong>
            <div className="eval-path-track">
              {progress.minimumTradingDays > 0 && (
                <div className="eval-path-fill" style={{ width: `${Math.min(100, (progress.tradingDays / progress.minimumTradingDays) * 100)}%`, background: daysMet ? '#34d399' : '#f59e0b' }} />
              )}
            </div>
            <span className="eval-path-note">{progress.minimumTradingDays > 0 ? (daysMet ? 'Minimum met' : `${progress.minimumTradingDays - progress.tradingDays} more required`) : 'No minimum day requirement'}</span>
          </div>
        )}
      </div>

      {/* Pace insight */}
      <div className={`eval-insight${paceNegative ? ' eval-insight-warning' : ''}`}>
        {paceText}
      </div>

      {/* Risk alerts */}
      <section className="eval-section">
        <div className="eval-section-head">
          <span>Risk alerts</span>
          <small>{alerts.length ? `${alerts.length} active` : 'Clear'}</small>
        </div>
        {alerts.length ? (
          <div className="eval-alerts">
            {alerts.map(alert => (
              <div key={alert.id} className={`eval-alert eval-alert-${alert.severity}`}>
                <div>
                  <strong>{alert.title}</strong>
                  <p>{alert.message}</p>
                </div>
                <span>{alert.action}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="eval-no-alerts">
            <CheckCircle2 size={15} />
            <div>
              <strong>No active alerts</strong>
              <p>No material process risks detected from your recorded trades.</p>
            </div>
          </div>
        )}
      </section>

      {/* Rules preset */}
          <div className="eval-preset">
            <div>
              <label htmlFor="eval-tpl">Rules preset</label>
              <p>{selectedTemplate.program ?? 'Evaluation'} · verified {selectedTemplate.verifiedAt ? new Date(selectedTemplate.verifiedAt).toLocaleDateString() : 'locally'}</p>
            </div>
            <select id="eval-tpl" value={selectedTemplate.id} onChange={e => setTemplateId(e.target.value)}>
              {templates.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
            <button type="button" onClick={() => applyTemplate(selected)}>Apply</button>
          </div>
          {selectedTemplate.firm === 'Topstep' && (
            <div className="eval-rule-source">
              <div>
                <strong>{selectedTemplate.path === 'no_activation_fee' ? 'No Activation Fee path' : 'Standard path'}</strong>
                <span>
                  {money(selectedTemplate.monthlyPrice ?? 0)}/month · {selectedTemplate.activationFee ? `${money(selectedTemplate.activationFee)} activation` : 'no activation fee'}
                </span>
              </div>
              <label className="eval-dll-option">
                <input
                  type="checkbox"
                  checked={useOptionalDailyLoss}
                  onChange={event => setUseOptionalDailyLoss(event.target.checked)}
                />
                <span>Add Topstep’s fixed {money(selectedTemplate.optionalDailyLossLimit ?? 0)} daily loss limit</span>
              </label>
              <div className="eval-rule-source-meta">
                <span>{selectedTemplate.consistencyLimitPct}% consistency · {selectedTemplate.maxMicros} micros max · v{selectedTemplate.version ?? 1}</span>
                {selectedTemplate.sourceUrl && <a href={selectedTemplate.sourceUrl} target="_blank" rel="noreferrer">Official source</a>}
                <span>{rulesCatalogSource}</span>
              </div>
            </div>
          )}

      <p className="eval-disclaimer">Firm rules can change. Flyxa's presets are monitoring aids, not the legal source of truth. Verify every limit against your firm dashboard and agreement.</p>
    </div>
  );
}
