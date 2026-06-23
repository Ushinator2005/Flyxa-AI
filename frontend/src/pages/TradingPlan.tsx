import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Clock3,
  Download,
  FileText,
  ListChecks,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import type { RiskRule } from '../store/types.js';
import { DEFAULT_STRUCTURED_RULES, normalizeRiskRule } from '../utils/tradingRules.js';
import './TradingPlan.css';

type TradingPlanTab = 'trading-plan' | 'risk-rules' | 'prop-firm-rules' | 'pre-session-checklist';
type ColorTone = 'amber' | 'cobalt' | 'green' | 'red' | 'neutral';

interface PlanBlock {
  id: string;
  name: string;
  iconColor: ColorTone;
  content: string;
  placeholder: string;
  isOpen: boolean;
}

interface PropFirmParam {
  label: string;
  value: string;
  color: 'amber' | 'green' | 'default';
}

interface PropFirm {
  id: string;
  name: string;
  phase: 'Eval' | 'Funded';
  params: PropFirmParam[];
  progress?: {
    percent: number;
    currentLabel: string;
    targetLabel: string;
  };
}

interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}


const TAB_ITEMS: Array<{ id: TradingPlanTab; label: string; icon: typeof FileText }> = [
  { id: 'trading-plan', label: 'Trading Plan', icon: FileText },
  { id: 'risk-rules', label: 'Risk Rules', icon: ShieldAlert },
  { id: 'prop-firm-rules', label: 'Prop Firms', icon: Building2 },
  { id: 'pre-session-checklist', label: 'Pre-session', icon: ListChecks },
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

const INITIAL_PROP_FIRMS: PropFirm[] = [];

const INITIAL_CHECKLIST: ChecklistItem[] = [];

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

  const [activeTab, setActiveTab] = useState<TradingPlanTab>('trading-plan');
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

  const [checklist, setChecklist] = useState<ChecklistItem[]>(() => {
    const stored = useFlyxaStore.getState().checklist;
    const doneMap = new Map(stored.map(item => [item.id, item.done]));
    return INITIAL_CHECKLIST.map(item => ({
      ...item,
      done: typeof doneMap.get(item.id) === 'boolean' ? Boolean(doneMap.get(item.id)) : item.done,
    }));
  });
  const [riskRules, setRiskRules] = useState<RiskRule[]>(() => {
    const stored = useFlyxaStore.getState().riskRules;
    return (stored.length > 0 ? stored : DEFAULT_STRUCTURED_RULES).map(normalizeRiskRule);
  });

  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const propFirms = INITIAL_PROP_FIRMS;

  const firstMountRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const persistState = useCallback(() => {
    const savedAt = new Date();
    hydrateSharedData({
      planBlocks: planBlocks as any,
      checklist: checklist as any,
      riskRules: riskRules as any,
    });
    setLastSaved(savedAt);
    setNow(savedAt.getTime());
  }, [checklist, hydrateSharedData, planBlocks, riskRules]);

  useEffect(() => {
    if (firstMountRef.current) {
      firstMountRef.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => persistState(), 650);
  }, [persistState, checklist, planBlocks, riskRules]);

  const lastSavedLabel = useMemo(() => formatLastSaved(lastSaved, now), [lastSaved, now]);
  const completedBlocks = useMemo(() => planBlocks.filter(block => block.content.trim().length > 0).length, [planBlocks]);
  const strategyCoverage = useMemo(
    () => Math.round((completedBlocks / Math.max(1, planBlocks.length)) * 100),
    [completedBlocks, planBlocks.length]
  );
  const checklistDoneCount = useMemo(() => checklist.filter(item => item.done).length, [checklist]);
  const checklistPercent = useMemo(
    () => Math.round((checklistDoneCount / Math.max(1, checklist.length)) * 100),
    [checklistDoneCount, checklist.length]
  );
  const strictRiskRules = useMemo(
    () => riskRules.filter(rule => rule.color === 'amber' || rule.color === 'red').length,
    [riskRules]
  );
  const checklistRemaining = Math.max(0, checklist.length - checklistDoneCount);

  const togglePlanBlock = (id: string) => {
    setPlanBlocks(current => current.map(block => (block.id === id ? { ...block, isOpen: !block.isOpen } : block)));
  };

  const updatePlanBlockContent = (id: string, content: string) => {
    setPlanBlocks(current => current.map(block => (block.id === id ? { ...block, content } : block)));
  };

  const toggleChecklist = (id: string) => {
    setChecklist(current => current.map(item => (item.id === id ? { ...item, done: !item.done } : item)));
  };

  const completeChecklist = () => {
    setChecklist(current => current.map(item => ({ ...item, done: true })));
  };

  const resetChecklist = () => {
    setChecklist(current => current.map(item => ({ ...item, done: false })));
  };

  const resetPlan = () => {
    setPlanBlocks(INITIAL_PLAN_BLOCKS);
    setChecklist(INITIAL_CHECKLIST);
    setRiskRules(DEFAULT_STRUCTURED_RULES);
  };

  const updateRiskRule = (id: string, updates: Partial<RiskRule>) => {
    setRiskRules(current => {
      const updated = current.map(rule => rule.id === id ? { ...rule, ...updates } : rule);
      useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
      return updated;
    });
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

  const addRiskRule = () => {
    setRiskRules(current => {
      const updated = [...current, {
        id: `rule-${crypto.randomUUID()}`,
        label: 'Manual check',
        value: '',
        unit: '',
        color: 'neutral' as const,
        kind: 'manual' as const,
        enabled: true,
      }];
      useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
      return updated;
    });
  };

  const deleteRiskRule = (id: string) => {
    setRiskRules(current => {
      const updated = current.filter(rule => rule.id !== id);
      useFlyxaStore.getState().updateRiskRules(updated as RiskRule[]);
      return updated;
    });
  };

  const exportPlan = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      planBlocks: planBlocks.map(block => ({ title: block.name, content: block.content })),
      riskRules,
      checklist,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `trading-plan-${new Date().toISOString().slice(0, 10)}.json`;
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
            <p className="tp-eyebrow">Strategy Operating System</p>
            <h1 className="tp-title">Trading Plan</h1>
            <p className="tp-subtitle">
              Clear structure, hard limits, and repeatable execution rules. This is the document you execute, not improvise.
            </p>
          </div>
          <div className="tp-actions">
            <span className="tp-saved">{lastSavedLabel}</span>
            <button type="button" className="tp-btn tp-btn-muted" onClick={exportPlan}>
              <Download size={13} />
              Export
            </button>
            <button type="button" className="tp-btn tp-btn-muted" onClick={resetPlan}>
              <RefreshCw size={13} />
              Reset
            </button>
            <button type="button" className="tp-btn tp-btn-primary" onClick={persistState}>
              <Save size={13} />
              Save Plan
            </button>
          </div>
        </div>

        <div className="tp-kpi-grid" data-tour-id="trading-plan-kpis">
          <article className="tp-kpi tp-kpi-amber">
            <p className="tp-kpi-label">Strategy Coverage</p>
            <p className="tp-kpi-value num">{strategyCoverage}%</p>
            <p className="tp-kpi-sub">{completedBlocks}/{planBlocks.length} core blocks documented</p>
          </article>
          <article className="tp-kpi tp-kpi-green">
            <p className="tp-kpi-label">Checklist Ready</p>
            <p className="tp-kpi-value num">{checklistPercent}%</p>
            <p className="tp-kpi-sub">{checklistDoneCount} complete, {checklistRemaining} pending</p>
          </article>
          <article className="tp-kpi tp-kpi-red">
            <p className="tp-kpi-label">Guardrails</p>
            <p className="tp-kpi-value num">{strictRiskRules}</p>
            <p className="tp-kpi-sub">Hard stop rules with strict enforcement</p>
          </article>
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
                  <h3>Pre-session Readiness</h3>
                  <span className="num">{checklistPercent}%</span>
                </div>
                <div className="tp-side-meta">
                  <span>{checklistDoneCount}/{checklist.length} complete</span>
                  <span>{checklistRemaining} left</span>
                </div>
                <div className="tp-progress tp-progress-side">
                  <div style={{ width: `${checklistPercent}%` }} />
                </div>
                <div className="tp-side-list tp-side-list-spacious">
                  {checklist.slice(0, 4).map(item => (
                    <button
                      key={item.id}
                      type="button"
                      className={`tp-check tp-check-preview ${item.done ? 'done' : ''}`}
                      onClick={() => toggleChecklist(item.id)}
                    >
                      <span className="tp-check-box">{item.done ? <Check size={10} /> : null}</span>
                      <span>{item.text}</span>
                    </button>
                  ))}
                </div>
                <button type="button" className="tp-inline-link" onClick={() => setActiveTab('pre-session-checklist')}>
                  Open full checklist
                </button>
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
          <section className="tp-panel">
            <div className="tp-section-head tp-section-head-actions">
              <div>
                <h2>Rule Framework</h2>
                <p>Measurable rules are verified automatically. Subjective rules are confirmed in the journal.</p>
              </div>
              <button type="button" className="tp-btn tp-btn-primary" onClick={addRiskRule}>
                <Plus size={12} /> Add rule
              </button>
            </div>

            <div className="tp-rule-grid">
              {riskRules.map(rule => (
                <article key={rule.id} className={`tp-rule-card tp-rule-editor ${rule.enabled === false ? 'disabled' : ''}`}>
                  <div className="tp-rule-editor-head">
                    <span className={`tp-rule-source-wrap ${rule.kind === 'manual' ? 'manual' : 'automatic'}`}>
                      <select
                        className="tp-rule-kind-select"
                        value={rule.kind ?? 'manual'}
                        onChange={event => { const kind = event.target.value as NonNullable<RiskRule['kind']>; updateRiskRule(rule.id, { kind, label: RULE_KIND_LABELS[kind] }); }}
                      >
                        <option value="max_daily_loss">Max daily loss</option>
                        <option value="max_trades">Max trades / day</option>
                        <option value="max_contracts">Max contracts</option>
                        <option value="min_rr">Min R:R</option>
                        <option value="time_window">Time window</option>
                        <option value="cooldown_after_loss">Cooldown after loss</option>
                        <option value="manual">Manual check</option>
                      </select>
                    </span>
                    <label className="tp-rule-toggle">
                      <input type="checkbox" checked={rule.enabled !== false} onChange={event => updateRiskRule(rule.id, { enabled: event.target.checked })} />
                      <span>{rule.enabled === false ? 'Off' : 'On'}</span>
                    </label>
                  </div>
                  {rule.kind === 'time_window' ? (
                    <div className="tp-rule-value-fields">
                      <label><span>Start</span><input className="tp-rule-input" type="time" value={rule.startTime ?? '09:30'} onChange={event => updateRiskRule(rule.id, { startTime: event.target.value })} /></label>
                      <label><span>End</span><input className="tp-rule-input" type="time" value={rule.endTime ?? '11:30'} onChange={event => updateRiskRule(rule.id, { endTime: event.target.value })} /></label>
                    </div>
                  ) : rule.kind !== 'manual' ? (
                    <div className="tp-rule-value-fields">
                      <label><span>Limit</span><input className="tp-rule-input num" type="number" min="0" step="0.1" value={rule.value} onChange={event => updateRiskRule(rule.id, { value: event.target.value })} /></label>
                      <label><span>Unit</span><input className="tp-rule-input" value={rule.unit} onChange={event => updateRiskRule(rule.id, { unit: event.target.value })} /></label>
                    </div>
                  ) : (
                    <p className="tp-rule-manual-note">This appears in each daily journal for pass/fail confirmation.</p>
                  )}
                  <button type="button" className="tp-rule-delete" onClick={() => deleteRiskRule(rule.id)}>
                    <Trash2 size={12} /> Remove
                  </button>
                </article>
              ))}
            </div>

            <div className="tp-warning">
              <AlertCircle size={14} />
              <div>
                <p>Automatic does not mean guessed.</p>
                <span>Flyxa verifies only rules supported by logged trade data. Missing timestamps or values remain unverified.</span>
              </div>
            </div>
          </section>
        )}

        {activeTab === 'prop-firm-rules' && (
          <section className="tp-panel">
            <div className="tp-section-head">
              <h2>Prop Firm Rulebook</h2>
              <p>Track each firm context separately to avoid accidental rule violations.</p>
            </div>

            <div className="tp-firm-grid">
              {propFirms.map(firm => (
                <article key={firm.id} className="tp-card">
                  <div className="tp-firm-head">
                    <h3>{firm.name}</h3>
                    <span className={`tp-phase ${firm.phase === 'Eval' ? 'eval' : 'funded'}`}>{firm.phase}</span>
                  </div>
                  <div className="tp-side-list">
                    {firm.params.map(param => (
                      <div key={`${firm.id}-${param.label}`} className="tp-mini-rule">
                        <span>{param.label}</span>
                        <span className={`num ${param.color === 'amber' ? 'tp-rule-value-amber' : param.color === 'green' ? 'tp-rule-value-green' : ''}`}>
                          {param.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  {firm.progress && (
                    <div className="tp-firm-progress">
                      <div className="tp-firm-progress-labels">
                        <span className="num">{firm.progress.currentLabel}</span>
                        <span className="num">{firm.progress.targetLabel}</span>
                      </div>
                      <div className="tp-progress">
                        <div style={{ width: `${firm.progress.percent}%` }} />
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {activeTab === 'pre-session-checklist' && (
          <section className="tp-panel">
            <div className="tp-section-head">
              <h2>Pre-session Checklist</h2>
              <p>Run this checklist before every session. Consistency here protects your execution quality.</p>
            </div>

            <div className="tp-checklist-tools">
              <button type="button" className="tp-btn tp-btn-muted" onClick={completeChecklist}>
                <Check size={12} />
                Complete all
              </button>
              <button type="button" className="tp-btn tp-btn-muted" onClick={resetChecklist}>
                <RefreshCw size={12} />
                Clear all
              </button>
              <span className="tp-saved">
                {checklistDoneCount}/{checklist.length} complete
              </span>
            </div>

            <div className="tp-progress">
              <div style={{ width: `${checklistPercent}%` }} />
            </div>

            <div className="tp-stack">
              {checklist.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`tp-check tp-check-row ${item.done ? 'done' : ''}`}
                  onClick={() => toggleChecklist(item.id)}
                >
                  <span className="tp-check-box">{item.done ? <Check size={10} /> : null}</span>
                  <span>{item.text}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
