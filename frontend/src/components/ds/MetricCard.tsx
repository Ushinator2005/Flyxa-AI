import React from 'react';
import './ds.css';

export type MetricAccent    = 'none' | 'amber' | 'green' | 'red' | 'blue' | 'purple';
export type MetricValueTone = 'positive' | 'negative' | 'neutral';

export interface MetricCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  accent?: MetricAccent;
  valueTone?: MetricValueTone;
  className?: string;
}

const VALUE_TONE_COLOR: Record<MetricValueTone, string> = {
  positive: 'var(--color-green)',
  negative: 'var(--color-red)',
  neutral:  'var(--color-text)',
};

export function MetricCard({ label, value, sub, accent = 'none', valueTone, className = '' }: MetricCardProps) {
  return (
    <div
      className={['ds-metric', className].filter(Boolean).join(' ')}
      data-accent={accent === 'none' ? undefined : accent}
    >
      <p className="ds-metric-label">{label}</p>
      <p
        className="ds-metric-value"
        style={valueTone ? { color: VALUE_TONE_COLOR[valueTone] } : undefined}
      >
        {value}
      </p>
      {sub !== undefined && <p className="ds-metric-sub">{sub}</p>}
    </div>
  );
}
