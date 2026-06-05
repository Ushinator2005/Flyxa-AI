import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useFlyxaStore from '../../store/flyxaStore.js';
import { useRisk } from '../../contexts/RiskContext.js';

const SESSION_TRADES_STORAGE = 'flyxa.session-trades-v1';

type GuardTrade = { direction: string; outcome: string; amount: number };

function readGuardTrades(): GuardTrade[] | null {
  try {
    const raw = localStorage.getItem(SESSION_TRADES_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { date: string; trades: GuardTrade[] };
    const today = new Date().toISOString().slice(0, 10);
    if (parsed.date === today) return parsed.trades ?? [];
  } catch { /* ignore */ }
  return null;
}

type BiasValue = 'Bull' | 'Bear' | 'Neutral';
type BiasState = Record<string, BiasValue>;

const SEP = () => (
  <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.07)', flexShrink: 0, display: 'inline-block' }} />
);

function biasColor(v: BiasValue) {
  if (v === 'Bull') return '#22d68a';
  if (v === 'Bear') return '#f05252';
  return '#5c5751';
}

function readinessColor(status: string) {
  if (status === 'Ready') return '#22d68a';
  if (status === 'Caution') return '#f59e0b';
  return '#f05252';
}

export default function SessionStatusBar() {
  const preSession = useFlyxaStore(state => state.preSession);
  const setPreSession = useFlyxaStore(state => state.setPreSession);
  const { dailyStatus } = useRisk();
  const navigate = useNavigate();

  // Read Guard's session trades from localStorage; update via storage event (cross-tab)
  // and a polling interval (same-tab iframe writes don't always fire storage events)
  const [guardTrades, setGuardTrades] = useState<GuardTrade[] | null>(() => readGuardTrades());
  useEffect(() => {
    const refresh = () => setGuardTrades(readGuardTrades());
    const storageHandler = (e: StorageEvent) => {
      if (e.key === SESSION_TRADES_STORAGE) refresh();
    };
    window.addEventListener('storage', storageHandler);
    const poll = setInterval(refresh, 3000);
    return () => {
      window.removeEventListener('storage', storageHandler);
      clearInterval(poll);
    };
  }, []);

  if (!preSession?.startedAt) return null;

  const bias = preSession.bias as BiasState | null;
  const readiness = preSession.readiness;
  const emotion = preSession.emotion;

  // Guard-side counts (trades entered through the Trade Guard today)
  const guardTradeCount = guardTrades?.length ?? 0;
  const guardLoss = guardTrades?.filter(t => t.outcome === 'loss').reduce((s, t) => s + t.amount, 0) ?? 0;

  // Use the more conservative (worse) value between DB and Guard
  const dbTradesUsed = dailyStatus?.tradesCount ?? 0;
  const effectiveTradesUsed = Math.max(dbTradesUsed, guardTradeCount);
  const tradesLeft = dailyStatus?.maxTradesPerDay
    ? Math.max(0, dailyStatus.maxTradesPerDay - effectiveTradesUsed)
    : null;

  // Prefer session-specific max loss set in pre-session over DB risk settings
  const effectiveLossLimit = (preSession as unknown as { sessionMaxLoss?: number | null })?.sessionMaxLoss ?? dailyStatus?.dailyLossLimit ?? 0;
  const dbLoss = Math.abs(Math.min(0, dailyStatus?.todayPnL ?? 0));
  const effectiveLoss = Math.max(dbLoss, guardLoss);
  const lossRemaining = effectiveLossLimit > 0
    ? Math.max(0, effectiveLossLimit - effectiveLoss)
    : null;
  const profitTarget = (preSession as unknown as { dailyTarget?: number | null })?.dailyTarget ?? null;

  const startedTime = preSession.startedAt
    ? new Date(preSession.startedAt).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', hour12: true,
      })
    : null;

  const lossIsLow = lossRemaining !== null && effectiveLossLimit > 0 && lossRemaining < effectiveLossLimit * 0.25;
  const tradesLow = tradesLeft !== null && tradesLeft <= 2;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 14px',
        height: 36,
        backgroundColor: '#0e0d0d',
        borderBottom: '1px solid rgba(245,158,11,0.12)',
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {/* Active indicator + time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span
          style={{
            width: 6, height: 6, borderRadius: '50%',
            background: '#22d68a', boxShadow: '0 0 5px #22d68a',
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 11, fontWeight: 600, color: '#e8e3dc', letterSpacing: '0.02em' }}>
          Session active
        </span>
        {startedTime && (
          <span style={{ fontSize: 10, color: '#5c5751' }}>since {startedTime} ET</span>
        )}
      </div>

      <SEP />

      {/* Readiness */}
      {readiness && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: readinessColor(readiness.status) }}>
              {readiness.status}
            </span>
            <span style={{ fontSize: 10, color: '#5c5751' }}>{readiness.score}/100</span>
          </div>
          <SEP />
        </>
      )}

      {/* Emotion */}
      {emotion && (
        <>
          <span style={{ fontSize: 10, color: '#8a8178', flexShrink: 0 }}>{emotion}</span>
          <SEP />
        </>
      )}

      {/* Bias per instrument */}
      {bias && Object.keys(bias).length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {(Object.entries(bias) as [string, BiasValue][]).map(([inst, val]) => (
              <span key={inst} style={{ fontSize: 10, color: '#5c5751' }}>
                {inst}{' '}
                <span style={{ fontWeight: 700, color: biasColor(val) }}>{val}</span>
              </span>
            ))}
          </div>
          <SEP />
        </>
      )}

      {/* Live risk stats */}
      {lossRemaining !== null && (
        <span style={{ fontSize: 10, color: '#5c5751', flexShrink: 0 }}>
          loss left{' '}
          <span style={{ fontWeight: 600, color: lossIsLow ? '#f05252' : '#e8e3dc' }}>
            ${lossRemaining.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
        </span>
      )}

      {profitTarget !== null && (
        <>
          <SEP />
          <span style={{ fontSize: 10, color: '#5c5751', flexShrink: 0 }}>
            target{' '}
            <span style={{ fontWeight: 600, color: '#22d68a' }}>
              ${profitTarget.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          </span>
        </>
      )}

      {tradesLeft !== null && (
        <span style={{ fontSize: 10, color: '#5c5751', flexShrink: 0 }}>
          trades left{' '}
          <span style={{ fontWeight: 600, color: tradesLow ? '#f59e0b' : '#e8e3dc' }}>
            {tradesLeft}
          </span>
        </span>
      )}

      {/* Spacer */}
      <div style={{ flex: 1, minWidth: 12 }} />

      {/* End session */}
      <button
        type="button"
        onClick={() => {
          setPreSession(null);
          navigate('/flyxa-ai');
        }}
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: '#8a8178',
          background: 'transparent',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 4,
          padding: '2px 10px',
          cursor: 'pointer',
          flexShrink: 0,
          letterSpacing: '0.02em',
        }}
      >
        End session
      </button>
    </div>
  );
}
