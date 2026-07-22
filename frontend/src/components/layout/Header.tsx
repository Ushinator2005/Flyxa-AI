import { Settings, ChevronDown, MessageSquare, Menu } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import ThemeToggle from '../common/ThemeToggle.js';
import { ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID, useAppSettings } from '../../contexts/AppSettingsContext.js';
import MarketClock from './MarketClock.js';
import { SAVE_STATUS_EVENT, type SaveStatusDetail } from '../../store/supabaseStorage.js';

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
  '/trading-plan': 'Rules',
  '/psychology': 'Psychology Tracker',
  '/goals': 'Goals',
  '/rivals': 'Rivals',
  '/session': 'Session',
  '/billing': 'Billing',
  '/evaluation-coach': 'Evaluation Coach',
  '/settings': 'Settings',
  '/trade-check': 'Trade Lens',
};

export default function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const { accounts, selectedAccountId, setSelectedAccountId, preferences } = useAppSettings();
  const pageName = pageNames[location.pathname] || 'Flyxa';
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const visibleAccounts = accounts.filter(account => account.id !== DEFAULT_ACCOUNT_ID && !account.archived);

  type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const status = (e as CustomEvent<SaveStatusDetail>).detail.status;
      if (savedTimerRef.current) { clearTimeout(savedTimerRef.current); savedTimerRef.current = null; }
      setSaveStatus(status);
      if (status === 'saved') {
        savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 3000);
      }
    };
    window.addEventListener(SAVE_STATUS_EVENT, handler);
    return () => window.removeEventListener(SAVE_STATUS_EVENT, handler);
  }, []);

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
  const openTradeCheck = () => {
    window.dispatchEvent(new Event('flyxa:open-trade-check'));
  };

  return (
    <>
    <header
      style={{
        height: 52,
        background: 'var(--app-panel)',
        borderBottom: '1px solid var(--app-border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        flexShrink: 0,
        gap: 8,
      }}
    >

      {/* Mobile hamburger — only visible below md breakpoint */}
      <button
        type="button"
        className="flex md:hidden"
        onClick={() => window.dispatchEvent(new Event('flyxa:open-mobile-nav'))}
        aria-label="Open navigation"
        title="Open navigation"
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          width: 34,
          height: 34,
          borderRadius: 6,
          border: '1px solid var(--app-border)',
          background: 'transparent',
          color: 'var(--app-text-muted)',
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        <Menu size={16} />
      </button>

      <h1 style={{
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--app-text-subtle)',
        fontFamily: 'var(--font-sans)',
        margin: 0,
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {pageName}
      </h1>

      <MarketClock displayTimezone={preferences.timezone} />

      {saveStatus !== 'idle' && (
        <span style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em',
          flexShrink: 0,
          color: saveStatus === 'error' ? '#ef4444' : saveStatus === 'saved' ? '#22c55e' : 'var(--app-text-subtle)',
          transition: 'color 200ms ease',
        }}>
          {saveStatus === 'saving' && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', opacity: 0.7 }} />
          )}
          {saveStatus === 'saving' ? 'Saving' : saveStatus === 'saved' ? '✓ Saved' : '⚠ Not saved'}
        </span>
      )}

      {/* Desktop-only controls */}
      <div className="hidden md:flex" style={{ alignItems: 'center', gap: 10 }}>
        {/* Account dropdown */}
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

          {open && (() => {
            const activeAccounts = visibleAccounts.filter(a => a.status !== 'Blown' && a.status !== 'Passed');
            const closedAccounts = visibleAccounts.filter(a => a.status === 'Blown' || a.status === 'Passed');
            const statusDot = (status: string) => (
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: accountStatusColor(status),
                flexShrink: 0,
                display: 'inline-block',
              }} title={status} />
            );
            const rowBtn = (id: string, name: string, firm: string, status: string, isSelected: boolean, blown: boolean) => (
              <button
                key={id}
                type="button"
                onClick={() => { setSelectedAccountId(id); setOpen(false); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  fontFamily: 'var(--font-sans)',
                  background: isSelected ? 'var(--app-bg)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  opacity: blown ? 0.5 : 1,
                }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--app-bg)'; }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
              >
                {statusDot(status)}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: isSelected ? 'var(--app-text)' : 'var(--app-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                  {firm && <div style={{ fontSize: 10, color: 'var(--app-text-subtle)', marginTop: 1 }}>{firm}</div>}
                </div>
              </button>
            );
            return (
              <div style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                right: 0,
                width: 240,
                background: 'var(--app-panel)',
                border: '1px solid var(--app-border)',
                borderRadius: 8,
                padding: '4px 0',
                zIndex: 9999,
                boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
                maxHeight: 380,
                overflowY: 'auto',
              }}>
                {/* All Accounts */}
                <button
                  type="button"
                  onClick={() => { setSelectedAccountId(ALL_ACCOUNTS_ID); setOpen(false); }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    fontFamily: 'var(--font-sans)',
                    color: selectedAccountId === ALL_ACCOUNTS_ID ? 'var(--app-text)' : 'var(--app-text-muted)',
                    background: selectedAccountId === ALL_ACCOUNTS_ID ? 'var(--app-bg)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 12,
                    fontWeight: 500,
                  }}
                  onMouseEnter={e => { if (selectedAccountId !== ALL_ACCOUNTS_ID) e.currentTarget.style.background = 'var(--app-bg)'; }}
                  onMouseLeave={e => { if (selectedAccountId !== ALL_ACCOUNTS_ID) e.currentTarget.style.background = 'transparent'; }}
                >
                  All Accounts
                </button>

                {/* Active accounts */}
                {activeAccounts.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--app-border)', marginTop: 2, paddingTop: 2 }}>
                    {activeAccounts.map(a => rowBtn(a.id, a.name, a.broker ?? '', a.status, selectedAccountId === a.id, false))}
                  </div>
                )}

                {/* Blown / Passed accounts */}
                {closedAccounts.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--app-border)', marginTop: 4, paddingTop: 4 }}>
                    <div style={{ padding: '2px 12px 4px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--app-text-subtle)' }}>Closed</div>
                    {closedAccounts.map(a => rowBtn(a.id, a.name, a.broker ?? '', a.status, selectedAccountId === a.id, true))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>

        <button
          type="button"
          onClick={openTradeCheck}
          style={{
            display: 'inline-flex',
            alignItems: 'stretch',
            height: 34,
            padding: 0,
            borderRadius: 5,
            overflow: 'hidden',
            border: 'none',
            background: '#f59e0b',
            cursor: 'pointer',
            transition: 'opacity 150ms ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.opacity = '0.88'; }}
          onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
          aria-label="Open Trade Lens"
          title="Open Trade Lens"
        >
          <span style={{ width: 3, background: 'rgba(0,0,0,0.22)', display: 'block', flexShrink: 0 }} />
          <span style={{
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.11em',
            textTransform: 'uppercase',
            fontFamily: 'var(--font-mono)',
            color: '#000',
          }}>
            Trade Lens
          </span>
        </button>
        <ThemeToggle compact />
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('flyxa:open-messages'))}
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
          aria-label="Open messages"
          title="Messages"
        >
          <MessageSquare size={15} />
        </button>
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

      {/* Mobile-only controls */}
      <div className="flex md:hidden" style={{ alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          onClick={openTradeCheck}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 5,
            border: 'none',
            background: '#f59e0b',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          aria-label="Open Trade Lens"
          title="Open Trade Lens"
        >
          <span style={{ fontSize: 14 }}>⚡</span>
        </button>
        <ThemeToggle compact />
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('flyxa:open-messages'))}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: 6,
            border: '1px solid var(--app-border)',
            background: 'var(--app-bg)',
            color: 'var(--app-text-muted)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
          aria-label="Open messages"
          title="Messages"
        >
          <MessageSquare size={15} />
        </button>
      </div>
    </header>
    </>
  );
}
