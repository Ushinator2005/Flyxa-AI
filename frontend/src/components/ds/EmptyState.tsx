import React from 'react';
import './ds.css';
import { Btn } from './Btn.js';

export interface EmptyStateAction {
  label: string;
  onClick?: () => void;
}

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  sub?: string;
  action?: EmptyStateAction;
  className?: string;
}

export function EmptyState({ icon, title, sub, action, className = '' }: EmptyStateProps) {
  return (
    <div className={['ds-empty', className].filter(Boolean).join(' ')}>
      {icon && <div className="ds-empty-icon">{icon}</div>}
      <p className="ds-empty-title">{title}</p>
      {sub && <p className="ds-empty-sub">{sub}</p>}
      {action && (
        <div className="ds-empty-action">
          <Btn variant="primary" size="sm" onClick={action.onClick}>
            {action.label}
          </Btn>
        </div>
      )}
    </div>
  );
}
