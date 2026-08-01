import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Brain, BarChart2, Target,
  FileText, Crosshair, Swords, Trophy,
  Settings, LogOut, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, CreditCard, ScanLine, Newspaper, ClipboardCheck, ShieldCheck, LockKeyhole, X,
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

type NavItemDef = { path: string; icon: typeof LayoutDashboard; label: string; extraActivePaths?: string[] };

const primaryNavItems: NavItemDef[] = [
  { path: '/',             icon: LayoutDashboard, label: 'Dashboard',    extraActivePaths: [] },
  { path: '/scanner',      icon: ScanLine,        label: 'Trade Scanner' },
  { path: '/pre-session',  icon: ClipboardCheck,  label: 'Session',      extraActivePaths: ['/post-session'] },
  { path: '/evaluation-coach', icon: ShieldCheck,  label: 'Evaluation'   },
  { path: '/analytics',    icon: BarChart2,       label: 'Analytics'     },
  { path: '/flyxa-ai',     icon: Brain,           label: 'Flyxa AI'      },
  { path: '/market-news',  icon: Newspaper,       label: 'Market News'   },
  { path: '/journal',      icon: FileText,        label: 'Daily Journal' },
  { path: '/rules',        icon: LockKeyhole,     label: 'Rules'         },
  { path: '/rivals',       icon: Swords,          label: 'Rivals'        },
];

const moreNavItems: NavItemDef[] = [
  { path: '/backtest',     icon: Target,          label: 'Backtest'      },
  { path: '/goals',        icon: Crosshair,       label: 'Goals'         },
  { path: '/achievements', icon: Trophy,          label: 'Achievements'  },
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
        border: '1px solid transparent',
        transition: 'background 0.13s, color 0.13s, border-color 0.13s',
      }}
    >
      {/* Icons only survive in the collapsed rail, where they ARE the nav.
          Expanded, the labels carry it, icon rows read cluttered. */}
      {collapsed && <Icon size={16} strokeWidth={1.5} />}
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

