import React from 'react';
import { TrendingUp, TrendingDown } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  change?: number;
  icon?: React.ReactNode;
  color?: 'default' | 'green' | 'red' | 'blue';
  subtitle?: string;
}

const colorMap = {
  default: 'var(--app-text)',
  green: '#22c55e',
  red: '#ef4444',
  blue: '#f59e0b',
};

export default function StatCard({ title, value, change, icon, color = 'default', subtitle }: StatCardProps) {
  return (
    <div
      style={{
        background: 'var(--app-panel)',
        border: '1px solid var(--app-border)',
        borderRadius: 6,
        padding: '16px 18px',
        transition: 'border-color 180ms ease',
        cursor: 'default',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.13)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--app-border)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--app-text-subtle)',
            marginBottom: 10,
            fontFamily: 'var(--font-sans)',
          }}>
            {title}
          </p>
          <p style={{
            fontSize: 30,
            fontWeight: 600,
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
            lineHeight: 1,
            color: colorMap[color],
          }}>
            {value}
          </p>
          {subtitle && (
            <p style={{ fontSize: 11, color: 'var(--app-text-subtle)', marginTop: 6, fontFamily: 'var(--font-sans)' }}>
              {subtitle}
            </p>
          )}
        </div>
        {icon && (
          <div style={{ color: 'var(--app-text-subtle)', marginLeft: 8, opacity: 0.5 }}>{icon}</div>
        )}
      </div>
      {change !== undefined && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 10,
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          color: change >= 0 ? '#22c55e' : '#ef4444',
        }}>
          {change >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
          <span>{change >= 0 ? '+' : ''}{change.toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
}
