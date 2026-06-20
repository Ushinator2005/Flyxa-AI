import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext.js';
import Layout from './components/layout/Layout.js';
import LoadingSpinner from './components/common/LoadingSpinner.js';
import ToastStack from './components/common/Toast.js';
import useFlyxaStore from './store/flyxaStore.js';
import { useDailyLossUsed } from './store/selectors.js';
import { pushToast } from './store/toastStore.js';
import { useBackgroundNewsPoller } from './hooks/useBackgroundNewsPoller.js';
import FlyxaLogo from './components/common/FlyxaLogo.js';
import { Check, AlertCircle } from 'lucide-react';

const Auth = lazy(() => import('./pages/Auth.js'));
const Dashboard = lazy(() => import('./pages/Dashboard.js'));
const TradeScanner = lazy(() => import('./pages/TradeScanner.js'));
const MarketNews = lazy(() => import('./pages/MarketNews.js'));
const FlyxaAI = lazy(() => import('./pages/FlyxaAI.js'));
const FlyxaAIPatterns = lazy(() => import('./pages/FlyxaAIPatterns.js'));
const FlyxaAIAsk = lazy(() => import('./pages/FlyxaAIAsk.js'));
const FlyxaAIPreSession = lazy(() => import('./pages/FlyxaAIPreSession.js'));
const FlyxaAIPostSession = lazy(() => import('./pages/FlyxaAIPostSession.js'));
const FlyxaAIWeeklyReport = lazy(() => import('./pages/FlyxaAIWeeklyReport.js'));
const Analytics = lazy(() => import('./pages/Analytics.js'));
const Achievements = lazy(() => import('./pages/Achievements.js'));
const Backtest = lazy(() => import('./pages/Backtest.js'));
const TradingPlan = lazy(() => import('./pages/TradingPlan.js'));
const Billing = lazy(() => import('./pages/Billing.js'));
const PsychologyTracker = lazy(() => import('./pages/PsychologyTracker.js'));
const Journal = lazy(() => import('./pages/Journal.js'));
const Goals = lazy(() => import('./pages/Goals.js'));
const Rivals = lazy(() => import('./pages/Rivals.js'));
const Settings = lazy(() => import('./pages/Settings.js'));
const TradeCheck = lazy(() => import('./pages/TradeCheck.js'));
const SessionActive = lazy(() => import('./pages/SessionActive.js'));

function RouteFallback() {
  return (
    <div className="min-h-[240px] flex items-center justify-center">
      <LoadingSpinner size="md" />
    </div>
  );
}

function PasswordRecoveryModal() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSaving(true);
    const { error: err } = await updatePassword(password);
    setSaving(false);
    if (err) { setError(err); return; }
    setDone(true);
  };

  const SANS = 'var(--font-sans)';
  const T1 = 'var(--app-text)';
  const T3 = 'var(--app-text-subtle)';
  const S1 = 'var(--app-panel)';
  const BORDER = 'var(--app-border)';
  const S2 = 'var(--app-panel-strong)';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwd-recovery-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 1500,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        background: 'rgba(10,8,6,0.88)',
        backdropFilter: 'blur(14px)',
        fontFamily: SANS,
      }}
    >
      <section style={{
        width: 'min(440px, 100%)',
        borderRadius: 14,
        border: '1px solid rgba(245,158,11,0.16)',
        background: S1,
        overflow: 'hidden',
        position: 'relative',
      }}>
        {/* Top amber accent */}
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 2,
          background: 'linear-gradient(90deg, transparent 0%, rgba(245,158,11,0.4) 20%, #f59e0b 50%, rgba(245,158,11,0.3) 80%, transparent 100%)',
        }} />

        <div style={{ padding: '32px 28px 26px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ marginBottom: 20 }}>
            <FlyxaLogo size={44} showWordmark={false} />
          </div>
          <h2 id="pwd-recovery-title" style={{ margin: 0, color: T1, fontSize: 20, fontWeight: 660, letterSpacing: '-0.025em' }}>
            {done ? 'Password updated' : 'Set a new password'}
          </h2>
          <p style={{ margin: '8px 0 0', color: T3, fontSize: 12.5, lineHeight: 1.6 }}>
            {done
              ? 'Your password has been updated. You can now continue to Flyxa.'
              : 'Choose a strong password for your account.'}
          </p>
        </div>

        <div style={{ padding: '24px 28px 28px' }}>
          {done ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 16px', borderRadius: 8,
              background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)',
              color: '#34d399', fontSize: 13,
            }}>
              <Check size={15} strokeWidth={2.5} />
              Password updated successfully. Redirecting…
            </div>
          ) : (
            <form onSubmit={(e) => { void handleSubmit(e); }}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: T3, marginBottom: 7 }}>
                  New password
                </label>
                <input
                  type="password"
                  autoFocus
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Minimum 6 characters"
                  required
                  style={{
                    width: '100%', height: 44, borderRadius: 8,
                    border: `1px solid ${BORDER}`, background: S2,
                    color: T1, padding: '0 14px', fontSize: 13.5,
                    fontFamily: SANS, outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: T3, marginBottom: 7 }}>
                  Confirm password
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  placeholder="Repeat your new password"
                  required
                  style={{
                    width: '100%', height: 44, borderRadius: 8,
                    border: `1px solid ${BORDER}`, background: S2,
                    color: T1, padding: '0 14px', fontSize: 13.5,
                    fontFamily: SANS, outline: 'none', boxSizing: 'border-box',
                  }}
                />
              </div>
              {error && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '10px 14px', borderRadius: 8, marginBottom: 14,
                  background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)',
                  color: '#f87171', fontSize: 12,
                }}>
                  <AlertCircle size={14} />
                  {error}
                </div>
              )}
              <button
                type="submit"
                disabled={saving}
                style={{
                  width: '100%', height: 44, borderRadius: 8, border: 'none',
                  background: saving ? 'rgba(245,158,11,0.45)' : 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
                  color: '#0a0806', fontSize: 13.5, fontWeight: 750,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  boxShadow: saving ? 'none' : '0 4px 20px rgba(245,158,11,0.22)',
                  transition: 'opacity 0.15s',
                  fontFamily: SANS,
                }}
              >
                <Check size={15} strokeWidth={2.5} />
                {saving ? 'Saving…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}

function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;
  return <Outlet />;
}

