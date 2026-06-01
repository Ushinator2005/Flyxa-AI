import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, GripVertical, Plus, Target, X } from 'lucide-react';
import type { Goal, GoalCategory, GoalColor, GoalInput, GoalStep } from '../../types/goals.js';
import DatePicker from '../common/DatePicker.js';
import './AddGoalPanel.css';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  editGoal?: Goal | null;
  onSave: (data: GoalInput) => void;
}

type FormState = {
  title: string;
  category: GoalCategory;
  color: GoalColor;
  horizon: string;
  description: string;
  status: 'Active' | 'Paused';
};

const EMPTY: FormState = {
  title: '',
  category: 'Profitability',
  color: 'cobalt',
  horizon: '',
  description: '',
  status: 'Active',
};

const CATEGORIES: GoalCategory[] = ['Profitability', 'Risk', 'Mindset', 'Consistency', 'Discipline'];

const CATEGORY_TONE: Partial<Record<GoalCategory, 'amber' | 'red' | 'cobalt' | 'green' | 'neutral'>> = {
  Profitability: 'amber',
  Risk: 'red',
  Mindset: 'cobalt',
  Consistency: 'green',
  Discipline: 'neutral',
};

const COLOR_MAP: Record<GoalColor, { label: string; className: string }> = {
  cobalt: { label: 'Cobalt', className: 'cobalt' },
  amber: { label: 'Amber', className: 'amber' },
  teal: { label: 'Teal', className: 'teal' },
  purple: { label: 'Purple', className: 'purple' },
  rose: { label: 'Rose', className: 'rose' },
};

