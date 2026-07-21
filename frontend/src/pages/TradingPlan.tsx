import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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

// Discipline chart palette — binary verdict per day: amber when every rule
// held, red the moment a single one broke. No partial credit.
const ADHERENCE_TARGET = 80;
const BAR_ON = 'var(--amber)';
const BAR_BREAK = 'var(--red)';
const BAR_EMPTY = 'rgba(255,255,255,0.05)';

interface DisciplineDay {
  date: string;
  label: string;
  pct: number | null;
  passed: number;
  checkedCount: number;
  failed: number;
  isToday: boolean;
}

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
  // Record interactivity: click a day bar to see its rule verdicts; click a
  // ledger rule to replay that single rule's history on the chart.
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [chartRuleId, setChartRuleId] = useState<string | null>(null);

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

  // One entry per calendar day over the last 30 — the discipline chart renders
  // every day, including unverified ones, so gaps in the habit stay visible.
  const daySeries = useMemo(() => {
    const byDate = new Map(planReport.daily.map(day => [day.date, day]));
    const series: DisciplineDay[] = [];
    const today = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const report = byDate.get(key);
      const checked = report ? report.evaluations.filter(ev => ev.state !== 'unchecked') : [];
      const passed = checked.filter(ev => ev.state === 'ok').length;
      series.push({
        date: key,
        label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        pct: checked.length > 0 ? Math.round((passed / checked.length) * 100) : null,
        passed,
        checkedCount: checked.length,
        failed: checked.length - passed,
        isToday: i === 0,
      });
    }
    return series;
  }, [planReport]);

  const todayStats = daySeries[daySeries.length - 1];

  // Chronological pass/fail history per rule, for the per-row verdict strips.
  // planReport.daily arrives newest-first — sort so strips read left→right in time.
  const ruleDayResults = useMemo(() => {
    const map = new Map<string, Array<'ok' | 'fail'>>();
    const daysAscending = [...planReport.daily].sort((a, b) => a.date.localeCompare(b.date));
    for (const day of daysAscending) {
      for (const ev of day.evaluations) {
        if (ev.state === 'unchecked') continue;
        const arr = map.get(ev.ruleId) ?? [];
        arr.push(ev.state === 'ok' ? 'ok' : 'fail');
        map.set(ev.ruleId, arr);
      }
    }
    return map;
  }, [planReport]);

  // Per-day rule verdicts (for the click-a-bar readout) and per-rule verdicts
  // keyed by date (for the click-a-rule chart replay).
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

  const ruleStateByDate = useMemo(() => {
    const map = new Map<string, Map<string, 'ok' | 'fail'>>();
    for (const day of planReport.daily) {
      for (const ev of day.evaluations) {
        if (ev.state === 'unchecked') continue;
        if (!map.has(ev.ruleId)) map.set(ev.ruleId, new Map());
        map.get(ev.ruleId)!.set(day.date, ev.state === 'ok' ? 'ok' : 'fail');
      }
    }
    return map;
  }, [planReport]);

  const ruleLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const rule of riskRules) map.set(rule.id, rule.label);
    return map;
  }, [riskRules]);

  // Clean-day streaks across verified days — the discipline scoreboard.
  const cleanStreaks = useMemo(() => {
    const checked = daySeries.filter(day => day.pct !== null);
    let best = 0;
    let run = 0;
    for (const day of checked) {
      if (day.failed === 0) { run += 1; best = Math.max(best, run); }
      else run = 0;
    }
    let current = 0;
    for (let i = checked.length - 1; i >= 0; i--) {
      if (checked[i].failed === 0) current += 1;
      else break;
    }
    return { current, best };
  }, [daySeries]);

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
            <h1 className="tp-title">Rules</h1>
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

      </header>

      <main className="tp-content trading-plan-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* ── The record — chart + ledger. Renders after the rulebook (flex
            order): the contract first, then whether it was honored. */}
        <section data-tour-id="trading-plan-core" style={{ order: 2, marginTop: 14, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }}>
          {/* Chapter divider — the seam between contract and consequences */}
          <div style={{ gridColumn: '1 / -1', paddingTop: 22, borderTop: '1px solid var(--app-border)', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <h2 className="tp-title">The record</h2>
              <p style={{ margin: '5px 0 0', fontSize: 11, color: 'var(--txt-3)' }}>
                Every session verified against the rulebook — the last 30 days.
              </p>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: adherenceColor, flexShrink: 0 }}>
              {planReport.pct !== null ? `HELD TO ${planReport.pct}%` : 'NO VERIFIED DAYS YET'}
            </span>
          </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

            {/* Daily discipline — one bar per calendar day, binary verdict */}
            <div style={{ border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '15px 18px 0' }}>
                <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--txt-2)' }}>
                  DAILY DISCIPLINE · 30D
                </p>
                {chartRuleId ? (
                  <button
                    type="button"
                    onClick={() => setChartRuleId(null)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7,
                      border: '1px solid rgba(245,158,11,0.5)', borderRadius: 5,
                      background: 'rgba(245,158,11,0.12)', color: 'var(--amber)',
                      padding: '3px 9px', fontFamily: 'var(--font-mono)', fontSize: 9,
                      fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
                    }}
                  >
                    {ruleLabelById.get(chartRuleId) ?? 'Rule'} · ✕
                  </button>
                ) : (
                  <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.08em', color: 'var(--txt-3)', display: 'flex', alignItems: 'center', gap: 14 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: BAR_ON }} /> ALL RULES HELD
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: BAR_BREAK }} /> RULE BROKEN
                    </span>
                  </p>
                )}
              </div>

              <div style={{ position: 'relative', height: 148, margin: '18px 18px 0' }}>
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 3 }}>
                  {daySeries.map(day => {
                    const hasData = day.pct !== null;
                    const ruleState = chartRuleId ? ruleStateByDate.get(chartRuleId)?.get(day.date) : undefined;
                    const barColor = chartRuleId
                      ? (ruleState === 'ok' ? BAR_ON : ruleState === 'fail' ? BAR_BREAK : (day.isToday ? 'transparent' : BAR_EMPTY))
                      : hasData
                        ? (day.failed === 0 ? BAR_ON : BAR_BREAK)
                        : day.isToday ? 'transparent' : BAR_EMPTY;
                    const barHeight = chartRuleId
                      ? (ruleState ? '62%' : day.isToday ? '100%' : 5)
                      : hasData ? `${Math.max(8, day.pct as number)}%` : day.isToday ? '100%' : 5;
                    const clickable = hasData;
                    return (
                      <span
                        key={day.date}
                        onClick={clickable ? () => setSelectedDay(current => (current === day.date ? null : day.date)) : undefined}
                        title={chartRuleId
                          ? `${day.label} · ${ruleState === 'ok' ? 'held' : ruleState === 'fail' ? 'broken' : 'not checked'}`
                          : hasData
                            ? `${day.label} · ${day.failed === 0 ? 'all rules held' : `${day.failed} break${day.failed !== 1 ? 's' : ''}`} — click for detail`
                            : `${day.label} · no verified session`}
                        style={{
                          flex: 1,
                          height: barHeight,
                          borderRadius: '2px 2px 0 0',
                          backgroundColor: barColor,
                          border: day.isToday && !hasData ? '1px solid var(--txt-2)' : 'none',
                          outline: selectedDay === day.date ? '1px solid var(--txt)' : 'none',
                          outlineOffset: 1,
                          cursor: clickable ? 'pointer' : 'default',
                          transition: 'height 0.2s ease, background-color 0.2s ease',
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', margin: '9px 18px 14px' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--txt-3)' }}>{daySeries[0].label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--txt-3)' }}>{daySeries[15].label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--txt-3)' }}>{daySeries[29].label}</span>
              </div>

              {/* Click-a-bar readout: exactly which rules held or broke that day */}
              {selectedDay && (
                <div style={{ borderTop: '1px solid var(--app-border)', padding: '10px 18px', display: 'flex', alignItems: 'center', gap: '6px 14px', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--txt)' }}>
                    {daySeries.find(day => day.date === selectedDay)?.label?.toUpperCase() ?? selectedDay}
                  </span>
                  {(dayEvalMap.get(selectedDay) ?? []).map(ev => (
                    <span key={ev.ruleId} style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.05em', color: ev.state === 'ok' ? 'var(--grn, #22d68a)' : 'var(--red)' }}>
                      {ev.state === 'ok' ? '✓' : '✗'} {ruleLabelById.get(ev.ruleId) ?? 'Rule'}
                    </span>
                  ))}
                  {(dayEvalMap.get(selectedDay) ?? []).length === 0 && (
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--txt-3)' }}>No rule checks that day.</span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedDay(null)}
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--txt-3)', fontSize: 11, cursor: 'pointer', padding: '0 2px' }}
                    aria-label="Clear selected day"
                  >
                    ✕
                  </button>
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--app-border)', padding: '11px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--txt-3)' }}>
                  YOUR RULES · {todayStats.checkedCount > 0
                    ? <span style={{ color: 'var(--amber)', fontWeight: 700 }}>{todayStats.passed} OF {todayStats.checkedCount} HELD TODAY</span>
                    : <span>NOT YET VERIFIED TODAY</span>}
                </p>
                <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', color: 'var(--txt-3)' }}>
                  30D ADHERENCE · <span style={{ color: adherenceColor, fontWeight: 700 }}>{planReport.pct !== null ? `${planReport.pct}%` : '—'}</span>
                  {' '}· {totalBreaks} BREAK{totalBreaks !== 1 ? 'S' : ''} / {checkedDays.length} DAY{checkedDays.length !== 1 ? 'S' : ''}
                </p>
              </div>
            </div>

            {/* Per-rule ledger, worst offender first */}
            <div style={{ border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--app-border)' }}>
                <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--txt-2)' }}>
                  BY RULE · WORST FIRST
                </p>
                <p style={{ margin: 0, fontSize: 10, color: 'var(--txt-3)' }}>
                  Click a rule to replay its history on the chart
                </p>
              </div>
              {(() => {
                const rows = riskRules
                  .filter(rule => rule.enabled !== false && (rule.kind ?? 'manual') !== 'manual')
                  .map(rule => ({ rule, stats: ruleStatsMap.get(rule.id) }))
                  .sort((a, b) => (a.stats?.pct ?? 101) - (b.stats?.pct ?? 101));
                if (rows.length === 0) {
                  return (
                    <p style={{ margin: 0, padding: '16px 18px', fontSize: 12, color: 'var(--txt-3)' }}>
                      No auto-checked rules are enabled — turn rules on in the rulebook above and stats appear here.
                    </p>
                  );
                }
                return rows.map(({ rule, stats }, rowIndex) => {
                  const pct = stats && stats.checked > 0 ? (stats.pct ?? 0) : null;
                  const pctTextColor = pct === null ? 'var(--txt-3)' : pct >= ADHERENCE_TARGET ? 'var(--amber)' : 'var(--red)';
                  const results = ruleDayResults.get(rule.id) ?? [];
                  const chartActive = chartRuleId === rule.id;
                  return (
                    <div
                      key={rule.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setChartRuleId(current => (current === rule.id ? null : rule.id))}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setChartRuleId(current => (current === rule.id ? null : rule.id)); } }}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(160px, 230px) minmax(0, 1fr) 58px 150px',
                        gap: 18,
                        alignItems: 'center',
                        padding: '13px 16px 13px 15px',
                        borderTop: rowIndex === 0 ? 'none' : '1px solid var(--app-border)',
                        borderLeft: chartActive ? '3px solid var(--amber)' : '3px solid transparent',
                        backgroundColor: chartActive ? 'rgba(245,158,11,0.05)' : 'transparent',
                        cursor: 'pointer',
                        transition: 'background-color 0.12s, border-color 0.12s',
                      }}
                    >
                      <span style={{ minWidth: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--txt)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {rule.label}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 16 }}>
                        {results.length > 0 ? results.slice(-30).map((r, i) => (
                          <span key={i} style={{ flex: 1, maxWidth: 14, height: '100%', borderRadius: 2, backgroundColor: r === 'ok' ? BAR_ON : BAR_BREAK, opacity: r === 'ok' ? 0.9 : 1 }} />
                        )) : (
                          <div style={{ width: '100%', height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                        )}
                      </div>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, color: pctTextColor }}>
                        {pct !== null ? `${pct}%` : '—'}
                      </span>
                      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', color: 'var(--txt-3)', whiteSpace: 'nowrap' }}>
                        {stats && stats.checked > 0
                          ? <>{stats.failed} BRK · {stats.checked} CHK</>
                          : 'NO DATA YET'}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>

            <p style={{ margin: 0, fontSize: 10, color: 'var(--txt-3)', lineHeight: 1.5 }}>
              Stats evaluate past sessions against your current rule values — tightening a rule today changes how old sessions score.
            </p>
            </div>

            {/* Readout rail — the scoreboard the chart earns */}
            <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', overflow: 'hidden' }}>
                <div style={{ padding: '14px 16px 0' }}>
                  <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--txt-2)' }}>
                    CLEAN STREAK
                  </p>
                  <p style={{ margin: '11px 0 0', fontFamily: 'var(--font-mono)', fontSize: 38, fontWeight: 700, lineHeight: 1, color: cleanStreaks.current > 0 ? 'var(--amber)' : 'var(--txt-3)' }}>
                    {cleanStreaks.current}
                  </p>
                  <p style={{ margin: '7px 0 15px', fontSize: 11, lineHeight: 1.5, color: 'var(--txt-3)' }}>
                    consecutive verified day{cleanStreaks.current !== 1 ? 's' : ''} with every rule held
                  </p>
                </div>
                <div style={{ borderTop: '1px solid var(--app-border)', padding: '10px 16px', display: 'flex', justifyContent: 'space-between', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', color: 'var(--txt-3)' }}>
                  <span>BEST · <b style={{ color: 'var(--txt)' }}>{cleanStreaks.best}</b> DAYS</span>
                  <span><b style={{ color: 'var(--grn, #22d68a)' }}>{planReport.perfectDays}</b> PERFECT · <b style={{ color: 'var(--red)' }}>{planReport.brokenDays}</b> BROKEN</span>
                </div>
              </div>

              <div style={{ border: '1px solid var(--app-border)', borderRadius: 10, backgroundColor: 'var(--app-panel)', overflow: 'hidden' }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--app-border)' }}>
                  <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', color: 'var(--txt-2)' }}>
                    THE DAMAGE · 30D
                  </p>
                </div>
                <div style={{ padding: '12px 16px' }}>
                  <p style={{ margin: 0, fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--txt-3)' }}>Most broken</p>
                  <p style={{ margin: '5px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--txt-2)' }}>
                    {planReport.mostBrokenRule
                      ? <>{planReport.mostBrokenRule.label} — <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--red)' }}>{planReport.mostBrokenRule.failed}×</span></>
                      : 'No rule breaks in the last 30 days.'}
                  </p>
                </div>
                {planReport.mostExpensiveRule && planReport.mostExpensiveRule.lossWhenBroken > 0 && (
                  <div style={{ padding: '12px 16px', borderTop: '1px solid var(--app-border)' }}>
                    <p style={{ margin: 0, fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--txt-3)' }}>Costliest when broken</p>
                    <p style={{ margin: '5px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--txt-2)' }}>
                      {planReport.mostExpensiveRule.label} — <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--red)' }}>
                        −${Math.round(planReport.mostExpensiveRule.lossWhenBroken).toLocaleString()}
                      </span> lost on break days
                    </p>
                  </div>
                )}
              </div>
            </aside>
          </section>

          {/* ── The rulebook — the contract itself ── */}
          <section data-tour-id="risk-rules-framework" style={{ order: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>

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
                    {todayStats.checkedCount > 0 && (
                      <> · <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--amber)' }}>{todayStats.passed} of {todayStats.checkedCount}</span> held today</>
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

            {/* Right rail — where the contract applies. The adherence numbers
                live in the record section below, once. */}
            <aside style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
      </main>
    </div>
  );
}
