import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import type { RiskRule } from '../store/types.js';
import { saveStoreStatePatchNow, flushSupabaseStoreNow } from '../store/supabaseStorage.js';
import { pushToast } from '../store/toastStore.js';
import { DEFAULT_STRUCTURED_RULES, normalizeRiskRule } from '../utils/tradingRules.js';
import { buildPlanAdherenceReport } from '../utils/planAdherence.js';
import { useDailyJournalStreak } from '../utils/journalStreak.js';
import StreakFlame from '../components/common/StreakFlame.js';
import { lookupContract } from '../constants/futuresContracts.js';
import './TradingPlan.css';

const ADHERENCE_TARGET = 80;

interface DisciplineDay {
  date: string;
  label: string;
  pct: number | null;
  passed: number;
  checkedCount: number;
  failed: number;
  isToday: boolean;
}

const RULE_KIND_LABELS: Record<NonNullable<RiskRule['kind']>, string> = {
  max_daily_loss:      'Maximum daily loss',
  max_trades:          'Maximum trades per day',
  max_contracts:       'Maximum contracts',
  min_rr:              'Minimum planned R:R',
  time_window:         'Allowed trading window',
  cooldown_after_loss: 'Cooldown after loss',
  manual:              'Manual check',
};

// Small, quiet settings switch — muted amber on-state, not a full-brightness
// iOS toggle (those read as decoration).
function MiniToggle({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: 30, height: 17, borderRadius: 10, border: 'none', position: 'relative',
        cursor: 'pointer', flexShrink: 0, padding: 0,
        background: on ? 'rgba(245,158,11,0.5)' : 'rgba(255,255,255,0.12)',
        transition: 'background .15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? 15 : 2, width: 13, height: 13, borderRadius: '50%',
        background: on ? 'var(--amber)' : '#9a958c', transition: 'left .15s, background .15s',
      }} />
    </button>
  );
}

