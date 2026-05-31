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
  PenLine,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Target,
} from 'lucide-react';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { useTrades } from '../hooks/useTrades.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Trade } from '../types/index.js';
import { normalizeConfluenceTag } from '../utils/confluenceTags.js';
import { formatRiskRewardRatio } from '../utils/riskReward.js';
import { getTradeRiskReward } from '../utils/tradeAnalytics.js';
import './TradingPlan.css';

type TradingPlanTab = 'trading-plan' | 'risk-rules' | 'playbook' | 'prop-firm-rules' | 'pre-session-checklist';
type ColorTone = 'amber' | 'cobalt' | 'green' | 'red' | 'neutral';

interface PlanBlock {
  id: string;
  name: string;
  iconColor: ColorTone;
  content: string;
  placeholder: string;
  isOpen: boolean;
}

interface RiskRule {
  id: string;
  label: string;
  value: string;
  unit: string;
  color: 'red' | 'amber' | 'green' | 'default';
}

interface Setup {
  id: string;
  rank: 'A+' | 'A' | 'B';
  name: string;
  description: string;
  timeframe: string;
  market: string;
  avgRR: string;
  confluences: string[];
  isExpanded: boolean;
}

interface SetupEdgeScore {
  setupId: string;
  matchedTrades: Trade[];
  tradeCount: number;
  edgeScore: number | null;
  grade: 'A+' | 'A' | 'B' | 'C' | 'Learning';
  status: 'Scale' | 'Active' | 'Watch' | 'Bench' | 'Needs data';
  statusTone: 'green' | 'amber' | 'cobalt' | 'red' | 'neutral';
  netPnL: number;
  winRate: number;
  avgPnL: number;
  avgRR: number | null;
  planRate: number | null;
  tiltCount: number;
  tiltRate: number;
  action: string;
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
  { id: 'playbook', label: 'Playbook', icon: Target },
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
    placeholder: 'The setup pattern that gives you repeatable probability...',
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

const INITIAL_RISK_RULES: RiskRule[] = [];

const INITIAL_SETUPS: Setup[] = [];

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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatMoney(value: number, symbol: string): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${symbol}${Math.abs(value).toLocaleString('en-US', {
    maximumFractionDigits: 0,
  })}`;
}

function normalizeSetupConfluences(setup: Setup): string[] {
  const values = setup.confluences
    .map(value => normalizeConfluenceTag(value))
    .filter(Boolean);
  return Array.from(new Set(values));
}

function normalizeTradeConfluences(trade: Trade): Set<string> {
  return new Set((trade.confluences ?? []).map(value => normalizeConfluenceTag(value)).filter(Boolean));
}

function isTiltTrade(trade: Trade): boolean {
  const state = (trade.emotional_state ?? '').toLowerCase();
  const flags = trade.behavioral_flags ?? [];
  return trade.followed_plan === false
    || flags.length > 0
    || /tilt|revenge|fomo|angry|frustrated|impulsive|rushed/.test(state);
}

function scoreSetupEdge(setup: Setup, trades: Trade[]): SetupEdgeScore {
  const setupKeys = normalizeSetupConfluences(setup);

  if (setupKeys.length === 0) {
    return {
      setupId: setup.id,
      matchedTrades: [],
      tradeCount: 0,
      edgeScore: null,
      grade: 'Learning',
      status: 'Needs data',
      statusTone: 'neutral',
      netPnL: 0,
      winRate: 0,
      avgPnL: 0,
      avgRR: null,
      planRate: null,
      tiltCount: 0,
      tiltRate: 0,
      action: 'Add confluence rules to this setup so Flyxa can match journal trades against it.',
    };
  }

  const matchedTrades = trades.filter(trade => {
    const tradeKeys = normalizeTradeConfluences(trade);
    return setupKeys.some(key => tradeKeys.has(key));
  });

  const tradeCount = matchedTrades.length;
  if (tradeCount === 0) {
    return {
      setupId: setup.id,
      matchedTrades,
      tradeCount,
      edgeScore: null,
      grade: 'Learning',
      status: 'Needs data',
      statusTone: 'neutral',
      netPnL: 0,
      winRate: 0,
      avgPnL: 0,
      avgRR: null,
      planRate: null,
      tiltCount: 0,
      tiltRate: 0,
      action: 'No matching journal trades yet. Tag future trades with these confluences to start scoring.',
    };
  }

  const wins = matchedTrades.filter(trade => trade.pnl > 0);
  const losses = matchedTrades.filter(trade => trade.pnl < 0);
  const scoredTrades = wins.length + losses.length;
  const netPnL = matchedTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const avgPnL = netPnL / tradeCount;
  const winRate = scoredTrades > 0 ? (wins.length / scoredTrades) * 100 : 0;
  const grossProfit = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 3 : 1) : grossProfit / grossLoss;
  const rrValues = matchedTrades.map(getTradeRiskReward).filter((value): value is number => value !== null);
  const avgRR = rrValues.length > 0 ? rrValues.reduce((sum, value) => sum + value, 0) / rrValues.length : null;
  const planTagged = matchedTrades.filter(trade => typeof trade.followed_plan === 'boolean');
  const planRate = planTagged.length > 0
    ? (planTagged.filter(trade => trade.followed_plan).length / planTagged.length) * 100
    : null;
  const tiltCount = matchedTrades.filter(isTiltTrade).length;
  const tiltRate = (tiltCount / tradeCount) * 100;
  const sampleConfidence = clamp(tradeCount / 20, 0, 1);

  const edgeScore = Math.round(clamp(
    45
      + clamp((winRate - 50) * 0.35, -18, 18)
      + clamp((profitFactor - 1) * 16, -18, 22)
      + clamp(((avgRR ?? 1) - 1.2) * 8, -8, 12)
      + (planRate === null ? 0 : clamp((planRate - 70) * 0.16, -10, 10))
      - clamp(tiltRate * 0.18, 0, 14)
      + sampleConfidence * 8,
    0,
    100
  ));

  const grade = tradeCount < 5 ? 'Learning' : edgeScore >= 82 ? 'A+' : edgeScore >= 70 ? 'A' : edgeScore >= 58 ? 'B' : 'C';
  const status = tradeCount < 5 ? 'Needs data' : edgeScore >= 76 ? 'Scale' : edgeScore >= 62 ? 'Active' : edgeScore >= 50 ? 'Watch' : 'Bench';
  const statusTone = status === 'Scale'
    ? 'green'
    : status === 'Active'
      ? 'cobalt'
      : status === 'Watch' || status === 'Needs data'
        ? 'amber'
        : 'red';
  const action = status === 'Scale'
    ? 'Best current edge. Prioritize this setup when context is clean and size only inside risk rules.'
    : status === 'Active'
      ? 'Keep in rotation. The edge is positive, but wait for the full checklist before pressing.'
      : status === 'Watch'
        ? 'Trade smaller or collect more examples. Review losers for the repeated leak before scaling.'
        : status === 'Bench'
          ? 'Pause live execution until the rules are tighter or backtest evidence improves.'
          : 'Collect at least five clean tagged examples before making a sizing decision.';

  return {
    setupId: setup.id,
    matchedTrades,
    tradeCount,
    edgeScore,
    grade,
    status,
    statusTone,
    netPnL,
    winRate,
    avgPnL,
    avgRR,
    planRate,
    tiltCount,
    tiltRate,
    action,
  };
}

export default function TradingPlan() {
  const hydrateSharedData = useFlyxaStore(state => state.hydrateSharedData);
  const { trades } = useTrades();
  const { filterTradesBySelectedAccount, preferences } = useAppSettings();

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

  const [setups, setSetups] = useState<Setup[]>(() => {
    const stored = useFlyxaStore.getState().setupPlaybook;
    if (stored.length > 0) {
      return stored.map(setup => ({
        ...setup,
        rank: setup.rank === 'A+' || setup.rank === 'A' || setup.rank === 'B' ? setup.rank : 'B',
        confluences: Array.isArray(setup.confluences) ? setup.confluences : [],
        isExpanded: typeof setup.isExpanded === 'boolean' ? setup.isExpanded : false,
      }));
    }
    const storedMap = new Map(stored.map(setup => [setup.id, setup]));
    return INITIAL_SETUPS.map(setup => {
      const persisted = storedMap.get(setup.id);
      if (!persisted) return setup;
      return { ...setup, isExpanded: typeof persisted.isExpanded === 'boolean' ? persisted.isExpanded : setup.isExpanded };
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

  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const riskRules = INITIAL_RISK_RULES;
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
      setupPlaybook: setups as any,
      riskRules: riskRules as any,
    });
    setLastSaved(savedAt);
    setNow(savedAt.getTime());
  }, [checklist, hydrateSharedData, planBlocks, riskRules, setups]);

  useEffect(() => {
    if (firstMountRef.current) {
      firstMountRef.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => persistState(), 650);
  }, [persistState, checklist, planBlocks, setups]);

  const lastSavedLabel = useMemo(() => formatLastSaved(lastSaved, now), [lastSaved, now]);
  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades]
  );
  const setupEdgeScores = useMemo(
    () => setups.map(setup => scoreSetupEdge(setup, accountTrades)),
    [accountTrades, setups]
  );
  const setupEdgeScoreMap = useMemo(
    () => new Map(setupEdgeScores.map(score => [score.setupId, score])),
    [setupEdgeScores]
  );
  const scoredSetups = useMemo(
    () => setupEdgeScores.filter(score => score.edgeScore !== null),
    [setupEdgeScores]
  );
  const strongestEdge = useMemo(
    () => [...scoredSetups].sort((a, b) => (b.edgeScore ?? 0) - (a.edgeScore ?? 0))[0] ?? null,
    [scoredSetups]
  );
  const weakestEdge = useMemo(
    () => [...scoredSetups].sort((a, b) => (a.edgeScore ?? 0) - (b.edgeScore ?? 0))[0] ?? null,
    [scoredSetups]
  );
  const totalMatchedTrades = useMemo(
    () => new Set(setupEdgeScores.flatMap(score => score.matchedTrades.map(trade => trade.id))).size,
    [setupEdgeScores]
  );
  const avgEdgeScore = useMemo(
    () => scoredSetups.length > 0
      ? Math.round(scoredSetups.reduce((sum, score) => sum + (score.edgeScore ?? 0), 0) / scoredSetups.length)
      : null,
    [scoredSetups]
  );
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
  const highGradeSetups = useMemo(() => setups.filter(setup => setup.rank !== 'B').length, [setups]);
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

  const toggleSetup = (id: string) => {
    setSetups(current => current.map(setup => (setup.id === id ? { ...setup, isExpanded: !setup.isExpanded } : setup)));
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
    setSetups(INITIAL_SETUPS);
    setChecklist(INITIAL_CHECKLIST);
  };

  const exportPlan = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      planBlocks: planBlocks.map(block => ({ title: block.name, content: block.content })),
      riskRules,
      setups,
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
              Clear structure, hard limits, and repeatable setups. This is the document you execute, not improvise.
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
          <article className="tp-kpi tp-kpi-cobalt">
            <p className="tp-kpi-label">Playbook Quality</p>
            <p className="tp-kpi-value num">{highGradeSetups}</p>
            <p className="tp-kpi-sub">A-grade setups in active rotation</p>
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
            <div className="tp-section-head">
              <h2>Risk Rule Framework</h2>
              <p>These are non-negotiable constraints designed to protect your account and decision quality.</p>
            </div>

            <div className="tp-rule-grid">
              {riskRules.map(rule => (
                <article key={rule.id} className="tp-rule-card">
                  <p className="tp-rule-label">{rule.label}</p>
                  <p className={`tp-rule-value num ${ruleColorClass(rule.color)}`}>{rule.value}</p>
                  <p className="tp-rule-unit">{rule.unit}</p>
                  <button type="button" className="tp-rule-edit">
                    <PenLine size={12} />
                    Edit
                  </button>
                </article>
              ))}
            </div>

            <div className="tp-warning">
              <AlertCircle size={14} />
              <div>
                <p>If daily loss limit is hit, the session is over.</p>
                <span>No recovery trades. No exceptions. Protect the account first.</span>
              </div>
            </div>
          </section>
        )}

        {activeTab === 'playbook' && (
          <section className="tp-panel">
            <div className="tp-section-head">
              <h2>Setup Playbook</h2>
              <p>Only execute setups that are already defined here with clear confluence criteria and measured journal evidence.</p>
            </div>

            <div className="tp-edge-grid">
              <article className="tp-edge-kpi">
                <p>Average Edge</p>
                <strong className="num">{avgEdgeScore === null ? '--' : avgEdgeScore}</strong>
                <span>{scoredSetups.length} scored setups</span>
              </article>
              <article className="tp-edge-kpi">
                <p>Strongest Setup</p>
                <strong>{strongestEdge ? setups.find(setup => setup.id === strongestEdge.setupId)?.name : 'No data yet'}</strong>
                <span>{strongestEdge ? `${strongestEdge.status} / ${strongestEdge.tradeCount} trades` : 'Tag trades with confluences'}</span>
              </article>
              <article className="tp-edge-kpi">
                <p>Weakest Setup</p>
                <strong>{weakestEdge ? setups.find(setup => setup.id === weakestEdge.setupId)?.name : 'No data yet'}</strong>
                <span>{weakestEdge ? `${weakestEdge.status} / ${formatMoney(weakestEdge.netPnL, preferences.currencySymbol)}` : 'Needs journal history'}</span>
              </article>
              <article className="tp-edge-kpi">
                <p>Matched Trades</p>
                <strong className="num">{totalMatchedTrades}</strong>
                <span>{accountTrades.length} trades in selected account</span>
              </article>
            </div>

            <div className="tp-stack">
              {setups.length === 0 ? (
                <article className="tp-empty-state">
                  <Target size={15} />
                  <div>
                    <h3>No setups in the playbook yet</h3>
                    <p>Add named setups with confluence criteria, then Flyxa will score which ones deserve more size and which ones should be benched.</p>
                  </div>
                </article>
              ) : setups.map(setup => {
                const score = setupEdgeScoreMap.get(setup.id);
                return (
                  <article key={setup.id} className="tp-card">
                    <button type="button" className="tp-card-head" onClick={() => toggleSetup(setup.id)}>
                      <span className="tp-card-title-wrap">
                        <span className={`tp-rank ${setup.rank === 'B' ? 'b' : 'a'}`}>{setup.rank}</span>
                        <span>
                          <span className="tp-card-title">{setup.name}</span>
                          <span className="tp-card-sub">{setup.description}</span>
                        </span>
                      </span>
                      <span className="tp-edge-head">
                        <span className={`tp-edge-status ${score?.statusTone ?? 'neutral'}`}>{score?.status ?? 'Needs data'}</span>
                        <span className="tp-edge-score num">{score?.edgeScore ?? '--'}</span>
                        <ChevronDown size={14} className={setup.isExpanded ? 'tp-chevron open' : 'tp-chevron'} />
                      </span>
                    </button>

                    <div className="tp-setup-meta">
                      <span className="num">{setup.timeframe}</span>
                      <span className="num">{setup.market}</span>
                      <span className="num tp-rr-pill">Plan {setup.avgRR}</span>
                      <span className="num tp-edge-pill">{score?.tradeCount ?? 0} trades</span>
                      <span className="num">{score?.grade ?? 'Learning'}</span>
                      <span className={`num ${(score?.netPnL ?? 0) >= 0 ? 'tp-edge-positive' : 'tp-edge-negative'}`}>
                        {formatMoney(score?.netPnL ?? 0, preferences.currencySymbol)}
                      </span>
                    </div>

                    {setup.isExpanded && (
                      <div className="tp-card-body">
                        <div className="tp-edge-detail-grid">
                          <div>
                            <p>Win Rate</p>
                            <strong className="num">{score ? `${Math.round(score.winRate)}%` : '--'}</strong>
                          </div>
                          <div>
                            <p>Avg P&L</p>
                            <strong className="num">{formatMoney(score?.avgPnL ?? 0, preferences.currencySymbol)}</strong>
                          </div>
                          <div>
                            <p>Avg R:R</p>
                            <strong className="num">{score?.avgRR === null || !score ? '--' : `${formatRiskRewardRatio(score.avgRR)}R`}</strong>
                          </div>
                          <div>
                            <p>Plan Follow</p>
                            <strong className="num">{score?.planRate === null || !score ? '--' : `${Math.round(score.planRate)}%`}</strong>
                          </div>
                          <div>
                            <p>Tilt Flags</p>
                            <strong className="num">{score?.tiltCount ?? 0}</strong>
                          </div>
                        </div>
                        <div className="tp-edge-action">
                          <BarChart3 size={13} />
                          <p>{score?.action}</p>
                        </div>
                        <div className="tp-confluence-list">
                          {setup.confluences.map(confluence => (
                            <p key={`${setup.id}-${confluence}`}>{confluence}</p>
                          ))}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
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
