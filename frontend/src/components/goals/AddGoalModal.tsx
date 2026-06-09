import React, { useEffect, useState } from 'react';
import type { Goal, GoalCategory, GoalColor, GoalStep } from '../../types/goals.js';
import { goalColorMap } from '../../lib/goalColors.js';
import DatePicker from '../common/DatePicker.js';

interface AddGoalModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAddGoal: (goal: Goal) => void;
  editGoal?: Goal;
}

const CATEGORIES: GoalCategory[] = ['Profitability', 'Risk', 'Mindset', 'Consistency', 'Discipline'];
const COLORS: GoalColor[] = ['cobalt', 'amber', 'teal', 'purple', 'rose'];

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 8,
  padding: '9px 12px',
  fontFamily: "'DM Sans', sans-serif",
  fontSize: 13,
  color: '#e2e8f0',
  outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: "'DM Mono', monospace",
  fontSize: 11,
  color: 'rgba(148,163,184,0.60)',
  marginBottom: 6,
};

export default function AddGoalModal({ isOpen, onClose, onAddGoal, editGoal }: AddGoalModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<GoalCategory>('Profitability');
  const [color, setColor] = useState<GoalColor>('cobalt');
  const [horizon, setHorizon] = useState('');
  const [stepInput, setStepInput] = useState('');
  const [steps, setSteps] = useState<{ text: string; done: boolean }[]>([]);

  useEffect(() => {
    if (editGoal) {
      setTitle(editGoal.title);
      setDescription(editGoal.description);
      setCategory(editGoal.category);
      setColor(editGoal.color);
      setHorizon(editGoal.horizon);
      setSteps(editGoal.steps.map(s => ({ text: s.text, done: s.done })));
    } else if (isOpen) {
      setTitle('');
      setDescription('');
      setCategory('Profitability');
      setColor('cobalt');
      setHorizon('');
      setStepInput('');
      setSteps([]);
    }
  }, [isOpen, editGoal]);

  useEffect(() => {
    if (isOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  const addStep = () => {
    const text = stepInput.trim();
    if (!text || steps.length >= 6) return;
    setSteps(prev => [...prev, { text, done: false }]);
    setStepInput('');
  };

  const removeStep = (index: number) => {
    setSteps(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const builtSteps: GoalStep[] = steps.map((s, i) => ({
      id: editGoal ? (editGoal.steps[i]?.id ?? crypto.randomUUID()) : crypto.randomUUID(),
      text: s.text,
      done: s.done,
    }));
    const goal: Goal = {
      id: editGoal?.id ?? crypto.randomUUID(),
      title: title.trim(),
      description: description.trim(),
      category,
      color,
      horizon,
      steps: builtSteps,
      createdAt: editGoal?.createdAt ?? new Date().toISOString(),
    };
    onAddGoal(goal);
  };

  const accent = goalColorMap[color].accent;
  const accentText = goalColorMap[color].accentText;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.60)',
          backdropFilter: 'blur(6px)',
        }}
      />

      {/* Modal */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 520,
          background: '#0e1526',
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: 16,
          boxShadow: '0 32px 80px rgba(0,0,0,0.5)',
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 24px 0',
            marginBottom: 20,
          }}
        >
          <div>
            <p
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 11,
                color: accent,
                marginBottom: 4,
              }}
            >
              Vision Board
            </p>
            <h2
              style={{
                fontFamily: "'Instrument Serif', Georgia, serif",
                fontSize: 22,
                color: '#e2e8f0',
                fontWeight: 400,
                margin: 0,
              }}
            >
              {editGoal ? 'Edit goal' : 'Pin a new goal'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8,
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              color: 'rgba(148,163,184,0.6)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '0 24px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Title */}
          <div>
            <label style={labelStyle}>Goal title</label>
            <input
              style={inputStyle}
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Only take planned trades"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label style={labelStyle}>Description</label>
            <textarea
              style={{ ...inputStyle, resize: 'none', minHeight: 72 }}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does success look like for this goal?"
            />
          </div>

          {/* Category + Color row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <label style={labelStyle}>Category</label>
              <select
                style={{ ...inputStyle, cursor: 'pointer' }}
                value={category}
                onChange={e => setCategory(e.target.value as GoalCategory)}
              >
                {CATEGORIES.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Color</label>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', height: 38 }}>
                {COLORS.map(c => {
                  const isSelected = color === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      title={c}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        background: goalColorMap[c].accent,
                        border: isSelected ? '2px solid rgba(255,255,255,0.9)' : '2px solid transparent',
                        outline: isSelected ? `2px solid ${goalColorMap[c].accent}` : '2px solid transparent',
                        outlineOffset: 2,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        flexShrink: 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* Horizon */}
          <div>
            <label style={labelStyle}>Target date</label>
            <DatePicker
              style={inputStyle}
              value={horizon}
              onChange={setHorizon}
              fullWidth
              align="left"
              placeholder="No target date"
            />
          </div>

          {/* Steps */}
          <div>
            <label style={labelStyle}>Milestones ({steps.length}/6)</label>
            {steps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                {steps.map((step, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                      borderRadius: 7,
                      padding: '7px 10px',
                    }}
                  >
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: accent,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontFamily: "'DM Sans', sans-serif",
                        fontSize: 12,
                        color: 'rgba(226,232,240,0.80)',
                        flex: 1,
                      }}
                    >
                      {step.text}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeStep(i)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        color: 'rgba(148,163,184,0.35)',
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            {steps.length < 6 && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...inputStyle, flex: 1 }}
                  value={stepInput}
                  onChange={e => setStepInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } }}
                  placeholder="Add a milestone step…"
                />
                <button
                  type="button"
                  onClick={addStep}
                  style={{
                    flexShrink: 0,
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 8,
                    padding: '0 14px',
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: accentText,
                    cursor: 'pointer',
                    letterSpacing: '0.06em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  + Add
                </button>
              </div>
            )}
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={!title.trim()}
            style={{
              marginTop: 4,
              width: '100%',
              height: 44,
              borderRadius: 10,
              border: `1px solid ${accent}40`,
              background: `${accent}18`,
              fontFamily: "'DM Sans', sans-serif",
              fontSize: 14,
              fontWeight: 600,
              color: accentText,
              cursor: title.trim() ? 'pointer' : 'not-allowed',
              opacity: title.trim() ? 1 : 0.45,
              transition: 'all 0.15s',
              letterSpacing: '0.01em',
            }}
          >
            {editGoal ? 'Save changes' : 'Pin this goal'}
          </button>
        </form>
      </div>
    </div>
  );
}