export default function TradingPlan() {
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
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([sym]) => sym);
  }, [journalEntries]);

  const [pendingContracts, setPendingContracts] = useState<Record<string, { symbol: string; max: string }>>({});
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const firstRulesMountRef = useRef(true);

  useEffect(() => {
    return () => { void flushSupabaseStoreNow(); };
  }, []);

  const persistState = useCallback(async () => {
    const currentState = useFlyxaStore.getState();
    try {
      await saveStoreStatePatchNow({
        riskRules: currentState.riskRules,
        riskRulesUpdatedAt: currentState.riskRulesUpdatedAt,
      });
      setDirty(false);
    } catch {
      pushToast({ tone: 'red', durationMs: 4000, message: 'Risk rules could not sync. Your local changes are still preserved.' });
    }
  }, []);

  // Debounced auto-save on any rule change. Marks the header dirty immediately,
  // clears it once the save lands.
  useEffect(() => {
    if (firstRulesMountRef.current) { firstRulesMountRef.current = false; return; }
    setDirty(true);
    const timer = setTimeout(() => {
      void saveStoreStatePatchNow({
        riskRules: storeRiskRules,
        riskRulesUpdatedAt: useFlyxaStore.getState().riskRulesUpdatedAt,
      })
        .then(() => setDirty(false))
        .catch(() => pushToast({ tone: 'red', durationMs: 4000, message: 'Risk rules could not sync. Your changes are saved locally.' }));
    }, 650);
    return () => clearTimeout(timer);
  }, [storeRiskRules]);

  const activeRuleCount = useMemo(() => riskRules.filter(rule => rule.enabled !== false).length, [riskRules]);

  const planReport = useMemo(() => {
    const today = new Date();
    // Walk back to the 30th trading day (weekends excluded) so the window
    // covers exactly the 30 weekday cells shown in the discipline heatmap.
    const start = new Date(today);
    let weekdays = 0;
    while (weekdays < 30) {
      const dow = start.getDay();
      if (dow !== 0 && dow !== 6) weekdays += 1;
      if (weekdays < 30) start.setDate(start.getDate() - 1);
    }
    const bounds: [string, string] = [start.toISOString().slice(0, 10), today.toISOString().slice(0, 10)];
    return buildPlanAdherenceReport(journalEntries, riskRules, { bounds });
  }, [journalEntries, riskRules]);

  const ruleStatsMap = useMemo(() => {
    const map = new Map<string, { checked: number; passed: number; failed: number; pct: number | null }>();
    for (const day of planReport.daily) {
      for (const ev of day.evaluations) {
        if (ev.state === 'unchecked') continue;
        const s = map.get(ev.ruleId) ?? { checked: 0, passed: 0, failed: 0, pct: null };
        s.checked++;
        if (ev.state === 'ok') s.passed++; else s.failed++;
        s.pct = Math.round((s.passed / s.checked) * 100);
        map.set(ev.ruleId, s);
      }
    }
    return map;
  }, [planReport]);

  const totalBreaks = useMemo(() => planReport.daily.reduce((s, d) => s + d.failed, 0), [planReport]);
  const checkedDays = useMemo(() => planReport.daily.filter(day => day.evaluations.some(ev => ev.state !== 'unchecked')), [planReport]);

  const adherenceColor = planReport.pct === null ? 'var(--txt-3)'
    : planReport.pct >= 80 ? 'var(--green)'
    : planReport.pct >= 60 ? 'var(--amber)'
    : 'var(--red)';

  const daySeries = useMemo(() => {
    const byDate = new Map(planReport.daily.map(day => [day.date, day]));
    const todayKey = new Date().toISOString().slice(0, 10);
    // Walk back collecting the last 30 trading days (markets are closed on
    // weekends, so Sat/Sun never count toward daily discipline).
    const weekdays: Date[] = [];
    const cursor = new Date();
    while (weekdays.length < 30) {
      const dow = cursor.getDay();
      if (dow !== 0 && dow !== 6) weekdays.push(new Date(cursor));
      cursor.setDate(cursor.getDate() - 1);
    }
    weekdays.reverse(); // oldest first
    const series: DisciplineDay[] = weekdays.map(d => {
      const key = d.toISOString().slice(0, 10);
      const report = byDate.get(key);
      const checked = report ? report.evaluations.filter(ev => ev.state !== 'unchecked') : [];
      const passed = checked.filter(ev => ev.state === 'ok').length;
      return {
        date: key,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        pct: checked.length > 0 ? Math.round((passed / checked.length) * 100) : null,
        passed,
        checkedCount: checked.length,
        failed: checked.length - passed,
        isToday: key === todayKey,
      };
    });
    return series;
  }, [planReport]);

  const todayStats = daySeries[daySeries.length - 1];

  // Per-day rule verdicts (click a cell) and per-rule verdicts keyed by date
  // (click a rule to recolor the heatmap).
  const dayEvalMap = useMemo(() => {
    const map = new Map<string, Array<{ ruleId: string; state: 'ok' | 'fail' }>>();
    for (const day of planReport.daily) {
      const checked = day.evaluations
        .filter(ev => ev.state !== 'unchecked')
        .map(ev => ({ ruleId: ev.ruleId, state: (ev.state === 'ok' ? 'ok' : 'fail') as 'ok' | 'fail' }));
      if (checked.length > 0) map.set(day.date, checked);
    }
    return map;
  }, [planReport]);

  // Today's per-rule verification, driving the rulebook status column.
  const todayRuleStates = useMemo(() => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const map = new Map<string, 'ok' | 'fail'>();
    for (const ev of dayEvalMap.get(todayKey) ?? []) map.set(ev.ruleId, ev.state);
    return map;
  }, [dayEvalMap]);

  // Mirror the Daily Journal streak so the two never disagree.
  const journalStreak = useDailyJournalStreak();

  const resetPlan = () => useFlyxaStore.getState().updateRiskRules(DEFAULT_STRUCTURED_RULES);

  const updateRiskRule = (id: string, updates: Partial<RiskRule>) => {
    const current = useFlyxaStore.getState().riskRules;
    useFlyxaStore.getState().updateRiskRules(current.map(rule => rule.id === id ? { ...rule, ...updates } : rule) as RiskRule[]);
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
    useFlyxaStore.getState().updateRiskRules([...current, {
      id, label: 'New custom rule', value: '', unit: '', color: 'neutral' as const, kind: 'manual' as const, enabled: true,
    }] as RiskRule[]);
    setEditingRuleId(id);
  };

  const deleteRiskRule = (id: string) => {
    const current = useFlyxaStore.getState().riskRules;
    useFlyxaStore.getState().updateRiskRules(current.filter(rule => rule.id !== id) as RiskRule[]);
  };

  const setContractLimit = (ruleId: string, symbol: string, max: number) => {
    const current = useFlyxaStore.getState().riskRules;
    useFlyxaStore.getState().updateRiskRules(current.map(rule =>
      rule.id === ruleId ? { ...rule, contractLimits: { ...(rule.contractLimits ?? {}), [symbol]: max } } : rule
    ) as RiskRule[]);
  };

  const removeContractLimit = (ruleId: string, symbol: string) => {
    const current = useFlyxaStore.getState().riskRules;
    useFlyxaStore.getState().updateRiskRules(current.map(rule => {
      if (rule.id !== ruleId) return rule;
      const { [symbol]: _, ...rest } = rule.contractLimits ?? {};
      return { ...rule, contractLimits: rest };
    }) as RiskRule[]);
  };

  const commitPendingContract = (ruleId: string) => {
    const pending = pendingContracts[ruleId];
    const sym = pending?.symbol.trim().toUpperCase();
    const max = Number(pending?.max);
    if (!sym || !max || max <= 0) return;
    setContractLimit(ruleId, sym, max);
    setPendingContracts(prev => ({ ...prev, [ruleId]: { symbol: '', max: '' } }));
  };

  // Shared card chrome
  const card: React.CSSProperties = { background: 'var(--app-panel)', border: '1px solid var(--app-border)', borderRadius: 12, overflow: 'hidden' };
  const lbl: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '1.4px', textTransform: 'uppercase', color: 'var(--txt-3)' };

  return (
    <div className="tp-page">
      {/* ── Page header ── */}
      <header className="tp-header" data-tour-id="trading-plan-header">
        <div className="tp-header-main">
          <div>
            <h1 className="tp-title">Rules</h1>
            <div style={{ marginTop: 7, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--txt-3)' }}>
              <i style={{ fontStyle: 'normal', color: 'var(--txt)' }}>{activeRuleCount}</i> rule{activeRuleCount !== 1 ? 's' : ''} in force
            </div>
          </div>
          <div className="tp-actions" style={{ alignItems: 'center' }}>
            {dirty ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.8px', color: 'var(--amber)' }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--amber)' }} /> UNSAVED CHANGES
              </span>
            ) : (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.8px', color: 'var(--txt-3)' }}>ALL CHANGES SAVED</span>
            )}
            <button type="button" className="tp-btn tp-btn-muted" onClick={resetPlan}>Reset</button>
            <button type="button" className="tp-btn tp-btn-primary" onClick={() => { void persistState(); }}>Save rules</button>
          </div>
        </div>
      </header>

      <main className="tp-content trading-plan-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* ── The rulebook — a table ── */}
        <section data-tour-id="risk-rules-framework" style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 20px', borderBottom: '1px solid var(--app-border)' }}>
            <b style={{ fontSize: 13.5, fontWeight: 600 }}>The rulebook</b>
            <button type="button" onClick={addRiskRule} style={{ background: 'none', border: 'none', fontSize: 12, fontWeight: 600, color: 'var(--txt-2)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Plus size={12} /> Add rule
            </button>
          </div>

          {riskRules.map((rule, ruleIndex) => {
            const kind = rule.kind ?? 'manual';
            const editing = editingRuleId === rule.id;
            const limits = Object.entries(rule.contractLimits ?? {});
            const name = kind === 'manual' ? (rule.label || 'New custom rule') : RULE_KIND_LABELS[kind];
            const statement =
              kind === 'max_daily_loss' ? 'I stop trading for the day the moment this is hit.' :
              kind === 'max_trades' ? 'Once the count is reached, the session is over.' :
              kind === 'max_contracts' ? (limits.length > 0 ? 'I never size above these caps, win or lose.' : 'No per-instrument caps set yet — add them in edit.') :
              kind === 'min_rr' ? 'Setups paying less than this are not trades, they are donations.' :
              kind === 'time_window' ? 'Outside this window I am flat, by rule.' :
              kind === 'cooldown_after_loss' ? 'After a loss I stand down before the next entry.' :
              (typeof rule.value === 'string' && rule.value.trim() ? rule.value : 'Confirmed pass/fail in each daily journal.');
            const valueText =
              kind === 'max_daily_loss' ? `−${!rule.unit || rule.unit === '$' ? '$' : ''}${rule.value || '—'}${rule.unit && rule.unit !== '$' ? ` ${rule.unit}` : ''}` :
              kind === 'max_trades' ? `${rule.value || '—'}` :
              kind === 'max_contracts' ? (limits.length > 0 ? limits.map(([sym, max]) => `${max} ${sym}`).join(' · ') : '—') :
              kind === 'min_rr' ? `1:${rule.value || '—'}` :
              kind === 'time_window' ? `${rule.startTime ?? '09:30'}–${rule.endTime ?? '16:00'}` :
              kind === 'cooldown_after_loss' ? `${rule.value || '—'} min` :
              'Journal check';
            const unitCaption =
              kind === 'max_daily_loss' || kind === 'max_trades' ? 'PER DAY' :
              kind === 'time_window' ? 'NY TIME' :
              kind === 'cooldown_after_loss' ? 'AFTER LOSS' :
              'PER TRADE';

            const today = todayRuleStates.get(rule.id);
            const typeLabel =
              kind === 'manual' ? 'Journal-confirmed · Subjective' :
              kind === 'max_trades' ? 'Auto-verified · Count' :
              kind === 'max_contracts' ? 'Auto-verified · Asset' :
              kind === 'time_window' ? 'Auto-verified · Time' :
              kind === 'cooldown_after_loss' ? 'Auto-verified · Cooldown' :
              'Auto-verified · Amount';

            return (
              <div key={rule.id} style={{ borderTop: ruleIndex === 0 ? 'none' : '1px solid rgba(255,255,255,0.05)', opacity: rule.enabled === false ? 0.5 : 1, transition: 'opacity .15s' }}>
                <div className="tp-rr">
                  {/* Rule + commitment line */}
                  <div className="tp-rr-name" style={{ minWidth: 0 }}>
                    <b style={{ fontSize: 13.5, fontWeight: 600, display: 'block', letterSpacing: '-0.1px', color: 'var(--txt)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</b>
                    <span style={{ fontSize: 12, color: 'var(--txt-3)', display: 'block', marginTop: 2, lineHeight: 1.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statement}</span>
                  </div>
                  {/* Value — neutral mono + unit caption */}
                  <div className="tp-rr-value" style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>
                    {valueText}
                    <small style={{ display: 'block', fontSize: 9, color: 'var(--txt-3)', letterSpacing: '0.8px', marginTop: 3 }}>{unitCaption}</small>
                  </div>
                  {/* Verification status */}
                  <span className="tp-rr-status" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '1px', color: today === 'fail' ? 'var(--red)' : today === 'ok' ? 'var(--txt-2)' : 'var(--txt-3)' }}>
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: today === 'fail' ? 'var(--red)' : today === 'ok' ? 'var(--green)' : 'rgba(255,255,255,0.18)' }} />
                    {today === 'fail' ? 'BROKEN' : today === 'ok' ? 'HELD' : '—'}
                  </span>
                  {/* Controls */}
                  <div className="tp-rr-controls" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <button type="button" onClick={() => setEditingRuleId(editing ? null : rule.id)} style={{ background: 'none', border: 'none', fontFamily: 'var(--font-mono)', fontSize: 10, color: editing ? 'var(--amber)' : 'var(--txt-3)', cursor: 'pointer', padding: 0, letterSpacing: '.5px' }}>
                      {editing ? 'DONE' : 'EDIT'}
                    </button>
                    <MiniToggle on={rule.enabled !== false} onChange={value => updateRiskRule(rule.id, { enabled: value })} />
                  </div>
                </div>

                {editing && (
                  <div style={{ padding: '0 20px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <select className="tp-rcard-kind" value={kind} onChange={e => changeRiskRuleKind(rule, e.target.value as NonNullable<RiskRule['kind']>)}>
                        <option value="max_daily_loss">Max daily loss</option>
                        <option value="max_trades">Max trades / day</option>
                        <option value="max_contracts">Max contracts</option>
                        <option value="min_rr">Min R:R</option>
                        <option value="time_window">Time window</option>
                        <option value="cooldown_after_loss">Cooldown after loss</option>
                        <option value="manual">Manual check</option>
                      </select>
                      <span className="tp-rcard-type-label">{typeLabel}</span>
                      <button type="button" className="tp-rule-delete" onClick={() => deleteRiskRule(rule.id)} title="Remove rule" style={{ marginLeft: 'auto' }}>
                        <Trash2 size={13} />
                      </button>
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
                          {Object.entries(rule.contractLimits ?? {}).length === 0 && <p className="tp-contract-empty">No limits set — add an asset below.</p>}
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
                                  <input type="number" className="tp-contract-value-input num" min={1} value={max} onChange={e => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setContractLimit(rule.id, sym, v); }} />
                                  <button type="button" className="tp-contract-step-btn" onClick={() => setContractLimit(rule.id, sym, max + 1)}>+</button>
                                </div>
                                <button type="button" className="tp-contract-remove" title="Remove" onClick={() => removeContractLimit(rule.id, sym)}><Trash2 size={13} /></button>
                              </div>
                            );
                          })}
                          <div className="tp-contract-add-section">
                            <span className="tp-contract-add-label">Add asset</span>
                            <div className="tp-contract-add-row">
                              <input className="tp-rule-input tp-contract-sym-input" placeholder="Symbol (e.g. MNQ)" value={pendingContracts[rule.id]?.symbol ?? ''} onChange={e => setPendingContracts(prev => ({ ...prev, [rule.id]: { ...prev[rule.id], symbol: e.target.value.toUpperCase() } }))} onKeyDown={e => { if (e.key === 'Enter') commitPendingContract(rule.id); }} />
                              <input className="tp-rule-input num" type="number" min="1" step="1" placeholder="Max" value={pendingContracts[rule.id]?.max ?? ''} onChange={e => setPendingContracts(prev => ({ ...prev, [rule.id]: { ...prev[rule.id], max: e.target.value } }))} onKeyDown={e => { if (e.key === 'Enter') commitPendingContract(rule.id); }} />
                              <button type="button" className="tp-contract-add-btn" onClick={() => commitPendingContract(rule.id)}>Add</button>
                            </div>
                            {topSymbols.filter(sym => !(rule.contractLimits ?? {})[sym]).length > 0 && (
                              <div className="tp-contract-quick">
                                {topSymbols.filter(sym => !(rule.contractLimits ?? {})[sym]).map(sym => {
                                  const c = lookupContract(sym);
                                  return (
                                    <button key={sym} type="button" className="tp-contract-chip" onClick={() => setContractLimit(rule.id, sym, 1)}>
                                      <Plus size={9} /><span className="tp-contract-chip-sym">{sym}</span>{c && <span className="tp-contract-chip-name">{c.name.replace(' Futures', '')}</span>}
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
                            <input className="tp-rule-input tp-rule-name-input" value={rule.label} placeholder="e.g. No trades outside my planned setup" onChange={e => updateRiskRule(rule.id, { label: e.target.value })} />
                          </label>
                          <label>
                            <span>Notes / confirmation prompt</span>
                            <textarea className="tp-rule-input tp-rule-textarea" value={rule.value} placeholder="Optional: what counts as passing or breaking this rule?" onChange={e => updateRiskRule(rule.id, { value: e.target.value })} />
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

        </section>

        {/* ── The record — discipline streak + unified rule table ── */}
        <section data-tour-id="trading-plan-core" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Discipline summary: journal fire streak + adherence headline */}
          <div style={{ ...card, padding: '18px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
              <div>
                <span style={{ ...lbl, display: 'block', marginBottom: 11 }}>Rule discipline streak</span>
                <StreakFlame streak={journalStreak} />
              </div>
              <div style={{ paddingLeft: 22, borderLeft: '1px solid var(--app-border)' }}>
                <span style={lbl}>Held · 30D</span>
                <b style={{ display: 'block', marginTop: 9, fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 500, lineHeight: 1, color: adherenceColor }}>{planReport.pct !== null ? `${planReport.pct}%` : '—'}</b>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 26, fontFamily: 'var(--font-mono)', color: 'var(--txt-3)' }}>
              {[
                { k: 'BREAKS', v: String(totalBreaks), c: totalBreaks > 0 ? 'var(--red)' : 'var(--txt)' },
                { k: 'TRADED DAYS', v: String(checkedDays.length), c: 'var(--txt)' },
                { k: 'TODAY', v: todayStats.checkedCount > 0 ? `${todayStats.passed}/${todayStats.checkedCount}` : '—', c: 'var(--txt)' },
              ].map(m => (
                <span key={m.k} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 9, letterSpacing: '0.1em' }}>{m.k}</span>
                  <b style={{ color: m.c, fontWeight: 500, fontSize: 15 }}>{m.v}</b>
                </span>
              ))}
            </div>
          </div>

          {/* Unified by-rule table: adherence + breaks + cost */}
          <div style={card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 20px', borderBottom: '1px solid var(--app-border)' }}>
              <b style={{ fontSize: 13.5, fontWeight: 600 }}>By rule</b>
              <span style={{ ...lbl, color: 'var(--txt-3)' }}>Worst first</span>
            </div>
            {(() => {
              const cols = 'minmax(150px, 1fr) minmax(120px, 220px) 66px 96px';
              const costByRule = new Map(planReport.brokenRules.map(r => [r.ruleId, r.lossWhenBroken] as const));
              const rows = riskRules
                .filter(rule => rule.enabled !== false && (rule.kind ?? 'manual') !== 'manual')
                .map(rule => ({ rule, stats: ruleStatsMap.get(rule.id) }))
                .sort((a, b) => (a.stats?.pct ?? 101) - (b.stats?.pct ?? 101));
              if (rows.length === 0) {
                return <p style={{ margin: 0, padding: '16px 20px', fontSize: 12, color: 'var(--txt-3)' }}>No auto-checked rules are enabled. Turn rules on above and stats appear here.</p>;
              }
              return (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 16, padding: '9px 20px', borderBottom: '1px solid var(--app-border)', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--txt-3)' }}>
                    <span>Rule</span>
                    <span>Adherence</span>
                    <span style={{ textAlign: 'right' }}>Breaks</span>
                    <span style={{ textAlign: 'right' }}>Cost</span>
                  </div>
                  {rows.map(({ rule, stats }, i) => {
                    const pct = stats && stats.checked > 0 ? (stats.pct ?? 0) : null;
                    const worst = i === 0 && pct !== null && pct < ADHERENCE_TARGET;
                    const cost = costByRule.get(rule.id) ?? 0;
                    return (
                      <div key={rule.id} style={{ display: 'grid', gridTemplateColumns: cols, gap: 16, alignItems: 'center', padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                        <span style={{ minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{rule.label}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                          <div style={{ flex: 1, minWidth: 0, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                            <span style={{ display: 'block', height: '100%', borderRadius: 2, width: `${pct ?? 0}%`, background: worst ? 'var(--red)' : 'var(--green)', opacity: worst ? 0.85 : 0.9 }} />
                          </div>
                          <span style={{ flexShrink: 0, width: 34, textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: worst ? 'var(--red)' : 'var(--txt)', fontVariantNumeric: 'tabular-nums' }}>{pct !== null ? `${pct}%` : '—'}</span>
                        </div>
                        <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: stats && stats.failed > 0 ? 'var(--red)' : 'var(--txt-3)', fontVariantNumeric: 'tabular-nums' }}>{stats && stats.checked > 0 ? stats.failed : '—'}</span>
                        <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 11.5, color: cost > 0 ? 'var(--red)' : 'var(--txt-3)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{cost > 0 ? `−$${Math.round(cost).toLocaleString()}` : '—'}</span>
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>

          <p style={{ margin: 0, fontSize: 10, color: 'var(--txt-3)', lineHeight: 1.5 }}>
            Stats evaluate past sessions against your current rule values. Tightening a rule today changes how old sessions score.
          </p>
        </section>
      </main>
    </div>
  );
}
