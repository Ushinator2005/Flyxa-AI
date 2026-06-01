import { useEffect, useMemo, useState } from 'react';
import { Check, Filter, Plus, X } from 'lucide-react';
import { useAllTrades } from '../store/selectors.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { useGoals } from '../hooks/useGoals.js';
import type { Goal, GoalStatus } from '../types/goals.js';
import DatePicker from '../components/common/DatePicker.js';
import './Goals.css';

type GoalCategory = 'financial' | 'discipline' | 'lifestyle' | 'skill';
type GoalFilter = 'all' | 'active' | 'achieved' | 'paused';
type SortMode = 'deadline' | 'progress' | 'category';
type TargetUnit = '$' | 'hrs' | 'trades' | 'days' | 'x';

type GoalMilestone = {
  id: string;
  text: string;
  done: boolean;
};

type NormalizedGoal = {
  id: string;
  category: GoalCategory;
  icon: string;
  title: string;
  description: string;
  targetValue: number | null;
  targetUnit: TargetUnit | null;
  currentValue: number;
  targetDate: string | null;
  status: Exclude<GoalFilter, 'all'>;
  milestones: GoalMilestone[];
  createdAt: string;
  achievedAt: string | null;
  source: Goal;
};

type GoalDraft = Omit<NormalizedGoal, 'id' | 'createdAt' | 'achievedAt' | 'source'> & {
  achievedAt?: string | null;
};

const CATEGORY_META: Record<GoalCategory, {
  label: string;
  legacyCategory: Goal['category'];
  colorClass: string;
  defaultIcon: string;
  unit: TargetUnit;
}> = {
  financial: {
    label: 'Financial',
    legacyCategory: 'financial',
    colorClass: 'financial',
    defaultIcon: '💰',
    unit: '$',
  },
  discipline: {
    label: 'Discipline',
    legacyCategory: 'discipline',
    colorClass: 'discipline',
    defaultIcon: '🎯',
    unit: 'trades',
  },
  lifestyle: {
    label: 'Lifestyle',
    legacyCategory: 'lifestyle',
    colorClass: 'lifestyle',
    defaultIcon: '🚗',
    unit: '$',
  },
  skill: {
    label: 'Skill',
    legacyCategory: 'skill',
    colorClass: 'skill',
    defaultIcon: '📚',
    unit: 'hrs',
  },
};

const CATEGORY_ORDER: GoalCategory[] = ['financial', 'discipline', 'lifestyle', 'skill'];
const EMOJI_OPTIONS = ['💰', '🎯', '🚗', '📊', '🏆', '📚', '💪', '🧊'];

const LEGACY_CATEGORY_MAP: Record<string, GoalCategory> = {
  Profitability: 'financial',
  Risk: 'discipline',
  Mindset: 'skill',
  Consistency: 'lifestyle',
  Discipline: 'discipline',
  financial: 'financial',
  discipline: 'discipline',
  lifestyle: 'lifestyle',
  skill: 'skill',
};

const LEGACY_STATUS_MAP: Record<string, NormalizedGoal['status']> = {
  Active: 'active',
  Paused: 'paused',
  Achieved: 'achieved',
  active: 'active',
  paused: 'paused',
  achieved: 'achieved',
};

const DEFAULT_DRAFT: GoalDraft = {
  category: 'financial',
  icon: '💰',
  title: '',
  description: '',
  targetValue: null,
  targetUnit: '$',
  currentValue: 0,
  targetDate: null,
  status: 'active',
  milestones: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function parseUnit(value: unknown, fallback: TargetUnit): TargetUnit {
  return value === '$' || value === 'hrs' || value === 'trades' || value === 'days' || value === 'x'
    ? value
    : fallback;
}

function normalizeStatus(value: unknown): NormalizedGoal['status'] {
  if (typeof value !== 'string') return 'active';
  return LEGACY_STATUS_MAP[value] ?? 'active';
}

function normalizeCategory(value: unknown): GoalCategory {
  if (typeof value !== 'string') return 'financial';
  return LEGACY_CATEGORY_MAP[value] ?? 'financial';
}

function formatNumber(value: number, unit: TargetUnit | null): string {
  if (unit === '$') {
    return value.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
  }

  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}${unit ? ` ${unit}` : ''}`;
}

function formatShortDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getDaysRemaining(value: string | null): number | null {
  if (!value) return null;
  const target = new Date(`${value}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - today.getTime()) / 86400000);
}

