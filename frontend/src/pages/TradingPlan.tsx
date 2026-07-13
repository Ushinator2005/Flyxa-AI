import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import type { RiskRule } from '../store/types.js';
import { saveStoreStatePatchNow, flushSupabaseStoreNow } from '../store/supabaseStorage.js';
import { pushToast } from '../store/toastStore.js';
import { DEFAULT_STRUCTURED_RULES, normalizeRiskRule } from '../utils/tradingRules.js';
import { buildPlanAdherenceReport } from '../utils/planAdherence.js';
import { lookupContract } from '../constants/futuresContracts.js';
import './TradingPlan.css';

type TradingPlanTab = 'rule-adherence' | 'risk-rules';

const TAB_ITEMS: Array<{ id: TradingPlanTab; label: string; icon: typeof LockKeyhole }> = [
  { id: 'risk-rules', label: 'Risk Rules', icon: LockKeyhole },
  { id: 'rule-adherence', label: 'Rule Adherence', icon: BarChart3 },
];

function formatLastSaved(lastSaved: Date | null, now: number): string {
  if (!lastSaved) return 'Not saved yet';
  const delta = Math.max(0, now - lastSaved.getTime());
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'Saved just now';
  if (minutes === 1) return 'Saved 1 min ago';
  if (minutes < 60) return `Saved ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'Saved 1 hr ago';
  return `Saved ${hours} hr ago`;
}



export default function TradingPlan() {
  const [activeTab, setActiveTab] = useState<TradingPlanTab>('risk-rules');

  const storeRiskRules = useFlyxaStore(state => state.riskRules);
  const riskRules = useMemo(() => storeRiskRules.map(normalizeRiskRule), [storeRiskRules]);

  const journalEntries = useFlyxaStore(state => state.entries);
  const topSymbols = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of journalEntries) {
      for (const trade of entry.trades ?? []) {
        if (!trade.symbol) continue;
        const sym = trade.symbol.toUpperCase().trim();
        counts.set(sym, (counts.get(sym) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([sym]) => sym);
  }, [journalEntries]);

  const [pendingContracts, setPendingContracts] = useState<Record<string, { symbol: string; max: string }>>({});
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [hoveredRuleId, setHoveredRuleId] = useState<string | null>(null);

  // The signature line: has today's pre-session "hold to accept" been done?
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);
  const riskAcceptedToday = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const checklist = preSessionHistory?.[today]?.checklistState as Record<string, unknown> | undefined;
    return Boolean(checklist?.['risk-accepted']);
  }, [preSessionHistory]);

  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const firstRulesMountRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // Flush any pending state immediately so rule changes survive navigation.
      void flushSupabaseStoreNow();
    };
  }, []);

  const persistState = useCallback(async () => {
    const currentState = useFlyxaStore.getState();
    try {
      await saveStoreStatePatchNow({
        riskRules: currentState.riskRules,
        riskRulesUpdatedAt: currentState.riskRulesUpdatedAt,
      });
      const savedAt = new Date();
      setLastSaved(savedAt);
      setNow(savedAt.getTime());
    } catch {
      pushToast({
        tone: 'red',
        durationMs: 4000,
        message: 'Risk rules could not sync. Your local changes are still preserved.',
      });
    }
  }, []);

  // Risk rules changes — separate debounced save that does NOT call hydrateSharedData,
  // breaking the infinite-loop where hydrateSharedData creates a new riskRules reference
  // which re-triggers this effect.
  useEffect(() => {
    if (firstRulesMountRef.current) { firstRulesMountRef.current = false; return; }
    const timer = setTimeout(() => {
      void saveStoreStatePatchNow({
        riskRules: storeRiskRules,
        riskRulesUpdatedAt: useFlyxaStore.getState().riskRulesUpdatedAt,
      }).catch(() => {
        pushToast({ tone: 'red', durationMs: 4000, message: 'Risk rules could not sync. Your changes are saved locally.' });
      });
    }, 650);
    return () => clearTimeout(timer);
  }, [storeRiskRules]);

  const lastSavedLabel = useMemo(() => formatLastSaved(lastSaved, now), [lastSaved, now]);
  const activeRuleCount = useMemo(
    () => riskRules.filter(rule => rule.enabled !== false).length,
    [riskRules]
  );
  const automaticRuleCount = useMemo(
    () => riskRules.filter(rule => rule.enabled !== false && (rule.kind ?? 'manual') !== 'manual').length,
    [riskRules]
  );

  // Last-30-day adherence report for displaying per-rule breach stats.
  const planReport = useMemo(() => {
    const today = new Date();
    const ago = new Date(today);
    ago.setDate(ago.getDate() - 30);
    const bounds: [string, string] = [
      ago.toISOString().slice(0, 10),
      today.toISOString().slice(0, 10),
    ];
    return buildPlanAdherenceReport(journalEntries, riskRules, { bounds });
  }, [journalEntries, riskRules]);

  const ruleStatsMap = useMemo(() => {
    const map = new Map<string, { checked: number; passed: number; failed: number; pct: number | null }>();
    for (const day of planReport.daily) {
      for (const ev of day.evaluations) {
        if (ev.state === 'unchecked') continue;
        const s = map.get(ev.ruleId) ?? { checked: 0, passed: 0, failed: 0, pct: null };
        s.checked++;
        if (ev.state === 'ok') s.passed++;
        else s.failed++;
        s.pct = Math.round((s.passed / s.checked) * 100);
        map.set(ev.ruleId, s);
      }
    }
    return map;
  }, [planReport]);

  const totalBreaks = useMemo(
    () => planReport.daily.reduce((s, d) => s + d.failed, 0),
    [planReport],
  );

  const checkedDays = useMemo(
    () => planReport.daily.filter(day => day.evaluations.some(ev => ev.state !== 'unchecked')),
    [planReport],
  );

  const adherenceColor = planReport.pct === null ? 'var(--txt-3)'
    : planReport.pct >= 80 ? 'var(--green)'
    : planReport.pct >= 60 ? 'var(--amber)'
    : 'var(--red)';

  const worstRule = useMemo(() => {
    let worst: { label: string; pct: number } | null = null;
    for (const rule of riskRules) {
      if (rule.enabled === false || (rule.kind ?? 'manual') === 'manual') continue;
      const stats = ruleStatsMap.get(rule.id);
      if (!stats || stats.checked === 0 || stats.pct === null) continue;
      if (!worst || stats.pct < worst.pct) worst = { label: rule.label, pct: stats.pct };
    }
    return worst;
  }, [riskRules, ruleStatsMap]);

  const resetPlan = () => {
    useFlyxaStore.getState().updateRiskRules(DEFAULT_STRUCTURED_RULES);
  };

  const updateRiskRule = (id: string, updates: Partial<RiskRule>) => {
    const current = useFlyxaStore.getState().riskRules;
    const updated = current.map(rule => rule.id === id ? { ...rule, ...updates } : rule);
    useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
  };

  const RULE_KIND_LABELS: Record<NonNullable<RiskRule['kind']>, string> = {
    max_daily_loss:     'Maximum daily loss',
    max_trades:         'Maximum trades per day',
    max_contracts:      'Maximum contracts',
    min_rr:             'Minimum planned R:R',
    time_window:        'Allowed trading window',
    cooldown_after_loss:'Cooldown after loss',
    manual:             'Manual check',
  };

  const changeRiskRuleKind = (rule: RiskRule, kind: NonNullable<RiskRule['kind']>) => {
    const previousKindLabel = rule.kind ? RULE_KIND_LABELS[rule.kind] : RULE_KIND_LABELS.manual;
    const keepCustomManualLabel = kind === 'manual'
      && rule.label.trim()
      && rule.label !== previousKindLabel
      && !Object.values(RULE_KIND_LABELS).includes(rule.label);

    updateRiskRule(rule.id, {
      kind,
      label: keepCustomManualLabel ? rule.label : kind === 'manual' ? 'New custom rule' : RULE_KIND_LABELS[kind],
      value: kind === 'manual' ? (rule.value ?? '') : rule.value,
      unit: kind === 'manual' ? '' : rule.unit,
      color: kind === 'manual' ? 'neutral' : rule.color,
    });
  };

  const addRiskRule = () => {
    const id = `rule-${crypto.randomUUID()}`;
    const current = useFlyxaStore.getState().riskRules;
    const updated = [...current, {
      id,
      label: 'New custom rule',
      value: '',
      unit: '',
      color: 'neutral' as const,
      kind: 'manual' as const,
      enabled: true,
    }];
    useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
    setEditingRuleId(id);
  };

  const deleteRiskRule = (id: string) => {
    const current = useFlyxaStore.getState().riskRules;
    const updated = current.filter(rule => rule.id !== id);
    useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
  };

  const setContractLimit = (ruleId: string, symbol: string, max: number) => {
    const current = useFlyxaStore.getState().riskRules;
    const updated = current.map(rule =>
      rule.id === ruleId
        ? { ...rule, contractLimits: { ...(rule.contractLimits ?? {}), [symbol]: max } }
        : rule
    );
    useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
  };

  const removeContractLimit = (ruleId: string, symbol: string) => {
    const current = useFlyxaStore.getState().riskRules;
    const updated = current.map(rule => {
      if (rule.id !== ruleId) return rule;
      const { [symbol]: _, ...rest } = rule.contractLimits ?? {};
      return { ...rule, contractLimits: rest };
    });
    useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
  };

  const commitPendingContract = (ruleId: string) => {
    const pending = pendingContracts[ruleId];
    const sym = pending?.symbol.trim().toUpperCase();
    const max = Number(pending?.max);
    if (!sym || !max || max <= 0) return;
    setContractLimit(ruleId, sym, max);
    setPendingContracts(prev => ({ ...prev, [ruleId]: { symbol: '', max: '' } }));
  };


  return (
    <div className="tp-page">
      <header className="tp-header" data-tour-id="trading-plan-header">
        <div className="tp-header-main">
          <div>
            <p className="tp-eyebrow">Trading Plan</p>
            <h1 className="tp-title">Risk Rules</h1>
          </div>
          <div className="tp-actions">
            <span className="tp-saved">{lastSavedLabel}</span>
            <button type="button" className="tp-btn tp-btn-muted" onClick={resetPlan}>
              <RefreshCw size={12} />
              Reset
            </button>
            <button type="button" className="tp-btn tp-btn-primary" onClick={() => { void persistState(); }}>
              <Save size={12} />
              Save Rules
            </button>
          </div>
        </div>

        <nav className="tp-tabs" data-tour-id="trading-plan-tabs">
          {TAB_ITEMS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`tp-tab ${active ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="tp-content trading-plan-scroll">
        {activeTab === 'rule-adherence' && (
          <section data-tour-id="trading-plan-core" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1080 }}>

            {/* Hero — the verdict number beside the day-by-day record */}
            <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', overflow: 'hidden' }}>
              <div style={{ padding: '18px 20px', borderRight: '1px solid var(--app-border)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <p style={{ margin: 0, fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--txt-3)' }}>
                  Adherence · last 30 days
                </p>
                <p style={{ margin: '8px 0 7px', fontFamily: 'var(--font-mono)', fontSize: 44, fontWeight: 700, lineHeight: 1, letterSpacing: '-0.02em', color: adherenceColor }}>
                  {planReport.pct !== null ? `${planReport.pct}%` : '—'}
                </p>
                <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--txt-2)' }}>
                  {totalBreaks} break{totalBreaks !== 1 ? 's' : ''} across {checkedDays.length} rule-checked day{checkedDays.length !== 1 ? 's' : ''}
                </p>
                <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--txt-3)' }}>
                  {activeRuleCount} active rules · {automaticRuleCount} auto-checked
                </p>
              </div>
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--txt-3)' }}>
                    Day by day
                  </p>
                  <p style={{ margin: 0, fontSize: 10, color: 'var(--txt-3)' }}>
                    <span style={{ color: 'var(--green)' }}>■</span> ≥80% · <span style={{ color: 'var(--amber)' }}>■</span> ≥60% · <span style={{ color: 'var(--red)' }}>■</span> below
                  </p>
                </div>
                {checkedDays.length === 0 ? (
                  <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--txt-3)' }}>
                    No rule-checked sessions in the last 30 days.
                  </p>
                ) : (
                  <div style={{ display: 'flex', gap: 5, marginTop: 12, flexWrap: 'wrap' }}>
                    {checkedDays.map(day => {
                      const checked = day.evaluations.filter(ev => ev.state !== 'unchecked');
                      const passed = checked.filter(ev => ev.state === 'ok').length;
                      const dayPct = checked.length > 0 ? Math.round((passed / checked.length) * 100) : null;
                      const color = dayPct === null ? 'rgba(255,255,255,0.08)'
                        : dayPct >= 80 ? 'var(--green)'
                        : dayPct >= 60 ? 'var(--amber)'
                        : 'var(--red)';
                      return (
                        <span
                          key={day.date}
                          title={`${day.date} · ${dayPct}% adherence · ${day.failed} break${day.failed !== 1 ? 's' : ''}`}
                          style={{ width: 20, height: 20, borderRadius: 4, backgroundColor: color, opacity: 0.85 }}
                        />
                      );
                    })}
                  </div>
                )}
                {worstRule && (
                  <p style={{ margin: '14px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--txt-2)' }}>
                    Most broken: <span style={{ fontWeight: 600, color: 'var(--txt)' }}>{worstRule.label}</span>
                    {' — '}
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--red)' }}>{worstRule.pct}%</span> adherence
                  </p>
                )}
              </div>
            </div>

            {/* Per-rule cells, worst offender first */}
            <div className="tp-panel">
              <div className="tp-section-head">
                <h2>Adherence by rule</h2>
                <p>Checked against your logged trades by the same engine that verifies each journal day.</p>
              </div>
              {(() => {
                const rows = riskRules
                  .filter(rule => rule.enabled !== false && (rule.kind ?? 'manual') !== 'manual')
                  .map(rule => ({ rule, stats: ruleStatsMap.get(rule.id) }))
                  .sort((a, b) => (a.stats?.pct ?? 101) - (b.stats?.pct ?? 101));
                if (rows.length === 0) {
                  return (
                    <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--txt-3)' }}>
                      No auto-checked rules are enabled — turn rules on in the Risk Rules tab and stats appear here.
                    </p>
                  );
                }
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginTop: 14 }}>
                    {rows.map(({ rule, stats }) => {
                      const pct = stats && stats.checked > 0 ? (stats.pct ?? 0) : null;
                      const color = pct === null ? 'var(--txt-3)'
                        : pct >= 80 ? 'var(--green)'
                        : pct >= 60 ? 'var(--amber)'
                        : 'var(--red)';
                      return (
                        <div key={rule.id} style={{ border: '1px solid var(--app-border)', borderRadius: 8, padding: '12px 14px', backgroundColor: 'rgba(255,255,255,0.02)' }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                            <span style={{ minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {rule.label}
                            </span>
                            <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color }}>
                              {pct !== null ? `${pct}%` : '—'}
                            </span>
                          </div>
                          <div style={{ height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginTop: 9 }}>
                            {pct !== null && (
                              <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, backgroundColor: color, opacity: 0.85 }} />
                            )}
                          </div>
                          <p style={{ margin: '8px 0 0', fontSize: 10.5, color: 'var(--txt-3)' }}>
                            {stats && stats.checked > 0
                              ? `${stats.failed} break${stats.failed !== 1 ? 's' : ''} · ${stats.checked} checks`
                              : 'No data yet — trades haven\'t exercised this rule.'}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            <p style={{ margin: 0, fontSize: 10, color: 'var(--txt-3)', lineHeight: 1.5 }}>
              Stats evaluate past sessions against your current rule values — tightening a rule today changes how old sessions score.
            </p>
          </section>
        )}

        {activeTab === 'risk-rules' && (
          <section data-tour-id="risk-rules-framework" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            {/* Rulebook — financial-statement rows: name bold, statement quiet,
                the limit itself as the big right-aligned value. Editing
                collapses behind each row. */}
            <div style={{ border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', overflow: 'hidden' }}>
              {/* Masthead — this is a document, not a settings list */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '15px 18px', borderBottom: '1px solid var(--app-border)' }}>
                <div>
                  <p style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--txt)' }}>
                    The rulebook
                  </p>
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--txt-3)' }}>
                    {activeRuleCount} rule{activeRuleCount !== 1 ? 's' : ''} in force
                    {planReport.pct !== null && (
                      <> · held to <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: adherenceColor }}>{planReport.pct}%</span> over the last 30 days</>
                    )}
                  </p>
                </div>
                <button type="button" className="tp-btn tp-btn-primary" onClick={addRiskRule} style={{ flexShrink: 0 }}>
                  <Plus size={12} /> Add Rule
                </button>
              </div>
              {riskRules.map((rule, ruleIndex) => {
                const kind = rule.kind ?? 'manual';
                const editing = editingRuleId === rule.id;

                const typeLabel =
                  kind === 'manual' ? 'Journal-confirmed · Subjective' :
                  kind === 'max_trades' ? 'Auto-verified · Count' :
                  kind === 'max_contracts' ? 'Auto-verified · Asset' :
                  kind === 'time_window' ? 'Auto-verified · Time' :
                  kind === 'cooldown_after_loss' ? 'Auto-verified · Cooldown' :
                  'Auto-verified · Amount';

                const limits = Object.entries(rule.contractLimits ?? {});
                const name = kind === 'manual'
                  ? (rule.label || 'New custom rule')
                  : RULE_KIND_LABELS[kind];
                const statement =
                  kind === 'max_daily_loss' ? 'I stop trading for the day the moment this is hit.' :
                  kind === 'max_trades' ? 'Once the count is reached, the session is over.' :
                  kind === 'max_contracts' ? (limits.length > 0 ? 'I never size above these caps, win or lose.' : 'No per-instrument caps set yet — add them in edit.') :
                  kind === 'min_rr' ? 'Setups paying less than this are not trades, they are donations.' :
                  kind === 'time_window' ? 'Outside this window I am flat, by rule.' :
                  kind === 'cooldown_after_loss' ? 'After a loss I stand down before the next entry.' :
                  (typeof rule.value === 'string' && rule.value.trim() ? rule.value : 'Confirmed pass/fail in each daily journal.');
                const value =
                  kind === 'max_daily_loss' ? { text: `−${!rule.unit || rule.unit === '$' ? '$' : ''}${rule.value || '—'}${rule.unit && rule.unit !== '$' ? ` ${rule.unit}` : ''}`, color: 'var(--red)' } :
                  kind === 'max_trades' ? { text: `${rule.value || '—'} / day`, color: 'var(--txt)' } :
                  kind === 'max_contracts' ? { text: limits.length > 0 ? limits.map(([sym, max]) => `${max} ${sym}`).join(' · ') : '—', color: 'var(--txt)' } :
                  kind === 'min_rr' ? { text: `1:${rule.value || '—'}`, color: 'var(--txt)' } :
                  kind === 'time_window' ? { text: `${rule.startTime ?? '09:30'}–${rule.endTime ?? '16:00'}`, color: 'var(--txt)' } :
                  kind === 'cooldown_after_loss' ? { text: `${rule.value || '—'} min`, color: 'var(--txt)' } :
                  null;

                return (
                  <div key={rule.id} style={{
                    borderTop: ruleIndex === 0 ? 'none' : '1px solid var(--app-border)',
                    opacity: rule.enabled === false ? 0.45 : 1,
                    transition: 'opacity 0.15s ease',
                  }}>
                    <div
                      onMouseEnter={() => setHoveredRuleId(rule.id)}
                      onMouseLeave={() => setHoveredRuleId(current => (current === rule.id ? null : current))}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px',
                        backgroundColor: hoveredRuleId === rule.id ? 'rgba(255,255,255,0.02)' : 'transparent',
                        transition: 'background-color 0.13s ease',
                      }}
                    >
                      <span style={{
                        flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
                        color: hoveredRuleId === rule.id ? 'var(--amber)' : 'var(--txt-3)',
                        letterSpacing: '0.05em', transition: 'color 0.13s ease',
                      }}>
                        {String(ruleIndex + 1).padStart(2, '0')}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 13.5, fontWeight: 650, color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {name}
                        </p>
                        <p style={{ margin: '3px 0 0', fontSize: 11, lineHeight: 1.5, color: 'var(--txt-3)' }}>
                          {statement}
                        </p>
                      </div>
                      {value ? (
                        <span style={{
                          flexShrink: 0, textAlign: 'right',
                          fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 700,
                          letterSpacing: '-0.01em', color: value.color, whiteSpace: 'nowrap',
                        }}>
                          {value.text}
                        </span>
                      ) : (
                        <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--txt-3)', border: '1px solid var(--app-border)', borderRadius: 3, padding: '3px 7px' }}>
                          Journal check
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditingRuleId(editing ? null : rule.id)}
                        style={{ flexShrink: 0, background: 'none', border: 'none', color: editing ? 'var(--amber)' : 'var(--txt-3)', fontSize: 11, cursor: 'pointer', padding: '4px 2px' }}
                      >
                        {editing ? 'done' : 'edit'}
                      </button>
                      <div className="tp-rcard-hdr-actions" style={{ flexShrink: 0 }}>
                        <label className="tp-rcard-toggle">
                          <input
                            type="checkbox"
                            checked={rule.enabled !== false}
                            onChange={e => updateRiskRule(rule.id, { enabled: e.target.checked })}
                          />
                          <span className="tp-toggle-track">
                            <span className="tp-toggle-thumb" />
                          </span>
                        </label>
                        <button type="button" className="tp-rule-delete" onClick={() => deleteRiskRule(rule.id)} title="Remove rule">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    {editing && (
                    <div style={{ padding: '0 18px 16px 42px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <select
                          className="tp-rcard-kind"
                          value={kind}
                          onChange={e => changeRiskRuleKind(rule, e.target.value as NonNullable<RiskRule['kind']>)}
                        >
                          <option value="max_daily_loss">Max daily loss</option>
                          <option value="max_trades">Max trades / day</option>
                          <option value="max_contracts">Max contracts</option>
                          <option value="min_rr">Min R:R</option>
                          <option value="time_window">Time window</option>
                          <option value="cooldown_after_loss">Cooldown after loss</option>
                          <option value="manual">Manual check</option>
                        </select>
                        <span className="tp-rcard-type-label">{typeLabel}</span>
                      </div>
                    <div className="tp-rcard-body">
                      {kind === 'time_window' ? (
                        <div className="tp-rcard-fields">
                          <label className="tp-rcard-field">
                            <span className="tp-rcard-field-lbl">Start</span>
                            <input className="tp-rule-input" type="time" value={rule.startTime ?? '09:30'} onChange={e => updateRiskRule(rule.id, { startTime: e.target.value })} />
                          </label>
                          <label className="tp-rcard-field">
                            <span className="tp-rcard-field-lbl">End</span>
                            <input className="tp-rule-input" type="time" value={rule.endTime ?? '11:30'} onChange={e => updateRiskRule(rule.id, { endTime: e.target.value })} />
                          </label>
                        </div>
                      ) : kind === 'max_contracts' ? (
                        <div className="tp-contract-limits">
                          {Object.entries(rule.contractLimits ?? {}).length === 0 && (
                            <p className="tp-contract-empty">No limits set — add an asset below.</p>
                          )}
                          {Object.entries(rule.contractLimits ?? {}).map(([sym, max]) => {
                            const contract = lookupContract(sym);
                            return (
                              <div key={sym} className="tp-contract-row">
                                <div className="tp-contract-sym-info">
                                  <span className="tp-contract-sym-name">{sym}</span>
                                  {contract && <span className="tp-contract-sym-full">{contract.name.replace(' Futures', '')}</span>}
                                </div>
                                <div className="tp-contract-stepper">
                                  <button type="button" className="tp-contract-step-btn" onClick={() => setContractLimit(rule.id, sym, Math.max(1, max - 1))}>−</button>
                                  <input
                                    type="number"
                                    className="tp-contract-value-input num"
                                    min={1}
                                    value={max}
                                    onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setContractLimit(rule.id, sym, v); }}
                                  />
                                  <button type="button" className="tp-contract-step-btn" onClick={() => setContractLimit(rule.id, sym, max + 1)}>+</button>
                                </div>
                                <button type="button" className="tp-contract-remove" title="Remove" onClick={() => removeContractLimit(rule.id, sym)}>
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            );
                          })}
                          <div className="tp-contract-add-section">
                            <span className="tp-contract-add-label">Add asset</span>
                            <div className="tp-contract-add-row">
                              <input
                                className="tp-rule-input tp-contract-sym-input"
                                placeholder="Symbol (e.g. MNQ)"
                                value={pendingContracts[rule.id]?.symbol ?? ''}
                                onChange={e => setPendingContracts(prev => ({ ...prev, [rule.id]: { ...prev[rule.id], symbol: e.target.value.toUpperCase() } }))}
                                onKeyDown={e => { if (e.key === 'Enter') commitPendingContract(rule.id); }}
                              />
                              <input
                                className="tp-rule-input num"
                                type="number" min="1" step="1"
                                placeholder="Max"
                                value={pendingContracts[rule.id]?.max ?? ''}
                                onChange={e => setPendingContracts(prev => ({ ...prev, [rule.id]: { ...prev[rule.id], max: e.target.value } }))}
                                onKeyDown={e => { if (e.key === 'Enter') commitPendingContract(rule.id); }}
                              />
                              <button type="button" className="tp-contract-add-btn" onClick={() => commitPendingContract(rule.id)}>Add</button>
                            </div>
                            {topSymbols.filter(sym => !(rule.contractLimits ?? {})[sym]).length > 0 && (
                              <div className="tp-contract-quick">
                                {topSymbols.filter(sym => !(rule.contractLimits ?? {})[sym]).map(sym => {
                                  const c = lookupContract(sym);
                                  return (
                                    <button key={sym} type="button" className="tp-contract-chip" onClick={() => setContractLimit(rule.id, sym, 1)}>
                                      <Plus size={9} />
                                      <span className="tp-contract-chip-sym">{sym}</span>
                                      {c && <span className="tp-contract-chip-name">{c.name.replace(' Futures', '')}</span>}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : kind === 'manual' ? (
                        <div className="tp-manual-rule-fields">
                          <label>
                            <span>Rule</span>
                            <input
                              className="tp-rule-input tp-rule-name-input"
                              value={rule.label}
                              placeholder="e.g. No trades outside my planned setup"
                              onChange={e => updateRiskRule(rule.id, { label: e.target.value })}
                            />
                          </label>
                          <label>
                            <span>Notes / confirmation prompt</span>
                            <textarea
                              className="tp-rule-input tp-rule-textarea"
                              value={rule.value}
                              placeholder="Optional: what counts as passing or breaking this rule?"
                              onChange={e => updateRiskRule(rule.id, { value: e.target.value })}
                            />
                          </label>
                          <p className="tp-rule-manual-note">This custom rule appears in each daily journal for pass/fail confirmation.</p>
                        </div>
                      ) : (
                        <div className="tp-rcard-fields">
                          <label className="tp-rcard-field">
                            <span className="tp-rcard-field-lbl">Limit</span>
                            <input className="tp-rule-input num" type="number" min="0" step="0.1" value={rule.value} onChange={e => updateRiskRule(rule.id, { value: e.target.value })} />
                          </label>
                          <label className="tp-rcard-field">
                            <span className="tp-rcard-field-lbl">Unit</span>
                            <input className="tp-rule-input" value={rule.unit} onChange={e => updateRiskRule(rule.id, { unit: e.target.value })} />
                          </label>
                        </div>
                      )}
                    </div>
                    </div>
                    )}
                  </div>
                );
              })}

              {/* Signature line — a contract is either in force or it isn't */}
              <div style={{ borderTop: '1px solid var(--app-border)', padding: '11px 18px', display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, color: riskAcceptedToday ? 'var(--green)' : 'var(--txt-3)' }}>
                  {riskAcceptedToday ? '✓' : '·'}
                </span>
                <span style={{ fontSize: 11, fontStyle: 'italic', lineHeight: 1.5, color: riskAcceptedToday ? 'var(--txt-2)' : 'var(--txt-3)' }}>
                  {riskAcceptedToday
                    ? 'Accepted at pre-session — these rules are in force today.'
                    : 'Not yet accepted today — you sign these at pre-session launch.'}
                </span>
              </div>
            </div>

            {/* Footnote */}
            <p style={{ margin: 0, fontSize: 10, color: 'var(--txt-3)', lineHeight: 1.5 }}>
              Flyxa verifies only rules supported by logged trade data. Missing timestamps or values remain unverified.
            </p>
            </div>

            {/* Right rail — the rulebook's consequences, not decoration */}
            <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--app-border)' }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--txt)' }}>Held to — last 30 days</p>
                </div>
                <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 32, fontWeight: 700, lineHeight: 1, color: adherenceColor }}>
                    {planReport.pct !== null ? `${planReport.pct}%` : '—'}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--txt-3)' }}>
                    adherence · {totalBreaks} break{totalBreaks !== 1 ? 's' : ''}
                  </span>
                </div>
                {worstRule && (
                  <div style={{ padding: '10px 16px', borderTop: '1px solid var(--app-border)' }}>
                    <p style={{ margin: 0, fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--txt-3)' }}>Most broken</p>
                    <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--txt-2)' }}>
                      {worstRule.label} — <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--red)' }}>{worstRule.pct}%</span>
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setActiveTab('rule-adherence')}
                  style={{
                    width: '100%', textAlign: 'left', cursor: 'pointer',
                    border: 'none', borderTop: '1px solid var(--app-border)',
                    background: 'none', padding: '10px 16px',
                    fontSize: 11, fontWeight: 600, color: 'var(--amber)',
                  }}
                >
                  View full adherence →
                </button>
              </div>

              <div style={{ border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', padding: '12px 16px' }}>
                <p style={{ margin: 0, fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--txt-3)' }}>
                  Where these rules act
                </p>
                <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 7 }}>
                  <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: 'var(--txt-3)' }}>
                    <span style={{ color: 'var(--txt-2)', fontWeight: 600 }}>Pre-session</span> — you accept these limits before every launch.
                  </p>
                  <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: 'var(--txt-3)' }}>
                    <span style={{ color: 'var(--txt-2)', fontWeight: 600 }}>Live session</span> — warnings fire as a limit approaches.
                  </p>
                  <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: 'var(--txt-3)' }}>
                    <span style={{ color: 'var(--txt-2)', fontWeight: 600 }}>Journal</span> — every day is verified against them.
                  </p>
                </div>
              </div>
            </aside>
            </div>

          </section>
        )}
      </main>
    </div>
  );
}
