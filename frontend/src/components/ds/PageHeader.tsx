import React from 'react';
import './ds.css';

export interface PageHeaderProps {
  title: string;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, sub, actions, className = '' }: PageHeaderProps) {
  return (
    <div className={['ds-page-header', className].filter(Boolean).join(' ')}>
      <div className="ds-page-header-copy">
        <h1 className="ds-page-header-title">{title}</h1>
        {sub && <p className="ds-page-header-sub">{sub}</p>}
      </div>
      {actions && <div className="ds-page-header-actions">{actions}</div>}
    </div>
  );
}
