import { Settings, ChevronDown, Menu, X, LayoutDashboard, Brain, BarChart2, Target, Heart, FileText, Crosshair, Swords, Trophy, ScanLine, Newspaper, ClipboardCheck, CreditCard } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate, NavLink } from 'react-router-dom';
import ThemeToggle from '../common/ThemeToggle.js';
import { ALL_ACCOUNTS_ID, DEFAULT_ACCOUNT_ID, useAppSettings } from '../../contexts/AppSettingsContext.js';
import MarketClock from './MarketClock.js';

const AMBER      = '#f59e0b';
const AMBER_DIM  = 'rgba(245,158,11,0.10)';
const AMBER_BORD = 'rgba(245,158,11,0.20)';

const mobileNavItems = [
  { path: '/',              icon: LayoutDashboard, label: 'Dashboard',     exact: true },
  { path: '/pre-session',   icon: ClipboardCheck,  label: 'Pre-Session'             },
  { path: '/scanner',       icon: ScanLine,        label: 'Trade Scanner'           },
  { path: '/journal',       icon: FileText,        label: 'Daily Journal'           },
  { path: '/market-news',   icon: Newspaper,       label: 'Market News'             },
  { path: '/flyxa-ai',      icon: Brain,           label: 'Flyxa AI'                },
  { path: '/analytics',     icon: BarChart2,       label: 'Analytics'               },
  { path: '/backtest',      icon: Target,          label: 'Backtest'                },
  { path: '/trading-plan',  icon: FileText,        label: 'Trading Plan'            },
  { path: '/psychology',    icon: Heart,           label: 'Psychology'              },
  { path: '/goals',         icon: Crosshair,       label: 'Goals'                   },
  { path: '/rivals',        icon: Swords,          label: 'Rivals'                  },
  { path: '/achievements',  icon: Trophy,          label: 'Achievements'            },
  { path: '/billing',       icon: CreditCard,      label: 'Billing'                 },
  { path: '/settings',      icon: Settings,        label: 'Settings'                },
];

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
  const [mobileOpen, setMobileOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close mobile nav on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

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
    <>
    {/* Mobile nav drawer */}
    {mobileOpen && (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 1300,
          display: 'flex',
        }}
        onClick={() => setMobileOpen(false)}
      >
        {/* Backdrop */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'rgba(10,8,6,0.72)',
          backdropFilter: 'blur(4px)',
        }} />
        {/* Drawer */}
        <nav
          onClick={e => e.stopPropagation()}
          style={{
            position: 'relative', zIndex: 1,
            width: 260, height: '100%',
            background: 'var(--app-panel)',
            borderRight: '1px solid var(--app-border)',
            display: 'flex', flexDirection: 'column',
            overflowY: 'auto',
          }}
        >
          {/* Drawer header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 16px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.04)',
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--app-text)', fontFamily: 'var(--font-sans)' }}>
              fly<span style={{ color: AMBER }}>x</span>a
            </span>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--app-text-subtle)', padding: 4, display: 'flex' }}
              aria-label="Close menu"
            >
              <X size={18} />
            </button>
          </div>
          {/* Nav links */}
          <div style={{ flex: 1, padding: '10px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {mobileNavItems.map(({ path, icon: Icon, label, exact }) => {
              const pathName = path.split('?')[0];
              const isActive = exact
                ? location.pathname === pathName
                : location.pathname === pathName || location.pathname.startsWith(pathName + '/');
              return (
                <NavLink
                  key={path}
                  to={path}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 12px', borderRadius: 6,
                    fontSize: 14, fontWeight: isActive ? 500 : 400,
                    textDecoration: 'none', fontFamily: 'var(--font-sans)',
                    color: isActive ? AMBER : 'var(--app-text-muted)',
                    background: isActive ? AMBER_DIM : 'transparent',
                    border: isActive ? `1px solid ${AMBER_BORD}` : '1px solid transparent',
                  }}
                >
                  <Icon size={17} strokeWidth={1.5} />
                  <span>{label}</span>
                </NavLink>
              );
            })}
          </div>
        </nav>
      </div>
    )}

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
      {/* Mobile hamburger — only visible on small screens */}
      <button
        type="button"
        className="md:hidden"
        onClick={() => setMobileOpen(o => !o)}
        aria-label="Open navigation"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 34, borderRadius: 6,
          border: '1px solid var(--app-border)',
          background: 'var(--app-bg)',
          color: 'var(--app-text-muted)',
          cursor: 'pointer', marginRight: 10,
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
    </>
  );
}