function getDeadlineTone(daysRemaining: number | null): string {
  if (daysRemaining === null) return 'ongoing';
  if (daysRemaining > 60) return 'green';
  if (daysRemaining >= 15) return 'amber';
  return 'red';
}

function computeProgress(goal: NormalizedGoal): number {
  if (goal.targetValue && goal.targetValue > 0) {
    return clamp((goal.currentValue / goal.targetValue) * 100, 0, 100);
  }

  if (goal.milestones.length > 0) {
    return (goal.milestones.filter(milestone => milestone.done).length / goal.milestones.length) * 100;
  }

  return goal.status === 'achieved' ? 100 : 0;
}

function getAutoValue(goal: Goal, category: GoalCategory, trades: ReturnType<typeof useAllTrades>, backtestCount: number): number | null {
  const title = goal.title.toLowerCase();
  const targetUnit = parseUnit(goal.targetUnit, CATEGORY_META[category].unit);

  if (category === 'financial' && targetUnit === '$' && (title.includes('funded') || title.includes('profit'))) {
    return trades.reduce((sum, trade) => sum + trade.pnl, 0);
  }

  if (category === 'discipline') {
    return trades.filter(trade => {
      const emotion = trade.emotionalState?.toLowerCase() ?? '';
      return !emotion.includes('revenge') && trade.reflection.followedPlan !== false;
    }).length;
  }

  if (category === 'skill' && targetUnit === 'hrs' && title.includes('backtest')) {
    return backtestCount;
  }

  return null;
}

function normalizeGoal(goal: Goal, trades: ReturnType<typeof useAllTrades>, backtestCount: number): NormalizedGoal {
  const category = normalizeCategory(goal.category);
  const status = normalizeStatus(goal.status);
  const fallbackUnit = CATEGORY_META[category].unit;
  const targetValue = parseNumber(goal.targetValue ?? goal.target);
  const targetUnit = targetValue === null ? null : parseUnit(goal.targetUnit, fallbackUnit);
  const autoValue = getAutoValue(goal, category, trades, backtestCount);
  const currentValue = autoValue ?? parseNumber(goal.currentValue) ?? 0;
  const targetDate = goal.targetDate || goal.horizon || null;

  return {
    id: goal.id,
    category,
    icon: goal.icon || CATEGORY_META[category].defaultIcon,
    title: goal.title,
    description: goal.description ?? '',
    targetValue,
    targetUnit,
    currentValue,
    targetDate,
    status,
    milestones: goal.steps ?? [],
    createdAt: goal.createdAt,
    achievedAt: goal.achievedAt ?? null,
    source: goal,
  };
}

function toGoalStatus(status: NormalizedGoal['status']): GoalStatus {
  return status === 'achieved' ? 'Achieved' : status === 'paused' ? 'Paused' : 'Active';
}

function toStoreGoal(goal: NormalizedGoal | (GoalDraft & { id: string; createdAt: string; achievedAt: string | null }), source?: Goal): Goal {
  const category = CATEGORY_META[goal.category];
  const targetDate = goal.targetDate ?? '';

  return {
    ...(source ?? {}),
    id: goal.id,
    title: goal.title,
    category: category.legacyCategory,
    color: source?.color ?? 'cobalt',
    horizon: targetDate,
    description: goal.description,
    steps: goal.milestones,
    status: toGoalStatus(goal.status),
    createdAt: goal.createdAt,
    icon: goal.icon,
    targetValue: goal.targetValue ?? undefined,
    targetUnit: goal.targetUnit ?? undefined,
    currentValue: goal.currentValue,
    targetDate,
    achievedAt: goal.achievedAt ?? undefined,
  };
}