export default function AddGoalPanel({ isOpen, onClose, editGoal, onSave }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [steps, setSteps] = useState<GoalStep[]>([]);
  const [stepInput, setStepInput] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const stepInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    if (editGoal) {
      setForm({
        title: editGoal.title,
        category: editGoal.category,
        color: editGoal.color,
        horizon: editGoal.horizon ?? '',
        description: editGoal.description ?? '',
        status: editGoal.status === 'Achieved' ? 'Active' : (editGoal.status as 'Active' | 'Paused'),
      });
      setSteps(editGoal.steps ?? []);
    } else {
      setForm(EMPTY);
      setSteps([]);
    }

    setStepInput('');
    setTimeout(() => titleRef.current?.focus(), 50);
  }, [editGoal, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const addStep = () => {
    const text = stepInput.trim();
    if (!text) return;
    setSteps(prev => [...prev, { id: crypto.randomUUID(), text, done: false }]);
    setStepInput('');
    stepInputRef.current?.focus();
  };

  const removeStep = (id: string) => {
    setSteps(prev => prev.filter(step => step.id !== id));
  };

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    if (!form.title.trim()) return;
    const pendingStep = stepInput.trim();
    const finalSteps = pendingStep ? [...steps, { id: crypto.randomUUID(), text: pendingStep, done: false }] : steps;

    onSave({
      title: form.title.trim(),
      category: form.category,
      color: form.color,
      horizon: form.horizon,
      description: form.description.trim(),
      steps: finalSteps,
      status: form.status,
    });

    onClose();
  };

  return (
    <>
      <div className={`goal-panel-overlay ${isOpen ? 'open' : ''}`} onClick={onClose} />

      <aside className={`goal-panel ${isOpen ? 'open' : ''}`} role="dialog" aria-modal="true" aria-label="Add goal">
        <header className="goal-panel-header">
          <div>
            <p className="goal-panel-eyebrow">Vision Board</p>
            <h2>{editGoal ? 'Edit goal' : 'New goal'}</h2>
            <p className="goal-panel-sub">Define a target, anchor it with steps, and make execution measurable.</p>
          </div>
          <button type="button" className="goal-close" onClick={onClose} aria-label="Close panel">
            <X size={16} />
          </button>
        </header>

        <div className="goal-panel-body">
          <section className="goal-section">
            <div className="goal-section-head">
              <h3>
                <Target size={14} />
                Goal Basics
              </h3>
            </div>

            <div className="goal-field">
              <label>Goal title <span>*</span></label>
              <input
                ref={titleRef}
                value={form.title}
                onChange={event => setField('title', event.target.value)}
                onKeyDown={event => event.key === 'Enter' && handleSave()}
                placeholder="e.g. Hit $10k profit month"
              />
            </div>

            <div className="goal-two-col">
              <div className="goal-field">
                <label>
                  <CalendarDays size={12} />
                  Horizon date
                </label>
                <DatePicker value={form.horizon} onChange={value => setField('horizon', value)} fullWidth align="left" placeholder="No deadline" />
              </div>

              <div className="goal-field">
                <label>Status</label>
                <div className="goal-status-row">
                  {(['Active', 'Paused'] as const).map(status => (
                    <button
                      key={status}
                      type="button"
                      className={`goal-status-btn ${form.status === status ? 'active' : ''}`}
                      onClick={() => setField('status', status)}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="goal-section">
            <div className="goal-section-head">
              <h3>Category</h3>
            </div>
            <div className="goal-category-grid">
              {CATEGORIES.map(category => (
                <button
                  key={category}
                  type="button"
                  className={`goal-category-btn tone-${CATEGORY_TONE[category] ?? 'neutral'} ${form.category === category ? 'active' : ''}`}
                  onClick={() => setField('category', category)}
                >
                  {category}
                </button>
              ))}
            </div>
          </section>

          <section className="goal-section">
            <div className="goal-section-head">
              <h3>Color</h3>
            </div>
            <div className="goal-color-row">
              {(Object.keys(COLOR_MAP) as GoalColor[]).map(color => (
                <button
                  key={color}
                  type="button"
                  className={`goal-color-btn ${COLOR_MAP[color].className} ${form.color === color ? 'active' : ''}`}
                  onClick={() => setField('color', color)}
                >
                  <span />
                  {COLOR_MAP[color].label}
                </button>
              ))}
            </div>
          </section>

          <section className="goal-section">
            <div className="goal-section-head">
              <h3>Description</h3>
              <p>Optional context for what success looks like.</p>
            </div>
            <div className="goal-field">
              <textarea
                rows={4}
                value={form.description}
                onChange={event => setField('description', event.target.value)}
                placeholder="What does achieving this look like?"
              />
            </div>
          </section>

          <section className="goal-section">
            <div className="goal-section-head">
              <h3>Sub-goals <small>({steps.length} added)</small></h3>
              <p>Break the objective into clear execution steps.</p>
            </div>

            {steps.length > 0 && (
              <div className="goal-steps-list">
                {steps.map((step, index) => (
                  <article key={step.id}>
                    <span className="drag"><GripVertical size={12} /></span>
                    <span className="idx">{index + 1}</span>
                    <p>{step.text}</p>
                    <button type="button" onClick={() => removeStep(step.id)} aria-label="Remove step">
                      <X size={13} />
                    </button>
                  </article>
                ))}
              </div>
            )}

            <div className="goal-add-step">
              <input
                ref={stepInputRef}
                value={stepInput}
                onChange={event => setStepInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addStep();
                  }
                }}
                placeholder="e.g. Open a funded account"
              />
              <button type="button" onClick={addStep} disabled={!stepInput.trim()}>
                <Plus size={12} />
                Add
              </button>
            </div>
          </section>
        </div>

        <footer className="goal-panel-footer">
          <button type="button" className="goal-save" onClick={handleSave} disabled={!form.title.trim()}>
            <Check size={13} />
            {editGoal ? 'Save changes' : 'Add to vision board'}
          </button>
          <button type="button" className="goal-cancel" onClick={onClose}>
            Cancel
          </button>
        </footer>
      </aside>
    </>
  );
}
