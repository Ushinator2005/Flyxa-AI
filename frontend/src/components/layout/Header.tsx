import { Settings, ChevronDown } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ThemeToggle from '../common/ThemeToggle.js';
import { ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID, useAppSettings } from '../../contexts/AppSettingsContext.js';
import MarketClock from './MarketClock.js';

function accountStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'blown')  return '#ef4444';
  if (s === 'eval')   return '#3b82f6';
  if (s === 'funded') return '#22c55e';
  if (s === 'live')   return '#f59e0b';
  return 'var(--app-text-subtle)';
}

const pageNames: Record<string, string> = {
  '/': 'Dashboard',
  '/scanner': 'Trade Scanner',
  '/coach': 'Flyxa AI',
  '/flyxa-ai': 'Flyxa AI',
  '/flyxa-ai/patterns': 'Pattern library',
  '/pre-session': 'Pre-session brief',
  '/flyxa-ai/pre-session': 'Pre-session brief',
  '/analytics': 'Analytics',
  '/journal': 'Daily Journal',
  '/chart': 'Backtest',
  '/backtest': 'Backtest',
  '/trading-plan': 'Trading Plan',
  '/psychology': 'Psychology Tracker',
  '/goals': 'Goals',
  '/rivals': 'Rivals',
  '/billing': 'Billing',
  '/settings': 'Settings',
};

export default function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const { accounts, selectedAccountId, setSelectedAccountId, preferences } = useAppSettings();
  const pageName = pageNames[location.pathname] || 'Flyxa';
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);
  const selectedColor = selectedAccount ? accountStatusColor(selectedAccount.status) : null;
  const selectedLabel = selectedAccount?.name ?? 'All Accounts';

  return (
    <header
      style={{
        height: 52,
        background: 'var(--app-panel)',
        borderBottom: '1px solid var(--app-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        flexShrink: 0,
      }}
    >
      <h1 style={{
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--app-text-subtle)',
        fontFamily: 'var(--font-sans)',
        margin: 0,
      }}>
        {pageName}
      </h1>
      <MarketClock displayTimezone={preferences.timezone} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Custom account dropdown with color dots */}
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            style={{
              height: 34,
              minWidth: 180,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingLeft: 10,
              paddingRight: 10,
              fontSize: 12,
              fontFamily: 'var(--font-sans)',
              fontWeight: 500,
              color: 'var(--app-text-muted)',
              background: 'var(--app-bg)',
              border: '1px solid var(--app-border)',
              borderRadius: 6,
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {selectedColor ? (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: selectedColor, flexShrink: 0 }} />
            ) : (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--app-text-subtle)', flexShrink: 0 }} />
            )}
            <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedLabel}
            </span>
            <ChevronDown size={11} style={{ flexShrink: 0, opacity: 0.5 }} />
          </button>

          {open && (
            <div style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              right: 0,
              minWidth: 200,
              background: 'var(--app-panel)',
              border: '1px solid var(--app-border)',
              borderRadius: 8,
              padding: '4px 0',
              zIndex: 9999,
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            }}>
              {/* All Accounts option */}
              <button
                type="button"
                onClick={() => { setSelectedAccountId(ALL_ACCOUNTS_ID); setOpen(false); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 12px',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                  color: selectedAccountId === ALL_ACCOUNTS_ID ? 'var(--app-text)' : 'var(--app-text-muted)',
                  background: selectedAccountId === ALL_ACCOUNTS_ID ? 'var(--app-panel-strong)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--app-text-subtle)', flexShrink: 0 }} />
                All Accounts
                {selectedAccountId === ALL_ACCOUNTS_ID && <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--amber)' }}>✓</span>}
              </button>

              {accounts.filter(account => account.id !== DEFAULT_ACCOUNT_ID).map(account => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => { setSelectedAccountId(account.id); setOpen(false); }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 12px',
                    fontSize: 12,
                    fontFamily: 'var(--font-sans)',
                    color: selectedAccountId === account.id ? 'var(--app-text)' : 'var(--app-text-muted)',
                    background: selectedAccountId === account.id ? 'var(--app-panel-strong)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: accountStatusColor(account.status), flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{account.name}</span>
                  {selectedAccountId === account.id && <span style={{ fontSize: 10, color: 'var(--amber)' }}>✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <ThemeToggle compact />
        <button
          type="button"
          onClick={() => navigate('/settings')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: 34,
            width: 34,
            borderRadius: 6,
            border: '1px solid var(--app-border)',
            background: 'var(--app-bg)',
            color: 'var(--app-text-muted)',
            cursor: 'pointer',
            transition: 'border-color 180ms ease, color 180ms ease',
          }}
          onMouseEnter={e => { const el = e.currentTarget; el.style.borderColor = 'rgba(255,255,255,0.14)'; el.style.color = 'var(--app-text)'; }}
          onMouseLeave={e => { const el = e.currentTarget; el.style.borderColor = 'var(--app-border)'; el.style.color = 'var(--app-text-muted)'; }}
          aria-label="Open settings"
          title="Settings"
        >
          <Settings size={15} />
        </button>
      </div>
    </header>
  );
}