function getStats(goal: NormalizedGoal) {
  const remaining = goal.targetValue === null ? 0 : Math.max(0, goal.targetValue - goal.currentValue);
  const completedDate = goal.achievedAt
    ? new Date(goal.achievedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : formatShortDate(goal.targetDate);

  if (goal.status === 'achieved') {
    return [
      { label: 'Achieved amount', value: formatNumber(goal.currentValue, goal.targetUnit), primary: true },
      { label: 'Completed date', value: completedDate || 'Logged' },
    ];
  }

  if (goal.category === 'financial') {
    return [
      { label: 'Current P&L', value: formatNumber(goal.currentValue, '$'), primary: true },
      { label: 'Target', value: goal.targetValue === null ? 'Manual' : formatNumber(goal.targetValue, '$') },
      { label: 'Remaining', value: goal.targetValue === null ? 'Set target' : formatNumber(remaining, '$') },
    ];
  }

  if (goal.category === 'discipline') {
    return [
      { label: 'Clean trades', value: formatNumber(goal.currentValue, 'trades'), primary: true },
      { label: 'Target', value: goal.targetValue === null ? 'Manual' : formatNumber(goal.targetValue, 'trades') },
      { label: 'Remaining', value: goal.targetValue === null ? 'Set target' : formatNumber(remaining, 'trades') },
    ];
  }

  if (goal.category === 'lifestyle') {
    return [
      { label: 'Saved', value: formatNumber(goal.currentValue, goal.targetUnit ?? '$'), primary: true },
      { label: 'Target', value: goal.targetValue === null ? 'Manual' : formatNumber(goal.targetValue, goal.targetUnit ?? '$') },
      { label: 'Remaining', value: goal.targetValue === null ? 'Set target' : formatNumber(remaining, goal.targetUnit ?? '$') },
    ];
  }

  return [
    { label: 'Hours logged', value: formatNumber(goal.currentValue, goal.targetUnit ?? 'hrs'), primary: true },
    { label: 'Target', value: goal.targetValue === null ? 'Manual' : formatNumber(goal.targetValue, goal.targetUnit ?? 'hrs') },
    { label: 'Weekly avg', value: formatNumber(goal.currentValue / 4, goal.targetUnit ?? 'hrs') },
  ];
}

function ProgressBlock({ progress, tone }: { progress: number; tone: GoalCategory | 'achieved' }) {
  const [animated, setAnimated] = useState(0);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setAnimated(progress));
    return () => window.cancelAnimationFrame(frame);
  }, [progress]);

  return (
    <div className="goals-progress-block">
      <div className="goals-progress-head">
        <span className={`goals-pct goals-text-${tone}`}>{Math.round(progress)}%</span>
        <span className="goals-pct-label">complete</span>
      </div>
      <div className="goals-progress-track">
        <div className={`goals-progress-fill goals-fill-${tone}`} style={{ width: `${animated}%` }} />
      </div>
    </div>
  );
}

