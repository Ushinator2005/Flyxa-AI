import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Brain, BarChart2, Target,
  FileText, Crosshair, Swords, Trophy,
  Settings, LogOut, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, CreditCard, ScanLine, Newspaper, ClipboardCheck,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext.js';
import { DEFAULT_ACCOUNT_ID, useAppSettings } from '../../contexts/AppSettingsContext.js';
import { rivalsApi } from '../../services/api.js';

const AMBER      = '#f59e0b';
const AMBER_DIM  = 'rgba(245,158,11,0.10)';
const AMBER_BORD = 'rgba(245,158,11,0.20)';
const S1         = 'var(--app-panel)';
const BORDER     = 'var(--app-border)';
const BSUB       = 'rgba(255,255,255,0.04)';
const T1         = 'var(--app-text)';
const T2         = 'var(--app-text-muted)';
const T3         = 'var(--app-text-subtle)';
const SANS       = 'var(--font-sans)';
const MONO       = 'var(--font-mono)';

function accountStatusColor(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'blown') return '#ef4444';
  if (normalized === 'eval') return '#3b82f6';
  if (normalized === 'funded') return '#22c55e';
  if (normalized === 'live') return '#f59e0b';
  return T3;
}

const navItems: { path: string; icon: typeof LayoutDashboard; label: string; extraActivePaths?: string[] }[] = [
  { path: '/',                         icon: LayoutDashboard, label: 'Dashboard'       },
  { path: '/pre-session',              icon: ClipboardCheck,  label: 'Session',        extraActivePaths: ['/post-session'] },
  { path: '/scanner',                  icon: ScanLine,        label: 'Trade Scanner'   },
  { path: '/journal',                  icon: FileText,        label: 'Daily Journal'   },
  { path: '/market-news',              icon: Newspaper,       label: 'Market News'     },
  { path: '/flyxa-ai',                 icon: Brain,           label: 'Flyxa AI'        },
  { path: '/analytics',                icon: BarChart2,       label: 'Analytics'       },
  { path: '/backtest',                 icon: Target,          label: 'Backtest'        },
  { path: '/trading-plan',             icon: FileText,        label: 'Trading Plan'    },
  { path: '/psychology',               icon: Brain,           label: 'Psychology'      },
  { path: '/goals',                    icon: Crosshair,       label: 'Goals'           },
  { path: '/rivals',                   icon: Swords,          label: 'Rivals'          },
  { path: '/achievements',             icon: Trophy,          label: 'Achievements'    },
];

function NavItem({
  path, icon: Icon, label, exact = false, onClick, collapsed = false, extraActivePaths = [],
}: {
  path: string; icon: typeof LayoutDashboard; label: string; exact?: boolean; onClick?: () => void; collapsed?: boolean; extraActivePaths?: string[];
}) {
  const location = useLocation();
  const pathName = path.split('?')[0];
  const isActive = exact
    ? location.pathname === pathName
    : location.pathname === pathName
      || location.pathname.startsWith(pathName + '/')
      || extraActivePaths.some(p => location.pathname === p || location.pathname.startsWith(p + '/'));

  const [hov, setHov] = useState(false);
  const tourId = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return (
    <NavLink
      to={path}
      onClick={onClick}
      data-tour-id={tourId}
      title={collapsed ? label : undefined}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start', gap: collapsed ? 0 : 10,
        padding: collapsed ? '8px 0' : '8px 12px', borderRadius: 6,
        fontSize: 13, fontWeight: isActive ? 500 : 400,
        textDecoration: 'none', fontFamily: SANS,
        color: isActive ? AMBER : hov ? T1 : T2,
        background: isActive ? AMBER_DIM : hov ? 'rgba(255,255,255,0.04)' : 'transparent',
        border: isActive ? `1px solid ${AMBER_BORD}` : '1px solid transparent',
        transition: 'background 0.13s, color 0.13s, border-color 0.13s',
      }}
    >
      <Icon size={16} strokeWidth={1.5} />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

