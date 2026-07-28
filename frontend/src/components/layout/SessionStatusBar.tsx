import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { clearStaleGuardSessionTrades, summarizeGuardSessionTrades, useGuardSessionTrades } from '../../hooks/useGuardSessionTrades.js';
import useFlyxaStore from '../../store/flyxaStore.js';
import { useRisk } from '../../contexts/RiskContext.js';
import { useAppSettings } from '../../contexts/AppSettingsContext.js';
import { flushSupabaseStoreNow } from '../../store/supabaseStorage.js';
import { getPreSessionDate, isLivePreSession, markPreSessionEnded } from '../../utils/sessionLifecycle.js';
import { getTimeZoneParts } from '../../utils/calendarTime.js';

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

function BiasDisplay({ bias }: { bias: BiasState }) {
  const entries = Object.entries(bias) as [string, BiasValue][];
  const uniqueVals = [...new Set(entries.map(([, v]) => v))];
  const unified = uniqueVals.length === 1;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        {unified
          ? <span style={{ fontSize: 10, fontWeight: 700, color: biasColor(uniqueVals[0]) }}>{uniqueVals[0]}</span>
          : entries.map(([inst, val]) => (
              <span key={inst} style={{ fontSize: 10, color: '#5c5751' }}>
                {inst}{' '}
                <span style={{ fontWeight: 700, color: biasColor(val) }}>{val}</span>
              </span>
            ))
        }
      </div>
      <SEP />
    </>
  );
}

function readinessColor(status: string) {
  if (status === 'Ready') return '#22d68a';
  if (status === 'Caution') return '#f59e0b';
  return '#f05252';
}

export default function SessionStatusBar() {
  const preSession = useFlyxaStore(state => state.preSession);
  const setPreSession = useFlyxaStore(state => state.setPreSession);
  const setPreSessionForDate = useFlyxaStore(state => state.setPreSessionForDate);
  const { dailyStatus } = useRisk();
  const { preferences } = useAppSettings();
  const navigate = useNavigate();

  const activeStartedAt = isLivePreSession(preSession) ? preSession.startedAt : undefined;
  const guardSummary = summarizeGuardSessionTrades(useGuardSessionTrades(activeStartedAt));

  useEffect(() => {
    clearStaleGuardSessionTrades(activeStartedAt);
  }, [activeStartedAt]);

  // Auto-expire sessions from a previous calendar day — a trading session
  // cannot span midnight, so any leftover preSession from yesterday is stale.
  useEffect(() => {
    if (!preSession?.startedAt) return;
    if (preSession.endedAt) {
      setPreSession(null);
      void flushSupabaseStoreNow();
      return;
    }

    const sessionDate = getPreSessionDate(preSession, preferences.timezone);
    const today = getTimeZoneParts(new Date(), preferences.timezone).date;
    if (sessionDate !== today) {
      const existingSession = useFlyxaStore.getState().preSessionHistory[sessionDate];
      setPreSessionForDate(sessionDate, markPreSessionEnded(preSession, existingSession));
      setPreSession(null);
      void flushSupabaseStoreNow();
    }
  }, [preSession, preferences.timezone, setPreSession, setPreSessionForDate]);

  if (!isLivePreSession(preSession)) return null;

  const endSession = () => {
    const sessionDate = getPreSessionDate(preSession, preferences.timezone);
    const existingSession = useFlyxaStore.getState().preSessionHistory[sessionDate];
    setPreSession(null);
    setPreSessionForDate(sessionDate, markPreSessionEnded(preSession, existingSession));
    void flushSupabaseStoreNow();
    navigate(`/post-session?date=${sessionDate}`);
  };

  const bias = preSession.bias as BiasState | null;
  const readiness = preSession.readiness;
  const emotion = preSession.emotion;

  // Lens-side counts (trades entered through the Trade Lens today)
  const guardTradeCount = guardSummary.count;
  const guardLoss = guardSummary.loss;

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
    <>
    <style>{`.ssb-clickable:hover { background: rgba(255,255,255,0.035); }`}</style>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 14px',
        height: 36,
        backgroundColor: 'var(--app-bg)',
        borderBottom: '1px solid rgba(245,158,11,0.12)',
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      {/* Clickable session summary — opens the live session view */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => navigate('/session')}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && navigate('/session')}
        className="ssb-clickable"
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          flex: 1, minWidth: 0, cursor: 'pointer',
          overflow: 'hidden',
          borderRadius: 4,
          margin: '4px 0',
          padding: '0 6px',
          transition: 'background 150ms',
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

      {/* Bias */}
      {bias && Object.keys(bias).length > 0 && (
        <BiasDisplay bias={bias} />
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

      </div>{/* end clickable area */}

      {/* Spacer */}
      <div style={{ flexShrink: 0, minWidth: 12 }} />

      {/* View session */}
      <button
        type="button"
        onClick={() => navigate('/session')}
        style={{
          fontSize: 10,
          fontWeight: 500,
          color: '#f59e0b',
          background: 'transparent',
          border: 'none',
          padding: '2px 4px',
          cursor: 'pointer',
          flexShrink: 0,
          letterSpacing: '0.02em',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        View session
        <span style={{ fontSize: 11, lineHeight: 1 }}>→</span>
      </button>

      {/* End session */}
      <button
        type="button"
        onClick={endSession}
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
    </>
  );
}