function GoalCard({
  goal,
  expanded,
  onToggleExpanded,
  onToggleMilestone,
  onAdjust,
  onEdit,
  onDelete,
}: {
  goal: NormalizedGoal;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleMilestone: (milestoneId: string) => void;
  onAdjust: (amount: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tone = goal.status === 'achieved' ? 'achieved' : goal.category;
  const progress = computeProgress(goal);
  const milestonesCompleted = goal.milestones.filter(milestone => milestone.done).length;
  const visibleMilestones = expanded ? goal.milestones : goal.milestones.slice(0, 5);
  const remainingMilestones = Math.max(0, goal.milestones.length - visibleMilestones.length);
  const daysRemaining = getDaysRemaining(goal.targetDate);
  const deadlineTone = getDeadlineTone(daysRemaining);
  const stats = getStats(goal);
  const showManualAdjust = goal.status !== 'achieved';

  return (
    <article className={`goals-card goals-card-${tone}`} onClick={onToggleExpanded}>
      <div className="goals-card-body">
        <header className="goals-card-header">
          <div className={`goals-icon-badge goals-badge-${tone}`}>{goal.icon}</div>
          <div className="goals-card-info">
            <p className={`goals-card-category goals-text-${tone}`}>
              {goal.status === 'achieved' ? 'Achieved' : CATEGORY_META[goal.category].label}
            </p>
            <h3>{goal.title}</h3>
          </div>
          <span className={`goals-status goals-status-${goal.status}`}>{goal.status.toUpperCase()}</span>
        </header>

        {goal.description ? <p className="goals-card-description">{goal.description}</p> : null}

        <ProgressBlock progress={progress} tone={tone} />

        <div className="goals-stats-row">
          {stats.map(stat => (
            <div key={stat.label} className="goals-stat-chip">
              <strong className={stat.primary ? `goals-text-${tone}` : undefined}>{stat.value}</strong>
              <span>{stat.label}</span>
            </div>
          ))}
        </div>

        <section className="goals-milestones">
          <header>
            <span>Milestones</span>
            <strong>{milestonesCompleted} / {goal.milestones.length}</strong>
          </header>
          <div className="goals-milestone-list">
            {visibleMilestones.length > 0 ? visibleMilestones.map(milestone => (
              <button
                key={milestone.id}
                type="button"
                className="goals-milestone"
                onClick={event => {
                  event.stopPropagation();
                  onToggleMilestone(milestone.id);
                }}
              >
                <span className={`goals-milestone-check${milestone.done ? ' is-done' : ''}`}>
                  {milestone.done ? <Check size={8} /> : null}
                </span>
                <span className={milestone.done ? 'is-done' : undefined}>{milestone.text}</span>
              </button>
            )) : (
              <p className="goals-milestone-empty">No milestones yet</p>
            )}
          </div>
          {remainingMilestones > 0 ? <button type="button" className="goals-more">+ {remainingMilestones} more</button> : null}
        </section>

        <footer className="goals-deadline-row">
          <span>{goal.targetDate ? 'Target date' : 'No hard deadline'}</span>
          <div>
            {goal.targetDate ? <time>{formatShortDate(goal.targetDate)}</time> : null}
            <strong className={`goals-days-${deadlineTone}`}>
              {daysRemaining === null
                ? 'Ongoing'
                : daysRemaining < 0
                  ? `${Math.abs(daysRemaining)}d overdue`
                  : daysRemaining === 0
                    ? 'Today'
                    : `${daysRemaining}d left`}
            </strong>
          </div>
        </footer>

        {expanded ? (
          <div className="goals-expanded-actions" onClick={event => event.stopPropagation()}>
            {showManualAdjust ? (
              <div className="goals-adjust">
                <button type="button" onClick={() => onAdjust(-1)}>-</button>
                <span>Manual update</span>
                <button type="button" onClick={() => onAdjust(1)}>+</button>
              </div>
            ) : null}
            <button type="button" onClick={onEdit}>Edit</button>
            <button type="button" className="is-danger" onClick={onDelete}>Delete</button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

function GhostCard({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="goals-ghost-card" onClick={onClick}>
      <Plus size={18} />
      <span>Add a new goal</span>
    </button>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <section className="goals-empty-state">
      <div className="goals-empty-card">
        <p>Set the target. Break it down. Come back on hard days to remember why.</p>
        <button type="button" className="goals-btn goals-btn-primary" onClick={onAdd}>Add your first goal</button>
      </div>
    </section>
  );
}

function AddGoalModal({
  initialGoal,
  onClose,
  onSave,
}: {
  initialGoal: NormalizedGoal | null;
  onClose: () => void;
  onSave: (goal: GoalDraft) => void;
}) {
  const [draft, setDraft] = useState<GoalDraft>(() => {
    if (!initialGoal) return DEFAULT_DRAFT;
    return {
      category: initialGoal.category,
      icon: initialGoal.icon,
      title: initialGoal.title,
      description: initialGoal.description,
      targetValue: initialGoal.targetValue,
      targetUnit: initialGoal.targetUnit,
      currentValue: initialGoal.currentValue,
      targetDate: initialGoal.targetDate,
      status: initialGoal.status === 'achieved' ? 'active' : initialGoal.status,
      milestones: initialGoal.milestones,
      achievedAt: initialGoal.achievedAt,
    };
  });
  const [milestoneText, setMilestoneText] = useState('');
  const [noDeadline, setNoDeadline] = useState(!draft.targetDate);

  const updateDraft = (updates: Partial<GoalDraft>) => setDraft(prev => ({ ...prev, ...updates }));
  const canSave = draft.title.trim().length > 0;

  const addMilestone = () => {
    const text = milestoneText.trim();
    if (!text || draft.milestones.length >= 6) return;
    updateDraft({ milestones: [...draft.milestones, { id: crypto.randomUUID(), text, done: false }] });
    setMilestoneText('');
  };

  const removeMilestone = (id: string) => {
    updateDraft({ milestones: draft.milestones.filter(milestone => milestone.id !== id) });
  };

  const handleSave = () => {
    if (!canSave) return;
    const nextMilestones = milestoneText.trim() && draft.milestones.length < 6
      ? [...draft.milestones, { id: crypto.randomUUID(), text: milestoneText.trim(), done: false }]
      : draft.milestones;
    onSave({
      ...draft,
      title: draft.title.trim(),
      description: draft.description.trim(),
      targetDate: noDeadline ? null : draft.targetDate,
      milestones: nextMilestones,
    });
  };

  return (
    <div className="goals-modal-scrim" role="presentation" onMouseDown={onClose}>
      <section className="goals-modal" role="dialog" aria-modal="true" aria-label="New Goal" onMouseDown={event => event.stopPropagation()}>
        <header className="goals-modal-header">
          <h2>{initialGoal ? 'Edit Goal' : 'New Goal'}</h2>
          <button type="button" onClick={onClose} aria-label="Close goal modal">
            <X size={14} />
          </button>
        </header>

        <div className="goals-modal-body">
          <label className="goals-field">
            <span>Category</span>
            <div className="goals-category-select">
              {CATEGORY_ORDER.map(category => (
                <button
                  key={category}
                  type="button"
                  className={`goals-category-option goals-option-${category}${draft.category === category ? ' is-selected' : ''}`}
                  onClick={() => updateDraft({
                    category,
                    icon: draft.icon || CATEGORY_META[category].defaultIcon,
                    targetUnit: draft.targetUnit ?? CATEGORY_META[category].unit,
                  })}
                >
                  <i />
                  {CATEGORY_META[category].label}
                </button>
              ))}
            </div>
          </label>

          <label className="goals-field">
            <span>Icon</span>
            <div className="goals-emoji-row">
              {EMOJI_OPTIONS.map(icon => (
                <button
                  key={icon}
                  type="button"
                  className={draft.icon === icon ? 'is-selected' : undefined}
                  onClick={() => updateDraft({ icon })}
                >
                  {icon}
                </button>
              ))}
            </div>
          </label>

          <label className="goals-field">
            <span>Goal</span>
            <input
              value={draft.title}
              onChange={event => updateDraft({ title: event.target.value })}
              placeholder="What are you working toward?"
            />
          </label>

          <label className="goals-field">
            <span>Description</span>
            <textarea
              value={draft.description}
              onChange={event => updateDraft({ description: event.target.value })}
              placeholder="Why does this matter? What will it mean when you achieve it?"
            />
          </label>

          <label className="goals-field">
            <span>Target</span>
            <div className="goals-target-grid">
              <input
                className="goals-mono-input"
                type="number"
                min="0"
                value={draft.targetValue ?? ''}
                onChange={event => updateDraft({ targetValue: event.target.value ? Number(event.target.value) : null })}
                placeholder="0"
              />
              <select
                value={draft.targetUnit ?? CATEGORY_META[draft.category].unit}
                onChange={event => updateDraft({ targetUnit: event.target.value as TargetUnit })}
              >
                <option value="$">$</option>
                <option value="hrs">hrs</option>
                <option value="trades">trades</option>
                <option value="days">days</option>
                <option value="x">x</option>
              </select>
            </div>
          </label>

          <div className="goals-date-row">
            <label className="goals-field">
              <span>Target date</span>
              <DatePicker
                value={draft.targetDate ?? ''}
                disabled={noDeadline}
                onChange={value => updateDraft({ targetDate: value || null })}
                fullWidth
                align="left"
                placeholder="No hard deadline"
              />
            </label>
            <label className="goals-checkbox-label">
              <input
                type="checkbox"
                checked={noDeadline}
                onChange={event => {
                  setNoDeadline(event.target.checked);
                  if (event.target.checked) updateDraft({ targetDate: null });
                }}
              />
              No deadline
            </label>
          </div>

          <label className="goals-field">
            <span>Milestones</span>
            <div className="goals-modal-milestones">
              {draft.milestones.map(milestone => (
                <div key={milestone.id} className="goals-modal-milestone">
                  <input
                    value={milestone.text}
                    onChange={event => updateDraft({
                      milestones: draft.milestones.map(item => item.id === milestone.id ? { ...item, text: event.target.value } : item),
                    })}
                  />
                  <button type="button" onClick={() => removeMilestone(milestone.id)} aria-label="Remove milestone">
                    <X size={12} />
                  </button>
                </div>
              ))}
              {draft.milestones.length < 6 ? (
                <div className="goals-add-milestone">
                  <input
                    value={milestoneText}
                    onChange={event => setMilestoneText(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addMilestone();
                      }
                    }}
                    placeholder="Add a milestone"
                  />
                  <button type="button" onClick={addMilestone}>+ Add milestone</button>
                </div>
              ) : null}
            </div>
          </label>
        </div>

        <footer className="goals-modal-footer">
          <button type="button" className="goals-btn goals-btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="goals-btn goals-btn-primary" disabled={!canSave} onClick={handleSave}>
            {initialGoal ? 'Save Goal' : 'Create Goal'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export default function Goals() {
  const { goals: rawGoals, addGoal, updateGoal, deleteGoal } = useGoals();
  const trades = useAllTrades();
  const backtestSessions = useFlyxaStore(state => state.backtestSessions);
  const [activeFilter, setActiveFilter] = useState<GoalFilter>('all');
  const [activeCategories, setActiveCategories] = useState<Record<GoalCategory, boolean>>({
    financial: true,
    discipline: true,
    lifestyle: true,
    skill: true,
  });
  const [sortMode, setSortMode] = useState<SortMode>('deadline');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingGoal, setEditingGoal] = useState<NormalizedGoal | null>(null);
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);

  const goals = useMemo(
    () => rawGoals.map(goal => normalizeGoal(goal, trades, backtestSessions.length)),
    [backtestSessions.length, rawGoals, trades],
  );

  const heroStats = useMemo(() => ({
    active: goals.filter(goal => goal.status === 'active').length,
    achieved: goals.filter(goal => goal.status === 'achieved').length,
    stepsDone: goals.flatMap(goal => goal.milestones).filter(milestone => milestone.done).length,
  }), [goals]);

  const displayedGoals = useMemo(() => {
    const filtered = goals.filter(goal => {
      if (activeFilter === 'achieved') return goal.status === 'achieved';
      if (activeFilter !== 'all' && goal.status !== activeFilter) return false;
      if (!activeCategories[goal.category]) return false;
      return true;
    });

    return [...filtered].sort((a, b) => {
      if (sortMode === 'progress') return computeProgress(b) - computeProgress(a);
      if (sortMode === 'category') return CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
      const aTime = a.targetDate ? new Date(`${a.targetDate}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.targetDate ? new Date(`${b.targetDate}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
  }, [activeCategories, activeFilter, goals, sortMode]);

  const openAddModal = () => {
    setEditingGoal(null);
    setModalOpen(true);
  };

  const saveGoal = (draft: GoalDraft) => {
    if (editingGoal) {
      const updated = toStoreGoal({
        ...draft,
        id: editingGoal.id,
        createdAt: editingGoal.createdAt,
        achievedAt: draft.status === 'achieved' ? editingGoal.achievedAt ?? new Date().toISOString() : draft.achievedAt ?? null,
      }, editingGoal.source);
      updateGoal(updated);
    } else {
      addGoal(toStoreGoal({
        ...draft,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        achievedAt: null,
      }));
    }

    setModalOpen(false);
    setEditingGoal(null);
  };

  const updateNormalizedGoal = (goal: NormalizedGoal) => {
    updateGoal(toStoreGoal(goal, goal.source));
  };

  const toggleMilestone = (goal: NormalizedGoal, milestoneId: string) => {
    const milestones = goal.milestones.map(milestone => (
      milestone.id === milestoneId ? { ...milestone, done: !milestone.done } : milestone
    ));
    const achieved = milestones.length > 0 && milestones.every(milestone => milestone.done);
    updateNormalizedGoal({
      ...goal,
      milestones,
      status: achieved ? 'achieved' : goal.status,
      achievedAt: achieved ? goal.achievedAt ?? new Date().toISOString() : goal.achievedAt,
    });
  };

  const adjustGoal = (goal: NormalizedGoal, amount: number) => {
    updateNormalizedGoal({
      ...goal,
      currentValue: Math.max(0, goal.currentValue + amount),
    });
  };

  return (
    <div className="goals-page">
      <section className="goals-hero" data-tour-id="goals-hero">
        <div className="goals-hero-grid" aria-hidden="true" />
        <div className="goals-hero-glow" aria-hidden="true" />
        <div className="goals-hero-inner">
          <div className="goals-hero-copy">
            <p className="goals-eyebrow">Goals</p>
            <h1>
              Goal tracking
            </h1>
            <p>
              Track the trading targets, routines, and milestones that should influence your daily execution.
            </p>
            <div className="goals-hero-chips">
              <span><i className="is-amber" />{heroStats.active} active goals</span>
              <span><i className="is-green" />{heroStats.achieved} achieved</span>
              <span><i className="is-cobalt" />{heroStats.stepsDone} steps done</span>
            </div>
          </div>
          <div className="goals-hero-actions">
            <button type="button" className="goals-btn goals-btn-ghost" onClick={() => setActiveFilter('achieved')}>
              View achieved
            </button>
            <button type="button" className="goals-btn goals-btn-primary" onClick={openAddModal} data-tour-id="goals-new-goal">
              <Plus size={13} />
              New Goal
            </button>
          </div>
        </div>
      </section>

      <section className="goals-reminder" data-tour-id="goals-reminder">
        <div className="goals-reminder-bar" />
        <p>
          Keep long-term objectives close to the trading data so progress, discipline, and review stay connected.
        </p>
        <span>Flyxa · goals</span>
      </section>

      <section className="goals-content">
        <header className="goals-toolbar" data-tour-id="goals-filters">
          <div className="goals-toolbar-left">
            <div className="goals-filter-tabs">
              {(['all', 'active', 'achieved', 'paused'] as GoalFilter[]).map(filter => (
                <button
                  key={filter}
                  type="button"
                  className={activeFilter === filter ? 'is-active' : undefined}
                  onClick={() => setActiveFilter(filter)}
                >
                  {filter[0].toUpperCase() + filter.slice(1)}
                </button>
              ))}
            </div>
            <div className="goals-category-pills">
              {CATEGORY_ORDER.map(category => (
                <button
                  key={category}
                  type="button"
                  className={`goals-category-pill goals-category-${category}${activeCategories[category] ? ' is-active' : ''}`}
                  onClick={() => setActiveCategories(prev => ({ ...prev, [category]: !prev[category] }))}
                >
                  <i />
                  {CATEGORY_META[category].label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            className="goals-sort"
            onClick={() => setSortMode(current => current === 'deadline' ? 'progress' : current === 'progress' ? 'category' : 'deadline')}
          >
            <Filter size={12} />
            Sort: {sortMode}
          </button>
        </header>

        {goals.length === 0 ? (
          <EmptyState onAdd={openAddModal} />
        ) : (
          <div className="goals-grid" data-tour-id="goals-grid">
            {displayedGoals.map(goal => (
              <GoalCard
                key={goal.id}
                goal={goal}
                expanded={expandedGoalId === goal.id}
                onToggleExpanded={() => setExpandedGoalId(current => current === goal.id ? null : goal.id)}
                onToggleMilestone={milestoneId => toggleMilestone(goal, milestoneId)}
                onAdjust={amount => adjustGoal(goal, amount)}
                onEdit={() => {
                  setEditingGoal(goal);
                  setModalOpen(true);
                }}
                onDelete={() => deleteGoal(goal.id)}
              />
            ))}
            <GhostCard onClick={openAddModal} />
          </div>
        )}
      </section>

      {modalOpen ? (
        <AddGoalModal
          initialGoal={editingGoal}
          onClose={() => {
            setModalOpen(false);
            setEditingGoal(null);
          }}
          onSave={saveGoal}
        />
      ) : null}
    </div>
  );
}