function SidebarContent({ onNavClick, collapsed }: { onNavClick?: () => void; collapsed: boolean }) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { accounts, selectedAccountId, setSelectedAccountId } = useAppSettings();
  const visibleAccounts = accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && !a.archived);
  const selectedAcct = accounts.find(a => a.id === selectedAccountId);
  const displayName = (user?.user_metadata?.name as string | undefined)
    || (user?.user_metadata?.full_name as string | undefined)
    || user?.email?.split('@')[0]
    || 'Trader';
  const [rivalUsername, setRivalUsername] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rivalsApi.getProfile()
      .then(p => { if (!cancelled && p?.username) setRivalUsername(p.username); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = () => {
      rivalsApi.getProfile()
        .then(p => { if (p?.username) setRivalUsername(p.username); })
        .catch(() => {});
    };
    window.addEventListener('flyxa:profile-saved', handler);
    return () => window.removeEventListener('flyxa:profile-saved', handler);
  }, []);

  const [accountsCollapsed, setAccountsCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('flyxa-ai.sidebar.accounts.collapsed') === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('flyxa-ai.sidebar.accounts.collapsed', accountsCollapsed ? '1' : '0');
  }, [accountsCollapsed]);

  const handleAddAccountClick = () => {
    navigate('/settings#accounts');
    onNavClick?.();
  };

  const handleProfileClick = () => {
    navigate('/settings#profile');
    onNavClick?.();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Logo */}
      <button
        type="button"
        onClick={handleProfileClick}
        title="Open profile settings"
        aria-label="Open profile settings"
        style={{
        minHeight: collapsed ? 54 : 62,
        borderBottom: `1px solid ${BSUB}`,
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        background: S1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: collapsed ? 'center' : 'flex-start',
        paddingLeft: collapsed ? 0 : 12,
        cursor: 'pointer',
        width: '100%',
      }}>
        <svg
          viewBox="0 0 160 38"
          fill="none"
          preserveAspectRatio="xMinYMid meet"
          aria-hidden="true"
          style={{
            width: collapsed ? 52 : 112,
            height: collapsed ? 12 : 24,
            pointerEvents: 'none',
          }}
        >
          <line x1="0" y1="27" x2="48" y2="27" stroke="rgba(245,158,11,0.55)" strokeWidth="1.8" strokeLinecap="round" />
          <line x1="48" y1="27" x2="76" y2="9" stroke="#F59E0B" strokeWidth="2.2" strokeLinecap="round" />
          <line x1="76" y1="9" x2="160" y2="9" stroke="#F59E0B" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="48" cy="27" r="4.8" fill="#F59E0B" />
        </svg>
      </button>

      {/* Nav + Accounts */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: collapsed ? '12px 6px' : '12px 8px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Main nav */}
        <div>
          {!collapsed && (
            <p style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: T3, padding: '0 12px', marginBottom: 5,
            }}>Main</p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {navItems.map(item => (
              <NavItem
                key={item.path}
                path={item.path}
                icon={item.icon}
                label={item.label}
                exact={item.path === '/'}
                onClick={onNavClick}
                collapsed={collapsed}
                extraActivePaths={item.extraActivePaths}
              />
            ))}
          </div>
        </div>

        {/* Accounts */}
        {visibleAccounts.length > 0 && (
          <div>
            {collapsed ? (
              <button
                type="button"
                title={accountsCollapsed ? 'Show accounts' : 'Hide accounts'}
                aria-label={accountsCollapsed ? 'Show accounts' : 'Hide accounts'}
                onClick={() => setAccountsCollapsed(current => !current)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 30,
                  height: 28,
                  margin: '0 auto 5px',
                  borderRadius: 6,
                  border: 'none',
                  background: 'transparent',
                  color: T3,
                  cursor: 'pointer',
                  lineHeight: 0,
                }}
              >
                {accountsCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
              </button>
            ) : (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '0 8px 0 12px',
                marginBottom: 5,
              }}>
                <p style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: T3, margin: 0,
                }}>Accounts</p>
                <button
                  type="button"
                  title={accountsCollapsed ? 'Show accounts' : 'Hide accounts'}
                  aria-label={accountsCollapsed ? 'Show accounts' : 'Hide accounts'}
                  onClick={() => setAccountsCollapsed(current => !current)}
                  style={{
                    width: 24,
                    height: 22,
                    borderRadius: 5,
                    border: 'none',
                    background: 'transparent',
                    color: T3,
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    lineHeight: 0,
                  }}
                >
                  {accountsCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                </button>
              </div>
            )}
            {collapsed ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
                {!accountsCollapsed && visibleAccounts.map(acct => {
                  const sel = selectedAccountId === acct.id;
                  return (
                    <button
                      key={acct.id}
                      title={`${acct.name} (${acct.status})`}
                      onClick={() => setSelectedAccountId(acct.id)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 30, height: 30, borderRadius: '50%',
                        border: sel ? `1px solid ${AMBER_BORD}` : `1px solid ${BSUB}`,
                        cursor: 'pointer', background: sel ? AMBER_DIM : 'transparent',
                      }}
                    >
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: acct.color || AMBER, flexShrink: 0 }} />
                    </button>
                  );
                })}
                <button
                  type="button"
                  title="Add account"
                  onClick={handleAddAccountClick}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 30, height: 30, borderRadius: '50%',
                    border: `1px solid ${AMBER_BORD}`,
                    cursor: 'pointer', background: AMBER_DIM, color: AMBER,
                  }}
                >
                  <Plus size={14} />
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {!accountsCollapsed && visibleAccounts.map(acct => {
                  const sel = selectedAccountId === acct.id;
                  return (
                    <button
                      key={acct.id}
                      onClick={() => setSelectedAccountId(acct.id)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 9,
                        width: '100%', padding: '7px 12px', borderRadius: 6,
                        border: 'none', cursor: 'pointer', textAlign: 'left',
                        background: sel ? 'rgba(255,255,255,0.04)' : 'transparent',
                        fontSize: 12, fontFamily: SANS,
                        color: sel ? T1 : T2,
                        transition: 'background 0.13s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = sel ? 'rgba(255,255,255,0.04)' : 'transparent'; }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: accountStatusColor(acct.status), flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {acct.name}
                      </span>
                      <span style={{ fontSize: 9, color: accountStatusColor(acct.status), textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {acct.status}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={handleAddAccountClick}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '8px 12px', borderRadius: 6,
                    border: `1px dashed ${AMBER_BORD}`, cursor: 'pointer',
                    textAlign: 'left', background: AMBER_DIM,
                    fontSize: 12, fontWeight: 500, fontFamily: SANS, color: AMBER,
                    marginTop: 6,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
                >
                  <Plus size={13} />
                  Add account
                </button>
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Billing + settings */}
      <div style={{ padding: collapsed ? '8px 6px 0' : '8px 8px 0', borderTop: `1px solid ${BSUB}` }}>
        <NavItem path="/billing" icon={CreditCard} label="Billing" onClick={onNavClick} collapsed={collapsed} />
        <NavItem path="/settings" icon={Settings} label="Settings" onClick={onNavClick} collapsed={collapsed} />
      </div>

      {/* User card */}
      {collapsed ? (
        <div style={{ padding: '10px 0 14px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={handleProfileClick}
            title="Open profile settings"
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: AMBER_DIM, border: `1px solid ${AMBER_BORD}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, color: AMBER, fontFamily: MONO,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            {displayName.slice(0, 2).toUpperCase()}
          </button>
          <button
            onClick={signOut}
            title="Sign out"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: T3, padding: 4, lineHeight: 0 }}
            onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; }}
            onMouseLeave={e => { e.currentTarget.style.color = T3; }}
          >
            <LogOut size={13} />
          </button>
        </div>
      ) : (
        <div style={{ padding: '10px 12px 14px', display: 'flex', alignItems: 'center', gap: 9 }}>
          <button
            type="button"
            onClick={handleProfileClick}
            title="Open profile settings"
            style={{
            width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
            background: AMBER_DIM, border: `1px solid ${AMBER_BORD}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: AMBER, fontFamily: MONO,
            cursor: 'pointer',
            padding: 0,
          }}>
            {displayName.slice(0, 2).toUpperCase()}
          </button>
          <button
            type="button"
            onClick={handleProfileClick}
            title="Open profile settings"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              background: 'transparent',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500, color: T1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {rivalUsername ?? displayName}
            </div>
            <div style={{ fontSize: 10, color: T3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user?.email ?? selectedAcct?.status?.toLowerCase() ?? 'free plan'}
            </div>
          </button>
          <button
            onClick={signOut}
            title="Sign out"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: T3, padding: 4, lineHeight: 0 }}
            onMouseEnter={e => { e.currentTarget.style.color = '#f87171'; }}
            onMouseLeave={e => { e.currentTarget.style.color = T3; }}
          >
            <LogOut size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

function MobileDrawer() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('flyxa:open-mobile-nav', handler);
    return () => window.removeEventListener('flyxa:open-mobile-nav', handler);
  }, []);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        display: 'flex',
      }}
    >
      {/* Drawer panel */}
      <div
        style={{
          width: 280,
          height: '100%',
          background: S1,
          borderRight: `1px solid ${BORDER}`,
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
          animation: 'mobile-drawer-in 0.22s ease both',
        }}
      >
        <SidebarContent collapsed={false} onNavClick={() => setOpen(false)} />
      </div>
      {/* Backdrop */}
      <div
        style={{
          flex: 1,
          background: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(2px)',
        }}
        onClick={() => setOpen(false)}
      />
    </div>
  );
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    const next = window.localStorage.getItem('flyxa-ai.sidebar.collapsed');
    const legacy = window.localStorage.getItem('tradewise.sidebar.collapsed');
    return (next ?? legacy) === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('flyxa-ai.sidebar.collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  return (
    <>
      <aside
        className="hidden md:flex flex-col flex-shrink-0"
        style={{
          width: collapsed ? 72 : 220,
          height: '100vh',
          position: 'sticky',
          top: 0,
          overflow: 'visible',
          background: S1,
          borderRight: `1px solid ${BORDER}`,
          transition: 'width 0.2s cubic-bezier(.4,0,.2,1)',
        }}
      >
        <button
          onClick={() => setCollapsed(current => !current)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            position: 'absolute',
            top: 16,
            right: 0,
            transform: 'translateX(50%)',
            width: 24,
            height: 36,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--app-panel-strong)',
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            color: T2,
            cursor: 'pointer',
            boxShadow: '0 6px 16px rgba(0,0,0,0.28)',
            zIndex: 20,
          }}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
        </button>
        <SidebarContent collapsed={collapsed} />
      </aside>
      <MobileDrawer />
    </>
  );
}
