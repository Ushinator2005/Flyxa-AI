import React from 'react';
import './ds.css';

export type BtnVariant = 'primary' | 'outline' | 'ghost' | 'danger';
export type BtnSize    = 'sm' | 'md' | 'lg';

export interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  icon?: React.ReactNode;
}

export const Btn = React.forwardRef<HTMLButtonElement, BtnProps>(
  ({ variant = 'outline', size = 'md', icon, children, className = '', ...rest }, ref) => (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      className={[
        'ds-btn',
        `ds-btn-${variant}`,
        `ds-btn-${size}`,
        className,
      ].filter(Boolean).join(' ')}
      {...rest}
    >
      {icon}
      {children}
    </button>
  ),
);

Btn.displayName = 'Btn';