function SidebarContent({ onNavClick, collapsed }: { onNavClick?: () => void; collapsed: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { accounts, selectedAccountId, setSelectedAccountId } = useAppSettings();
  const visibleAccounts = accounts.filter(a => a.id !== DEFAULT_ACCOUNT_ID && !a.archived);
  const selectedAcct = accounts.find(a => a.id === selectedAccountId);
  const displayName = (user?.user_metadata?.name as string | undefined)
    || (user?.user_metadata?.full_name as string | undefined)
    || user?.email?.split('@')[0]
    || 'Trader';
  // Seed from sessionStorage so the username shows immediately on page load
  // (sessionStorage is ephemeral UI state — cleared when the tab closes)
  const [rivalUsername, setRivalUsername] = useState<string | null>(() =>
    window.sessionStorage.getItem('flyxa:sidebar:username') || null
  );
  const [rivalAvatarUrl, setRivalAvatarUrl] = useState<string | null>(() =>
    window.sessionStorage.getItem('flyxa:sidebar:avatarUrl') || null
  );

  // "More" section — auto-open when current route is one of the more items
  const moreActive = moreNavItems.some(item =>
    location.pathname === item.path || location.pathname.startsWith(item.path + '/')
  );
  const [moreOpen, setMoreOpen] = useState(moreActive);
  useEffect(() => { if (moreActive) setMoreOpen(true); }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    rivalsApi.getProfile()
      .then(p => {
        if (cancelled) return;
        if (p?.username) {
          setRivalUsername(p.username);
          window.sessionStorage.setItem('flyxa:sidebar:username', p.username);
        }
        if (p?.avatarUrl) {
          setRivalAvatarUrl(p.avatarUrl);
          window.sessionStorage.setItem('flyxa:sidebar:avatarUrl', p.avatarUrl);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const handler = () => {
      rivalsApi.getProfile()
        .then(p => {
          if (p?.username) {
            setRivalUsername(p.username);
            window.sessionStorage.setItem('flyxa:sidebar:username', p.username);
          }
          if (p?.avatarUrl) {
            setRivalAvatarUrl(p.avatarUrl);
            window.sessionStorage.setItem('flyxa:sidebar:avatarUrl', p.avatarUrl);
          }
        })
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
          viewBox="0 0 100 100"
          fill="none"
          aria-hidden="true"
          style={{
            width: collapsed ? 26 : 28,
            height: collapsed ? 26 : 28,
            pointerEvents: 'none',
            flexShrink: 0,
          }}
        >
          <path d="M52 48 C60 30 74 14 91 7 C87 25 72 41 52 48 Z" fill="#F97316" />
          <path d="M52 48 C60 30 74 14 91 7 C87 25 72 41 52 48 Z" fill="var(--app-text)" transform="rotate(-90 50 50) translate(9 9) scale(0.82)" />
          <path d="M52 48 C60 30 74 14 91 7 C87 25 72 41 52 48 Z" fill="var(--app-text)" transform="rotate(90 50 50) translate(6 6) scale(0.88)" />
          <path d="M52 48 C60 30 74 14 91 7 C87 25 72 41 52 48 Z" fill="var(--app-text)" transform="rotate(180 50 50) translate(18 18) scale(0.64)" />
        </svg>
        {!collapsed && (
          <span style={{ marginLeft: 10, fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, color: 'var(--app-text)', letterSpacing: '-0.01em' }}>
            Flyxa
          </span>
        )}
      </button>

      {/* Nav + Accounts */}
      <nav style={{ flex: 1, overflowY: 'auto', padding: collapsed ? '12px 6px' : '12px 8px', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Primary nav */}
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {primaryNavItems.map(item => {
              const isSessionItem = item.path === '/pre-session';
              const path = item.path;
              const extraActivePaths = isSessionItem
                ? ['/post-session', '/session']
                : item.extraActivePaths;
              return (
                <NavItem
                  key={item.path}
                  path={path}
                  icon={item.icon}
                  label={item.label}
                  exact={item.path === '/'}
                  onClick={onNavClick}
                  collapsed={collapsed}
                  extraActivePaths={extraActivePaths}
                />
              );
            })}
          </div>
        </div>

        {/* More (collapsed by default) */}
        <div>
          {!collapsed ? (
            <>
              <button
                type="button"
                onClick={() => setMoreOpen(o => !o)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 8, padding: '0 8px 0 12px', marginBottom: moreOpen ? 4 : 0,
                  width: '100%', border: 'none', background: 'transparent', cursor: 'pointer',
                }}
              >
                <p style={{ fontSize: 11, fontWeight: 500, color: T3, margin: 0 }}>More</p>
                <ChevronDown
                  size={13}
                  style={{ color: T3, transform: moreOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
                />
              </button>
              {moreOpen && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {moreNavItems.map(item => (
                    <NavItem
                      key={item.path}
                      path={item.path}
                      icon={item.icon}
                      label={item.label}
                      onClick={onNavClick}
                      collapsed={false}
                      extraActivePaths={item.extraActivePaths}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            /* Collapsed: show all more icons (tooltip shows label) */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {moreNavItems.map(item => (
                <NavItem
                  key={item.path}
                  path={item.path}
                  icon={item.icon}
                  label={item.label}
                  onClick={onNavClick}
                  collapsed={true}
                  extraActivePaths={item.extraActivePaths}
                />
              ))}
            </div>
          )}
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
                  fontSize: 11, fontWeight: 500,
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
              background: rivalAvatarUrl ? 'transparent' : AMBER_DIM,
              border: `1px solid ${AMBER_BORD}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 500, color: AMBER, fontFamily: MONO,
              cursor: 'pointer',
              padding: 0,
              overflow: 'hidden',
            }}
          >
            {rivalAvatarUrl
              ? <img src={rivalAvatarUrl} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : displayName.slice(0, 2).toUpperCase()
            }
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
            background: rivalAvatarUrl ? 'transparent' : AMBER_DIM,
            border: `1px solid ${AMBER_BORD}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 500, color: AMBER, fontFamily: MONO,
            cursor: 'pointer',
            padding: 0,
            overflow: 'hidden',
          }}>
            {rivalAvatarUrl
              ? <img src={rivalAvatarUrl} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : displayName.slice(0, 2).toUpperCase()
            }
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
          position: 'relative',
          animation: 'mobile-drawer-in 0.22s ease both',
        }}
      >
        {/* Close button — overlaid top-right of drawer */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
          title="Close navigation"
          style={{
            position: 'absolute',
            top: 13,
            right: 10,
            zIndex: 10,
            width: 26,
            height: 26,
            borderRadius: 5,
            border: `1px solid ${BORDER}`,
            background: 'rgba(255,255,255,0.05)',
            color: T3,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={12} />
        </button>
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

  useEffect(() => {
    const handler = () => setCollapsed(true);
    window.addEventListener('flyxa:collapse-sidebar', handler);
    return () => window.removeEventListener('flyxa:collapse-sidebar', handler);
  }, []);

  return (
    <>
      <aside
        className="hidden md:flex flex-col flex-shrink-0"
        style={{
          width: collapsed ? 72 : 220,
          height: '100vh',
          position: 'sticky',
          top: 0,
          zIndex: 50,
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
