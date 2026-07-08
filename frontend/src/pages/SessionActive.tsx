import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import { useRisk } from '../contexts/RiskContext.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { flushSupabaseStoreNow } from '../store/supabaseStorage.js';
import { getPreSessionDate, isLivePreSession, markPreSessionEnded } from '../utils/sessionLifecycle.js';
import {
  clearStaleGuardSessionTrades,
  readGuardSessionTrades,
  SESSION_TRADES_STORAGE,
  summarizeGuardSessionTrades,
  type GuardSessionTrade,
} from '../hooks/useGuardSessionTrades.js';

type BiasValue = 'Bull' | 'Bear' | 'Neutral';
type BiasState = Record<string, BiasValue>;

const AMBER   = '#f59e0b';
const GREEN   = '#22d68a';
const RED     = '#f05252';
const SANS    = 'var(--font-sans)';
const MONO    = 'var(--font-mono)';
const T1      = 'var(--app-text)';
const T2      = 'var(--app-text-muted)';
const T3      = 'var(--app-text-subtle)';
const BORDER  = 'var(--app-border)';

function biasColor(v: string): string {
  if (v === 'Bull') return GREEN;
  if (v === 'Bear') return RED;
  return '#6b7280';
}

function readinessColor(status: string): string {
  if (status === 'Ready') return GREEN;
  if (status === 'Caution') return AMBER;
  return RED;
}

function planLabel(source: string): { tag: string; color: string } {
  const s = source.toLowerCase();
  if (s.includes('focus') || s.includes('primary')) return { tag: 'FOCUS',     color: AMBER };
  if (s.includes('avoid'))                            return { tag: 'AVOID',     color: '#f87171' };
  if (s.includes('hard') || s.includes('stop'))       return { tag: 'HARD STOP', color: RED };
  return { tag: source.slice(0, 10).toUpperCase(),    color: T3 };
}