function ProtectedLayout() {
  return <Layout />;
}

export default function App() {
  const { user, loading, isPasswordRecovery } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const hydrateSharedData = useFlyxaStore(state => state.hydrateSharedData);
  const hasWarned80 = useRef(false);
  const hasWarnedHit = useRef(false);
  const dailyLoss = useDailyLossUsed();
  const isTradeCheckRoute = location.pathname === '/trade-check';

  // Browser extension bridge — receives chart captures from the Flyxa Chrome
  // extension on ANY page, converts the base64 PNG to a File, navigates to
  // /scanner, then makes the file available for TradeJournal to pick up.
  //
  // Two-path delivery:
  //   • window.__flyxaPendingFile  — for when TradeJournal hasn't mounted yet
  //     (new tab or navigation from another page); the component reads this on mount.
  //   • flyxa:scan_ready event     — for when TradeJournal is already mounted.
  useEffect(() => {
    const handler = async (e: Event) => {
      const base64 = (e as CustomEvent<{ base64: string }>).detail?.base64;
      if (!base64) return;
      try {
        const dataUrl = base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
        const blob = await fetch(dataUrl).then(r => r.blob());
        const file = new File([blob], 'chart.png', { type: 'image/png' });
        // Store for TradeJournal to consume on mount (race-condition-safe)
        (window as unknown as Record<string, unknown>).__flyxaPendingFile = file;
        navigate('/scanner');
        // Also fire immediately for already-mounted case
        window.dispatchEvent(new CustomEvent('flyxa:scan_ready', { detail: { file } }));
      } catch (err) {
        console.error('[Flyxa] Extension screenshot error:', err);
      }
    };
    window.addEventListener('flyxa:ext_screenshot', handler);
    return () => window.removeEventListener('flyxa:ext_screenshot', handler);
  }, [navigate]);

  // Silently poll Finnhub every 5 min; write AI-confirmed breaking news to
  // flyxa_breaking_cache_v1 so the Dashboard bubble fires without the user
  // having to open the Market News page first.
  useBackgroundNewsPoller(!!user);

  useEffect(() => {
    if (!user || typeof window === 'undefined') return;
    if (window.localStorage.getItem('flyxa_store_migrated_v1') === '1') return;

    const payload: Parameters<typeof hydrateSharedData>[0] = {};

    try {
      const entriesRaw = window.localStorage.getItem('flyxa_entries');
      if (entriesRaw) payload.entries = JSON.parse(entriesRaw) as typeof payload.entries;
    } catch {
      // Ignore malformed legacy data.
    }

    try {
      const billingRaw = window.localStorage.getItem('flyxa_billing_accounts');
      if (billingRaw) payload.billingAccounts = JSON.parse(billingRaw) as typeof payload.billingAccounts;
    } catch {
      // Ignore malformed legacy data.
    }

    try {
      const tradingPlanRaw = window.localStorage.getItem('flyxa_trading_plan_state_v1');
      if (tradingPlanRaw) {
        const parsed = JSON.parse(tradingPlanRaw) as {
          planBlocks?: unknown;
          checklist?: unknown;
          setups?: unknown;
        };
        if (parsed.planBlocks) payload.planBlocks = parsed.planBlocks as typeof payload.planBlocks;
        if (parsed.checklist) payload.checklist = parsed.checklist as typeof payload.checklist;
        if (parsed.setups) payload.setupPlaybook = parsed.setups as typeof payload.setupPlaybook;
      }
    } catch {
      // Ignore malformed legacy data.
    }

    try {
      const checklistRaw = window.localStorage.getItem('flyxa_checklist');
      if (checklistRaw && !payload.checklist) {
        const parsed = JSON.parse(checklistRaw) as unknown[];
        if (Array.isArray(parsed)) {
          payload.checklist = parsed.map((text, index) => ({
            id: `cl-${index + 1}`,
            text: typeof text === 'string' ? text : `Rule ${index + 1}`,
            done: false,
          }));
        }
      }
    } catch {
      // Ignore malformed legacy data.
    }

    try {
      const prefsRaw = window.localStorage.getItem(`tw_preferences_${user.id}`);
      if (prefsRaw) {
        const parsed = JSON.parse(prefsRaw) as { scannerColors?: unknown };
        if (parsed.scannerColors && typeof parsed.scannerColors === 'object') {
          payload.scannerColors = parsed.scannerColors as typeof payload.scannerColors;
        }
      }
    } catch {
      // Ignore malformed legacy data.
    }

    try {
      const goalsRaw = window.localStorage.getItem('tw_goals_local');
      if (goalsRaw) payload.goals = JSON.parse(goalsRaw) as typeof payload.goals;
    } catch {
      // Ignore malformed legacy data.
    }

    if (Object.keys(payload).length > 0) {
      hydrateSharedData(payload);
    }

    [
      'flyxa_entries',
      'flyxa_accounts',
      'flyxa_billing_accounts',
      'flyxa_trading_plan_state_v1',
      'flyxa_checklist',
      'tw_goals_local',
    ].forEach((key) => window.localStorage.removeItem(key));

    window.localStorage.setItem('flyxa_store_migrated_v1', '1');
  }, [hydrateSharedData, user]);


  useEffect(() => {
    if (dailyLoss.limit <= 0 || isTradeCheckRoute) return;

    if (dailyLoss.pct >= 100 && !hasWarnedHit.current) {
      pushToast({
        tone: 'red',
        durationMs: null,
        message: `Daily loss limit reached - stop trading for today`,
      });
      hasWarnedHit.current = true;
      hasWarned80.current = true;
      return;
    }

    if (dailyLoss.pct >= 80 && !hasWarned80.current) {
      pushToast({
        tone: 'red',
        durationMs: null,
        message: `Daily loss limit: 80% used - ${dailyLoss.remaining.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })} remaining`,
      });
      hasWarned80.current = true;
    }

    if (dailyLoss.pct < 80) {
      hasWarned80.current = false;
      hasWarnedHit.current = false;
    }
  }, [dailyLoss.limit, dailyLoss.pct, dailyLoss.remaining, isTradeCheckRoute]);

  if (loading) {
    return (
      <div className="app-shell min-h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" label="Loading Flyxa..." />
      </div>
    );
  }

  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/auth" element={user ? <Navigate to="/" replace /> : <Auth />} />
          <Route path="/landing" element={<Navigate to={user ? '/' : '/auth'} replace />} />

          <Route element={<ProtectedRoute />}>
            <Route path="/trade-check" element={<TradeCheck />} />
            <Route element={<ProtectedLayout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/scanner" element={<TradeScanner />} />
              <Route path="/market-news" element={<MarketNews />} />
              <Route path="/flyxa-ai" element={<FlyxaAI />} />
              <Route path="/flyxa-ai/patterns" element={<FlyxaAIPatterns />} />
              <Route path="/flyxa-ai/ask" element={<FlyxaAIAsk />} />
              <Route path="/pre-session" element={<FlyxaAIPreSession />} />
              <Route path="/post-session" element={<FlyxaAIPostSession />} />
              <Route path="/flyxa-ai/pre-session" element={<Navigate to="/pre-session" replace />} />
              <Route path="/flyxa-ai/post-session" element={<Navigate to="/post-session" replace />} />
              <Route path="/flyxa-ai/weekly-report" element={<FlyxaAIWeeklyReport />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/achievements" element={<Achievements />} />
              <Route path="/backtest" element={<Backtest />} />
              <Route path="/trading-plan" element={<TradingPlan />} />
              <Route path="/billing" element={<Billing />} />
              <Route path="/chart" element={<Navigate to="/backtest" replace />} />
              <Route path="/psychology" element={<PsychologyTracker />} />
              <Route path="/session" element={<SessionActive />} />
              <Route path="/journal" element={<Journal />} />
              <Route path="/goals" element={<Goals />} />
              <Route path="/rivals" element={<Rivals />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/risk" element={<Navigate to="/" replace />} />
              <Route path="/playbook" element={<Navigate to="/" replace />} />
              <Route path="/chart-analyzer" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to={user ? '/' : '/auth'} replace />} />
        </Routes>
      </Suspense>
      {!isTradeCheckRoute && <ToastStack />}
      {isPasswordRecovery && <PasswordRecoveryModal />}
    </>
  );
}
