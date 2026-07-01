import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Clock3,
  Download,
  FileText,
  LockKeyhole,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
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

type TradingPlanTab = 'trading-plan' | 'risk-rules';
type ColorTone = 'amber' | 'cobalt' | 'green' | 'red' | 'neutral';

interface PlanBlock {
  id: string;
  name: string;
  iconColor: ColorTone;
  content: string;
  placeholder: string;
  isOpen: boolean;
}

const TAB_ITEMS: Array<{ id: TradingPlanTab; label: string; icon: typeof FileText }> = [
  { id: 'risk-rules', label: 'Risk Rules', icon: LockKeyhole },
  { id: 'trading-plan', label: 'Strategy Notes', icon: FileText },
];

const PLAN_BLOCK_ICONS = {
  market: Clock3,
  edge: BarChart3,
  entry: CheckCircle2,
  avoid: AlertCircle,
  windows: ClipboardList,
} as const;

const INITIAL_PLAN_BLOCKS: PlanBlock[] = [
  {
    id: 'market',
    name: 'What markets I trade and why',
    iconColor: 'amber',
    content: '',
    placeholder: 'Which instruments, why these and not others, and what behavior you understand best...',
    isOpen: true,
  },
  {
    id: 'edge',
    name: 'My edge and why it works',
    iconColor: 'cobalt',
    content: '',
    placeholder: 'The repeatable market conditions that give you probability...',
    isOpen: true,
  },
  {
    id: 'entry',
    name: 'What a valid entry looks like',
    iconColor: 'green',
    content: '',
    placeholder: 'List every condition that must be true before execution...',
    isOpen: true,
  },
  {
    id: 'avoid',
    name: 'What I do NOT trade',
    iconColor: 'red',
    content: '',
    placeholder: 'No-trade filters: volatility, timing, structure, news windows...',
    isOpen: true,
  },
  {
    id: 'windows',
    name: 'Time windows I trade',
    iconColor: 'neutral',
    content: '',
    placeholder: 'Sessions, kill-zones, and when you are flat by rule...',
    isOpen: true,
  },
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


function ruleColorClass(color: RiskRule['color']): string {
  if (color === 'red') return 'tp-rule-value-red';
  if (color === 'amber') return 'tp-rule-value-amber';
  if (color === 'green') return 'tp-rule-value-green';
  return '';
}

function toneClass(tone: ColorTone): string {
  if (tone === 'amber') return 'tp-tone-amber';
  if (tone === 'cobalt') return 'tp-tone-cobalt';
  if (tone === 'green') return 'tp-tone-green';
  if (tone === 'red') return 'tp-tone-red';
  return 'tp-tone-neutral';
}

export default function TradingPlan() {
  const hydrateSharedData = useFlyxaStore(state => state.hydrateSharedData);

  const [activeTab, setActiveTab] = useState<TradingPlanTab>('risk-rules');
  const [planBlocks, setPlanBlocks] = useState<PlanBlock[]>(() => {
    const stored = useFlyxaStore.getState().planBlocks;
    const storedMap = new Map(stored.map(block => [block.id, block]));
    return INITIAL_PLAN_BLOCKS.map(block => {
      const persisted = storedMap.get(block.id);
      if (!persisted) return block;
      return {
        ...block,
        content: typeof persisted.content === 'string' ? persisted.content : block.content,
        isOpen: typeof persisted.isOpen === 'boolean' ? persisted.isOpen : block.isOpen,
      };
    });
  });

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

  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const firstMountRef = useRef(true);
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
        planBlocks,
        riskRules: currentState.riskRules,
        riskRulesUpdatedAt: currentState.riskRulesUpdatedAt,
      });
      hydrateSharedData({
        planBlocks: planBlocks as any,
      });
      const savedAt = new Date();
      setLastSaved(savedAt);
      setNow(savedAt.getTime());
    } catch {
      pushToast({
        tone: 'red',
        durationMs: 4000,
        message: 'Trading plan could not sync. Your local changes are still preserved.',
      });
    }
  }, [hydrateSharedData, planBlocks]);

  // Plan block changes - debounced save
  useEffect(() => {
    if (firstMountRef.current) {
      firstMountRef.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void persistState();
    }, 650);
  }, [persistState, planBlocks]);

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

  const togglePlanBlock = (id: string) => {
    setPlanBlocks(current => current.map(block => (block.id === id ? { ...block, isOpen: !block.isOpen } : block)));
  };

  const updatePlanBlockContent = (id: string, content: string) => {
    setPlanBlocks(current => current.map(block => (block.id === id ? { ...block, content } : block)));
  };

  const resetPlan = () => {
    setPlanBlocks(INITIAL_PLAN_BLOCKS);
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
    const current = useFlyxaStore.getState().riskRules;
    const updated = [...current, {
      id: `rule-${crypto.randomUUID()}`,
      label: 'New custom rule',
      value: '',
      unit: '',
      color: 'neutral' as const,
      kind: 'manual' as const,
      enabled: true,
    }];
    useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
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

  const exportPlan = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      planBlocks: planBlocks.map(block => ({ title: block.name, content: block.content })),
      riskRules,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `risk-rules-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
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
            <button type="button" className="tp-btn tp-btn-muted" onClick={exportPlan}>
              <Download size={12} />
              Export
            </button>
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
        {activeTab === 'trading-plan' && (
          <section className="tp-main-grid" data-tour-id="trading-plan-core">
            <div className="tp-panel">
              <div className="tp-section-head">
                <h2>Core Strategy Blocks</h2>
                <p>Build your process from market selection through execution filters.</p>
              </div>

              <div className="tp-stack">
                {planBlocks.map(block => {
                  const Icon = PLAN_BLOCK_ICONS[block.id as keyof typeof PLAN_BLOCK_ICONS];
                  return (
                    <article key={block.id} className="tp-card">
                      <button type="button" className="tp-card-head" onClick={() => togglePlanBlock(block.id)}>
                        <span className="tp-card-title-wrap">
                          <span className={`tp-tone ${toneClass(block.iconColor)}`}>
                            {Icon ? <Icon size={13} /> : <FileText size={13} />}
                          </span>
                          <span className="tp-card-title">{block.name}</span>
                        </span>
                        <ChevronDown size={14} className={block.isOpen ? 'tp-chevron open' : 'tp-chevron'} />
                      </button>
                      {block.isOpen && (
                        <div className="tp-card-body">
                          <textarea
                            value={block.content}
                            onChange={event => updatePlanBlockContent(block.id, event.target.value)}
                            placeholder={block.placeholder}
                          />
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>

            <aside className="tp-side" data-tour-id="trading-plan-side">
              <article className="tp-quote">
                <Sparkles size={14} />
                <p>The plan is written by your best self. Follow it when emotions get loud.</p>
              </article>

              <article className="tp-card">
                <div className="tp-side-head">
                  <h3>Hard Stops</h3>
                </div>
                <div className="tp-side-list">
                  {riskRules.slice(0, 3).map(rule => (
                    <div key={rule.id} className="tp-mini-rule">
                      <span className="tp-mini-rule-label">{rule.label}</span>
                      <span className="tp-mini-rule-value-wrap">
                        <span className={`num ${ruleColorClass(rule.color)}`}>{rule.value}</span>
                        {rule.unit ? <span className="tp-mini-rule-unit">{rule.unit}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              </article>
            </aside>
          </section>
        )}

        {activeTab === 'risk-rules' && (
          <section data-tour-id="risk-rules-framework" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* Health Bar — uniform 4-cell strip */}
            <div className="tp-health-bar">
              <div className="tp-hs">
                <span className="tp-hs-label">Active Rules</span>
                <span className="tp-hs-value">{activeRuleCount}</span>
              </div>
              <div className="tp-hs-divider" />
              <div className="tp-hs">
                <span className="tp-hs-label">Auto-checked</span>
                <span className="tp-hs-value tp-hs-green">{automaticRuleCount}</span>
              </div>
              <div className="tp-hs-divider" />
              <div className="tp-hs">
                <span className="tp-hs-label">Adherence 30d</span>
                <span
                  className="tp-hs-value"
                  style={{
                    color: planReport.pct === null ? 'var(--txt-3)'
                      : planReport.pct >= 80 ? 'var(--green)'
                      : planReport.pct >= 60 ? 'var(--amber)'
                      : 'var(--red)',
                  }}
                >
                  {planReport.pct !== null ? `${planReport.pct}%` : '—'}
                </span>
              </div>
              <div className="tp-hs-divider" />
              <div className="tp-hs">
                <span className="tp-hs-label">Total Breaks 30d</span>
                <span className="tp-hs-value" style={{ color: totalBreaks > 0 ? 'var(--red)' : 'var(--txt-3)' }}>
                  {totalBreaks}
                </span>
              </div>
            </div>

            {/* Section Header */}
            <div className="tp-section-head tp-section-head-actions">
              <div>
                <h2>Rule Framework</h2>
                <p>Measurable rules are verified automatically. Subjective rules are confirmed in the journal.</p>
              </div>
              <button type="button" className="tp-btn tp-btn-primary" onClick={addRiskRule}>
                <Plus size={12} /> Add Rule
              </button>
            </div>

            {/* Rule Grid */}
            <div className="tp-rule-grid">
              {riskRules.map(rule => {
                const kind = rule.kind ?? 'manual';
                const isAuto = kind !== 'manual';
                const stats = ruleStatsMap.get(rule.id);
                const breachCount = stats?.failed ?? 0;
                // breach rate = 100 - compliance%; drives accent color
                const breachRatePct = stats ? 100 - (stats.pct ?? 0) : 0;

                const severity =
                  kind === 'manual' ? 'cobalt' :
                  !stats || stats.checked === 0 ? 'none' :
                  breachRatePct >= 50 ? 'red' :
                  breachRatePct >= 20 ? 'amber' :
                  'green';

                const SEV = {
                  red:    { bar: 'linear-gradient(90deg, var(--red), var(--red-dim))',     bg: 'rgba(239,68,68,0.06)',    bdr: 'var(--red-border)',    txt: 'var(--red)' },
                  amber:  { bar: 'linear-gradient(90deg, var(--amber), var(--amber-dim))', bg: 'rgba(245,166,35,0.06)',   bdr: 'var(--amber-border)',  txt: 'var(--amber)' },
                  green:  { bar: 'linear-gradient(90deg, var(--green), var(--green-dim))', bg: 'rgba(34,197,94,0.06)',    bdr: 'var(--green-border)',  txt: 'var(--green)' },
                  cobalt: { bar: 'linear-gradient(90deg, var(--cobalt), var(--cobalt-dim))', bg: 'rgba(30,111,255,0.06)', bdr: 'var(--cobalt-border)', txt: 'var(--cobalt)' },
                  none:   { bar: 'var(--app-border)', bg: 'transparent', bdr: 'transparent', txt: 'var(--txt-3)' },
                } as const;
                const sev = SEV[severity];

                const typeLabel =
                  kind === 'manual' ? 'Journal-confirmed · Subjective' :
                  kind === 'max_trades' ? 'Auto-verified · Count' :
                  kind === 'max_contracts' ? 'Auto-verified · Asset' :
                  kind === 'time_window' ? 'Auto-verified · Time' :
                  kind === 'cooldown_after_loss' ? 'Auto-verified · Cooldown' :
                  'Auto-verified · Amount';

                return (
                  <article key={rule.id} className={[
                    'tp-rcard',
                    rule.enabled === false ? 'tp-rcard-off' : '',
                    severity === 'red'   ? 'tp-rcard-high-breach' : '',
                    severity === 'amber' ? 'tp-rcard-mid-breach'  : '',
                  ].filter(Boolean).join(' ')}>

                    {/* Top accent bar — colored by breach severity */}
                    <div className="tp-rcard-topbar" style={{ background: sev.bar }} />

                    {/* Card Header */}
                    <div className="tp-rcard-hdr">
                      <div className="tp-rcard-title-col">
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
                        <div className="tp-rcard-type-row">
                          <span className="tp-rcard-type-label">{typeLabel}</span>
                          {isAuto && stats && stats.checked > 0 && (
                            <>
                              <span className="tp-rcard-type-dot">·</span>
                              <span className="tp-rcard-breach-inline" style={{ color: sev.txt }}>
                                {breachRatePct}% breach · {breachCount} break{breachCount !== 1 ? 's' : ''}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
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
                    </div>

                    {/* Card Body */}
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

                    {/* Card Footer */}
                    <div className="tp-rcard-footer">
                      <button type="button" className="tp-rule-delete" onClick={() => deleteRiskRule(rule.id)}>
                        <Trash2 size={12} /> Remove
                      </button>
                    </div>

                  </article>
                );
              })}
            </div>

            {/* Warning Banner */}
            <div className="tp-warning">
              <AlertCircle size={14} />
              <div>
                <p>Automatic does not mean guessed.</p>
                <span>Flyxa verifies only rules supported by logged trade data. Missing timestamps or values remain unverified.</span>
              </div>
            </div>

          </section>
        )}
      </main>
    </div>
  );
}
