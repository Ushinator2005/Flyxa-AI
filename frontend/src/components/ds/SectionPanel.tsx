import React from 'react';
import './ds.css';

export interface SectionPanelProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  right?: React.ReactNode;
  flush?: boolean;           // removes body padding
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function SectionPanel({
  title,
  subtitle,
  right,
  flush = false,
  children,
  className = '',
  style,
}: SectionPanelProps) {
  const hasHeader = title !== undefined || right !== undefined;

  return (
    <div className={['ds-panel', className].filter(Boolean).join(' ')} style={style}>
      {hasHeader && (
        <div className="ds-panel-header">
          <div className="ds-panel-heading">
            {title && <h2 className="ds-panel-title">{title}</h2>}
            {subtitle && <p className="ds-panel-subtitle">{subtitle}</p>}
          </div>
          {right && <div>{right}</div>}
        </div>
      )}
      <div className={flush ? 'ds-panel-body-flush' : 'ds-panel-body'}>
        {children}
      </div>
    </div>
  );
}
