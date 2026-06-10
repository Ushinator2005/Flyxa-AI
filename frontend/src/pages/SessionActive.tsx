import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  TrendingUp, TrendingDown, Minus,
  FileText, BarChart2, ScanLine,
  LogOut, Shield,
} from 'lucide-react';
import useFlyxaStore from '../store/flyxaStore.js';
import { useRisk } from '../contexts/RiskContext.js';
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
const S1      = 'var(--app-panel)';
const S2      = 'var(--app-panel-strong)';
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

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ children, dimBorder = false }: { children: React.ReactNode; dimBorder?: boolean }) {
  return (
    <div style={{
      border: `1px solid ${dimBorder ? 'rgba(255,255,255,0.05)' : BORDER}`,
      borderRadius: 12,
      background: S1,
      padding: '16px 18px',
    }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: T3,
      marginBottom: 12,
      fontFamily: SANS,
    }}>
      {children}
    </div>
  );
}

function QuickBtn({
  icon, label, onClick, variant = 'default',
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'primary' | 'danger';
}) {
  const [hov, setHov] = useState(false);
  const styles: Record<string, React.CSSProperties> = {
    default: {
      background: hov ? S2 : 'transparent',
      border: `1px solid ${hov ? 'rgba(255,255,255,0.12)' : BORDER}`,
      color: hov ? T1 : T2,
    },
    primary: {
      background: hov ? `${AMBER}22` : `${AMBER}12`,
      border: `1px solid ${hov ? `${AMBER}50` : `${AMBER}28`}`,
      color: AMBER,
    },
    danger: {
      background: hov ? `${RED}18` : `${RED}0a`,
      border: `1px solid ${hov ? `${RED}45` : `${RED}25`}`,
      color: hov ? '#f87171' : `${RED}cc`,
    },
  };
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        height: 36,
        padding: '0 14px',
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 500,
        fontFamily: SANS,
        cursor: 'pointer',
        transition: 'all 0.13s ease',
        ...styles[variant],
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function SessionActive() {
  const navigate = useNavigate();
  const preSession  = useFlyxaStore(s => s.preSession);
  const setPreSession = useFlyxaStore(s => s.setPreSession);
  const { dailyStatus, riskLevel } = useRisk();

  const [elapsed, setElapsed] = useState('00:00');
  const [guardTrades, setGuardTrades] = useState<GuardSessionTrade[]>(() => readGuardSessionTrades());
  const guardSummary = summarizeGuardSessionTrades(guardTrades);

  // Redirect to pre-session if no active session
  useEffect(() => {
    if (!preSession?.startedAt) {
      navigate('/pre-session', { replace: true });
    }
  }, [preSession?.startedAt, navigate]);

  // Tick elapsed timer every second
  useEffect(() => {
    if (!preSession?.startedAt) return;
    const tick = () => setElapsed(formatElapsed(preSession.startedAt!));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [preSession?.startedAt]);

  useEffect(() => {
    clearStaleGuardSessionTrades(preSession?.startedAt);
  }, [preSession?.startedAt]);

  useEffect(() => {
    const refresh = () => setGuardTrades(readGuardSessionTrades());
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
  }, []);

  if (!preSession?.startedAt) return null;

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
    setPreSession(null);
    navigate('/post-session');
  };

  // ── Render ──────────────────────────────────────────────
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--app-bg)',
      fontFamily: SANS,
      overflow: 'hidden',
      position: 'relative',
    }}>
      {/* Decorative ambient glow — top-centre radial */}
      <div style={{
        position: 'absolute',
        top: -60,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 700,
        height: 320,
        background: `radial-gradient(ellipse at top, ${AMBER}0f 0%, transparent 68%)`,
        pointerEvents: 'none',
        zIndex: 0,
      }} />

      <div style={{
        position: 'relative',
        zIndex: 1,
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        padding: '28px 32px 32px',
        gap: 20,
        maxWidth: 860,
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}>

        {/* ── Top status row ─────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          {/* Left: live indicator + timer */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8, flexShrink: 0 }}>
              <span className="session-ping" style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: GREEN, opacity: 0.75,
              }} />
              <span style={{
                position: 'relative', width: 8, height: 8,
                borderRadius: '50%', background: GREEN, display: 'inline-block',
              }} />
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: GREEN, textTransform: 'uppercase' }}>
              Session live
            </span>
            <span style={{ width: 1, height: 12, background: BORDER, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: T3, fontFamily: MONO, letterSpacing: '0.04em' }}>
              {elapsed}
            </span>
          </div>
          {/* Right: emotion tag */}
          {emotion && (
            <div style={{
              fontSize: 11, color: T3,
              padding: '4px 10px', borderRadius: 6,
              border: `1px solid ${BORDER}`,
              background: S1,
            }}>
              Feeling: <span style={{ color: T2 }}>{emotion}</span>
            </div>
          )}
        </div>

        {/* ── Hero P&L ───────────────────────────────── */}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 10,
          padding: '32px 24px',
          borderRadius: 16,
          border: `1px solid ${pnlNegative ? `${RED}28` : pnlPositive ? `${GREEN}28` : BORDER}`,
          background: pnlNegative ? `${RED}06` : pnlPositive ? `${GREEN}06` : 'transparent',
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Glow behind the number */}
          <div style={{
            position: 'absolute',
            top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: 300, height: 140,
            background: `radial-gradient(ellipse, ${pnlColor}0e 0%, transparent 70%)`,
            pointerEvents: 'none',
          }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
            <PnLIcon size={24} color={pnlColor} strokeWidth={1.8} />
            <span style={{
              fontSize: 52,
              fontWeight: 700,
              letterSpacing: '-0.035em',
              color: pnlColor,
              fontFamily: MONO,
              lineHeight: 1,
            }}>
              {formatMoney(pnl, true)}
            </span>
          </div>

          <span style={{ fontSize: 12, color: T3, position: 'relative' }}>
            {tradesCount} trade{tradesCount !== 1 ? 's' : ''} today
            {maxTrades > 0 && (
              <> &middot; {Math.max(0, maxTrades - tradesCount)} remaining</>
            )}
            {hasGuardLog && (
              <> &middot; synced from Trade Guard</>
            )}
          </span>
        </div>

        {/* ── Three stat cards ───────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>

          {/* Readiness */}
          <StatCard>
            <SectionLabel>Readiness</SectionLabel>
            {readiness ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                    color: readinessColor(readiness.status),
                    padding: '3px 8px', borderRadius: 5,
                    background: `${readinessColor(readiness.status)}14`,
                    border: `1px solid ${readinessColor(readiness.status)}30`,
                  }}>
                    {readiness.status}
                  </span>
                  <span style={{ fontSize: 18, fontWeight: 700, fontFamily: MONO, color: readinessColor(readiness.status) }}>
                    {readiness.score}
                  </span>
                </div>
                {emotion && (
                  <span style={{ fontSize: 11, color: T3 }}>Feeling: <span style={{ color: T2 }}>{emotion}</span></span>
                )}
              </div>
            ) : (
              <span style={{ fontSize: 12, color: T3 }}>Not assessed</span>
            )}
          </StatCard>

          {/* Market bias */}
          <StatCard>
            <SectionLabel>Market Bias</SectionLabel>
            {bias && Object.keys(bias).length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {Object.entries(bias).map(([sym, val]) => (
                  <div key={sym} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, fontFamily: MONO, color: T2, minWidth: 28 }}>
                      {sym}
                    </span>
                    <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                      color: biasColor(val as string),
                      padding: '2px 7px', borderRadius: 4,
                      background: `${biasColor(val as string)}14`,
                      border: `1px solid ${biasColor(val as string)}28`,
                    }}>
                      {val}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: 12, color: T3 }}>No bias set</span>
            )}
          </StatCard>

          {/* Risk meter */}
          <StatCard>
            <SectionLabel>Loss Used</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 28, fontWeight: 700, fontFamily: MONO, color: riskColor, lineHeight: 1 }}>
                {Math.round(lossUsedPct)}%
              </span>
              {lossRemaining !== null && (
                <span style={{ fontSize: 11, color: T3, paddingBottom: 2 }}>
                  {formatMoney(lossRemaining)} left
                </span>
              )}
            </div>
            <div style={{ height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                width: `${lossUsedPct}%`,
                borderRadius: 3,
                background: riskColor,
                transition: 'width 0.7s ease, background 0.4s ease',
              }} />
            </div>
            {riskLevel === 'locked' && (
              <div style={{ marginTop: 8, fontSize: 10, fontWeight: 700, color: RED, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Limit reached — stop trading
              </div>
            )}
          </StatCard>
        </div>

        {/* ── Session rules ──────────────────────────── */}
        {hasGuardLog && (
          <div style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 12,
            background: S1,
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            <div>
              <SectionLabel>Trade Guard log</SectionLabel>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: T2 }}>
                  {guardSummary.wins}W {guardSummary.losses}L{guardSummary.breakevens > 0 ? ` ${guardSummary.breakevens}BE` : ''}
                </span>
                <span style={{
                  fontSize: 13,
                  color: guardSummary.pnl > 0 ? GREEN : guardSummary.pnl < 0 ? RED : T2,
                  fontFamily: MONO,
                  fontWeight: 700,
                }}>
                  {formatMoney(guardSummary.pnl, true)}
                </span>
              </div>
            </div>
            <QuickBtn
              icon={<Shield size={14} />}
              label="Open Guard"
              onClick={() => window.dispatchEvent(new CustomEvent('flyxa:open-trade-check'))}
              variant="primary"
            />
          </div>
        )}

        {plan.length > 0 && (
          <div style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 12,
            background: S1,
            padding: '16px 20px',
          }}>
            <SectionLabel>Session rules</SectionLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {plan.map(item => {
                const { tag, color } = planLabel(item.source);
                return (
                  <div key={item.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                      color, padding: '2px 6px', borderRadius: 3,
                      background: `${color}12`, border: `1px solid ${color}28`,
                      flexShrink: 0, marginTop: 1, whiteSpace: 'nowrap',
                    }}>
                      {tag}
                    </span>
                    <span style={{ fontSize: 12, color: T2, lineHeight: 1.55 }}>{item.rule}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Session note (if set) ──────────────────── */}
        {preSession.note?.trim() && (
          <div style={{
            border: `1px solid ${AMBER}20`,
            borderRadius: 10,
            background: `${AMBER}06`,
            padding: '12px 16px',
            fontSize: 12,
            color: T2,
            lineHeight: 1.6,
            fontStyle: 'italic',
          }}>
            "{preSession.note.trim()}"
          </div>
        )}

        {/* ── Quick actions ──────────────────────────── */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 8 }}>
          <QuickBtn icon={<FileText size={14} />}   label="Journal"        onClick={() => navigate('/journal')}    variant="primary" />
          <QuickBtn icon={<BarChart2 size={14} />}  label="Analytics"      onClick={() => navigate('/analytics')} />
          <QuickBtn icon={<ScanLine size={14} />}   label="Trade Scanner"  onClick={() => navigate('/scanner')}   />
          <QuickBtn icon={<Shield size={14} />}     label="Pre-session"    onClick={() => navigate('/pre-session')} />
          <div style={{ flex: 1 }} />
          <QuickBtn icon={<LogOut size={14} />}     label="End session"    onClick={handleEnd}                     variant="danger" />
        </div>
      </div>

      {/* Pulse animation */}
      <style>{`
        @keyframes session-ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
        .session-ping {
          animation: session-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
      `}</style>
    </div>
  );
}
