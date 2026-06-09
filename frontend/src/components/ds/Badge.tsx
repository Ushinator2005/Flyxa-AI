import React from 'react';
import './ds.css';

export type BadgeTone = 'neutral' | 'amber' | 'green' | 'red' | 'blue' | 'purple';

export interface BadgeProps {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ tone = 'neutral', children, className = '' }: BadgeProps) {
  return (
    <span className={['ds-badge', `ds-badge-${tone}`, className].filter(Boolean).join(' ')}>
      {children}
    </span>
  );
}