function formatElapsed(startedAt: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatMoney(val: number, withSign = false): string {
  const abs = Math.abs(val);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!withSign) return `$${str}`;
  return `${val >= 0 ? '+' : '−'}$${str}`;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SessionActive() {
  const navigate = useNavigate();
  const preSession  = useFlyxaStore(s => s.preSession);
  const setPreSession = useFlyxaStore(s => s.setPreSession);
  const setPreSessionForDate = useFlyxaStore(s => s.setPreSessionForDate);
  const { dailyStatus, riskLevel } = useRisk();
  const { preferences } = useAppSettings();

  const [elapsed, setElapsed] = useState('00:00');
  const activeStartedAt = isLivePreSession(preSession) ? preSession.startedAt : undefined;
  const [guardTrades, setGuardTrades] = useState<GuardSessionTrade[]>(() => readGuardSessionTrades(activeStartedAt));
  const guardSummary = summarizeGuardSessionTrades(guardTrades);

  // Redirect to pre-session if no active session
  useEffect(() => {
    if (!isLivePreSession(preSession)) {
      navigate('/pre-session', { replace: true });
    }
  }, [preSession, navigate]);

  // Tick elapsed timer every second
  useEffect(() => {
    if (!activeStartedAt) return;
    const tick = () => setElapsed(formatElapsed(activeStartedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeStartedAt]);

  useEffect(() => {
    clearStaleGuardSessionTrades(activeStartedAt);
  }, [activeStartedAt]);

  useEffect(() => {
    const refresh = () => setGuardTrades(readGuardSessionTrades(activeStartedAt));
    const storageHandler = (event: StorageEvent) => {
      if (event.key === SESSION_TRADES_STORAGE) refresh();
    };
    const messageHandler = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'flyxa:session-trades-updated') refresh();
    };
    window.addEventListener('storage', storageHandler);
    window.addEventListener('message', messageHandler);
    window.addEventListener('flyxa:session-trades-updated', refresh);
    const poll = window.setInterval(refresh, 500);
    refresh();
    return () => {
      window.removeEventListener('storage', storageHandler);
      window.removeEventListener('message', messageHandler);
      window.removeEventListener('flyxa:session-trades-updated', refresh);
      window.clearInterval(poll);
    };
  }, [activeStartedAt]);

  // Rotate the session-rule ticker every 8 seconds
  const [ruleIdx, setRuleIdx] = useState(0);
  const planLen = isLivePreSession(preSession) ? (preSession.sessionPlan?.length ?? 0) : 0;
  useEffect(() => {
    if (planLen < 2) return;
    const id = window.setInterval(() => setRuleIdx(i => (i + 1) % planLen), 8000);
    return () => window.clearInterval(id);
  }, [planLen]);

  if (!isLivePreSession(preSession)) return null;

  // ── Derived values ──────────────────────────────────────
  const bias       = preSession.bias as BiasState | null;
  const readiness  = preSession.readiness;
  const plan       = preSession.sessionPlan ?? [];
  const emotion    = preSession.emotion;

  const dbPnl         = dailyStatus?.todayPnL ?? 0;
  const dbTradesCount = dailyStatus?.tradesCount ?? 0;
  const hasGuardLog   = guardSummary.count > 0;
  const pnl           = hasGuardLog ? guardSummary.pnl : dbPnl;
  const tradesCount   = Math.max(dbTradesCount, guardSummary.count);
  const maxTrades     = dailyStatus?.maxTradesPerDay ?? 0;
  const lossLimit     = (preSession as { sessionMaxLoss?: number | null }).sessionMaxLoss
    ?? dailyStatus?.dailyLossLimit
    ?? 0;
  const dbLossUsed    = Math.abs(Math.min(0, dbPnl));
  const lossUsed      = Math.max(dbLossUsed, guardSummary.loss);
  const lossUsedPct   = lossLimit > 0 ? Math.min(100, (lossUsed / lossLimit) * 100) : Math.min(100, dailyStatus?.lossUsedPercent ?? 0);
  const lossRemaining = lossLimit > 0 ? Math.max(0, lossLimit - lossUsed) : null;

  const pnlPositive = pnl > 0;
  const pnlNegative = pnl < 0;
  const pnlColor    = pnlPositive ? GREEN : pnlNegative ? RED : T2;
  const PnLIcon     = pnlPositive ? TrendingUp : pnlNegative ? TrendingDown : Minus;

  const riskColor = riskLevel === 'locked' || riskLevel === 'danger' ? RED
    : riskLevel === 'warning' ? AMBER
    : GREEN;

  const handleEnd = () => {
    const sessionDate = getPreSessionDate(preSession, preferences.timezone);
    const existingSession = useFlyxaStore.getState().preSessionHistory[sessionDate];
    const endedSession = markPreSessionEnded(preSession, existingSession);
    setPreSession(null);
    setPreSessionForDate(sessionDate, endedSession);
    void flushSupabaseStoreNow();
    navigate(`/post-session?date=${sessionDate}`);
  };

  // ── Render ──────────────────────────────────────────────
  const profitTarget = (preSession as { dailyTarget?: number | null }).dailyTarget ?? null;
  const targetPct = profitTarget && profitTarget > 0 ? Math.min(100, Math.max(0, (pnl / profitTarget) * 100)) : null;
  const tradePips = maxTrades > 0 && maxTrades <= 12 ? maxTrades : 0;
  const startedLabel = new Date(preSession.startedAt).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: true,
  });
  const locked = riskLevel === 'locked';
  const glowColor = locked ? RED : pnlPositive ? GREEN : pnlNegative ? RED : AMBER;
  const activeRule = plan.length > 0 ? plan[ruleIdx % plan.length] : null;
  const activeRuleTag = activeRule ? planLabel(activeRule.source) : null;

  return (
    <div style={{
      height: '100%',
      position: 'relative',
      overflow: 'hidden',
      background: 'var(--app-bg)',
      fontFamily: SANS,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* ── Top strip ──────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, padding: '22px 32px', position: 'relative', zIndex: 1,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8, flexShrink: 0 }}>
            <span className="session-ping" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: GREEN, opacity: 0.75 }} />
            <span style={{ position: 'relative', width: 8, height: 8, borderRadius: '50%', background: GREEN, display: 'inline-block' }} />
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.22em', color: GREEN, textTransform: 'uppercase' }}>
            Session live
          </span>
          <span style={{ fontSize: 11, color: T3, letterSpacing: '0.04em' }}>since {startedLabel} ET</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {readiness && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: readinessColor(readiness.status),
              padding: '3px 10px', borderRadius: 999,
              border: `1px solid ${readinessColor(readiness.status)}35`,
              background: `${readinessColor(readiness.status)}0d`,
            }}>
              {readiness.status} {readiness.score}
            </span>
          )}
          {bias && Object.entries(bias).map(([sym, val]) => (
            <span key={sym} style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: biasColor(val as string),
              padding: '3px 10px', borderRadius: 999,
              border: `1px solid ${biasColor(val as string)}30`,
              background: `${biasColor(val as string)}0d`,
            }}>
              <span style={{ fontFamily: MONO, color: T3, marginRight: 5 }}>{sym}</span>{val}
            </span>
          ))}
          {emotion && (
            <span style={{
              fontSize: 10, color: T3, letterSpacing: '0.04em',
              padding: '3px 10px', borderRadius: 999, border: `1px solid ${BORDER}`,
            }}>
              {emotion}
            </span>
          )}
        </div>
      </div>

      {/* ── Center: timer + P&L ────────────────────── */}
      <div style={{
        flex: 1,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 6, position: 'relative', zIndex: 1,
        paddingBottom: 40,
      }}>
        <span style={{
          fontSize: 'clamp(72px, 12vw, 150px)',
          fontWeight: 250,
          fontFamily: MONO,
          color: T1,
          lineHeight: 1,
          letterSpacing: '0.02em',
          fontVariantNumeric: 'tabular-nums',
          textShadow: `0 0 80px ${glowColor}30`,
        }}>
          {elapsed}
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18 }}>
          {pnl !== 0 && <PnLIcon size={26} color={pnlColor} strokeWidth={1.6} />}
          <span style={{
            fontSize: 'clamp(28px, 3.4vw, 42px)',
            fontWeight: 600,
            fontFamily: MONO,
            color: pnlColor,
            lineHeight: 1,
            letterSpacing: '-0.01em',
          }}>
            {formatMoney(pnl, true)}
          </span>
        </div>

        <span style={{ fontSize: 12, color: T3, letterSpacing: '0.06em', marginTop: 8 }}>
          {tradesCount} trade{tradesCount !== 1 ? 's' : ''}
          {maxTrades > 0 && <> · {Math.max(0, maxTrades - tradesCount)} remaining</>}
        </span>

        {/* Trade pips */}
        {tradePips > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            {Array.from({ length: tradePips }, (_, i) => (
              <span key={i} style={{
                width: 22, height: 4, borderRadius: 2,
                background: i < tradesCount ? (tradesCount >= maxTrades ? RED : AMBER) : 'rgba(255,255,255,0.08)',
                transition: 'background 0.4s ease',
              }} />
            ))}
          </div>
        )}
      </div>

      {/* ── Rule ticker / locked callout ───────────── */}
      <div style={{
        minHeight: 64,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 8, padding: '0 48px', position: 'relative', zIndex: 1,
      }}>
        {locked ? (
          <span className="sa-locked" style={{
            fontSize: 15, fontWeight: 800, letterSpacing: '0.25em', textTransform: 'uppercase',
            color: RED,
          }}>
            Loss limit reached — stand down
          </span>
        ) : activeRule && activeRuleTag ? (
          <div key={ruleIdx} className="sa-rule" style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 720 }}>
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              color: activeRuleTag.color, padding: '3px 8px', borderRadius: 3,
              background: `${activeRuleTag.color}12`, border: `1px solid ${activeRuleTag.color}30`,
              flexShrink: 0, whiteSpace: 'nowrap',
            }}>
              {activeRuleTag.tag}
            </span>
            <span style={{ fontSize: 14, color: T2, lineHeight: 1.5, textAlign: 'left' }}>{activeRule.rule}</span>
          </div>
        ) : null}
        {!locked && plan.length > 1 && (
          <div style={{ display: 'flex', gap: 5 }}>
            {plan.map((_, i) => (
              <span key={i} style={{
                width: 4, height: 4, borderRadius: '50%',
                background: i === ruleIdx % plan.length ? T2 : 'rgba(255,255,255,0.12)',
                transition: 'background 0.3s ease',
              }} />
            ))}
          </div>
        )}
      </div>

      {/* ── Bottom gauges ──────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: targetPct !== null ? '1fr 1fr' : '1fr',
        gap: 40,
        padding: '26px 48px 18px',
        position: 'relative', zIndex: 1,
      }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: T3 }}>Loss budget</span>
            <span style={{ fontSize: 12, fontFamily: MONO, color: riskColor, fontWeight: 600 }}>
              {Math.round(lossUsedPct)}%{lossRemaining !== null && <span style={{ color: T3, fontWeight: 400 }}> · {formatMoney(lossRemaining)} left</span>}
            </span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${lossUsedPct}%`, borderRadius: 2, background: riskColor, transition: 'width 0.7s ease, background 0.4s ease', boxShadow: `0 0 10px ${riskColor}60` }} />
          </div>
        </div>
        {targetPct !== null && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: T3 }}>Daily target</span>
              <span style={{ fontSize: 12, fontFamily: MONO, color: targetPct >= 100 ? GREEN : T2, fontWeight: 600 }}>
                {Math.round(targetPct)}%<span style={{ color: T3, fontWeight: 400 }}> of {formatMoney(profitTarget!)}</span>
              </span>
            </div>
            <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${targetPct}%`, borderRadius: 2, background: GREEN, transition: 'width 0.7s ease', boxShadow: targetPct >= 100 ? `0 0 10px ${GREEN}60` : 'none' }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Hover-reveal controls ──────────────────── */}
      <div className="sa-controls" style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 22, padding: '4px 0 18px', position: 'relative', zIndex: 1,
      }}>
        {[
          { label: 'Journal', to: '/journal' },
          { label: 'Scanner', to: '/scanner' },
          { label: 'Analytics', to: '/analytics' },
          { label: 'Pre-session', to: '/pre-session' },
        ].map(link => (
          <button key={link.to} type="button" onClick={() => navigate(link.to)} style={{
            background: 'none', border: 'none', padding: '4px 2px', cursor: 'pointer',
            fontSize: 11, color: T3, letterSpacing: '0.06em', fontFamily: SANS,
          }}>
            {link.label}
          </button>
        ))}
        <span style={{ width: 1, height: 12, background: BORDER, display: 'inline-block' }} />
        <button type="button" onClick={handleEnd} style={{
          background: 'none', border: 'none', padding: '4px 2px', cursor: 'pointer',
          fontSize: 11, color: `${RED}cc`, letterSpacing: '0.06em', fontFamily: SANS, fontWeight: 600,
        }}>
          End session
        </button>
      </div>

      {/* ── Animations ─────────────────────────────── */}
      <style>{`
        @keyframes session-ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
        .session-ping {
          animation: session-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
        @keyframes sa-rule-in {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .sa-rule {
          animation: sa-rule-in 0.6s ease both;
        }
        @keyframes sa-locked-pulse {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.45; }
        }
        .sa-locked {
          animation: sa-locked-pulse 2.2s ease-in-out infinite;
        }
        .sa-controls {
          opacity: 0.25;
          transition: opacity 0.35s ease;
        }
        .sa-controls:hover {
          opacity: 1;
        }
        @media (prefers-reduced-motion: reduce) {
          .sa-rule, .sa-locked, .session-ping { animation: none; }
        }
      `}</style>
    </div>
  );
}

