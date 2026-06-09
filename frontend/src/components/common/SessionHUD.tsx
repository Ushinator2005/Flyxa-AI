import { CSSProperties, useState } from 'react';
import { X, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { useRisk } from '../../contexts/RiskContext.js';
import useFlyxaStore from '../../store/flyxaStore.js';

// ── helpers ────────────────────────────────────────────────────────────────────
function fmtPnl(v: number): string {
  const abs = Math.abs(v);
  const s = abs >= 10000
    ? `$${(abs / 1000).toFixed(0)}k`
    : abs >= 1000
      ? `$${(abs / 1000).toFixed(1)}k`
      : `$${abs.toFixed(0)}`;
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : '$0';
}

function accentForLevel(level: string): string {
  if (level === 'locked') return '#f05252';
  if (level === 'danger') return '#fb923c';
  if (level === 'warning') return '#f59e0b';
  return '#22d68a';
}

function pnlColor(v: number): string {
  return v > 0 ? '#22d68a' : v < 0 ? '#f05252' : '#5c5751';
}

// ── component ──────────────────────────────────────────────────────────────────
export default function SessionHUD() {
  const { dailyStatus, riskLevel } = useRisk();
  const preSession = useFlyxaStore(state => state.preSession);
  const [expanded, setExpanded] = useState(false);

  const sessionLive = Boolean(preSession?.startedAt);

  if (!dailyStatus || !sessionLive) return null;

  const { todayPnL, tradesCount, maxTradesPerDay, lossUsedPercent, dailyLossLimit } = dailyStatus;

  // Only render if there's something meaningful to show
  if (tradesCount === 0 && dailyLossLimit === 0) return null;

  const accent = accentForLevel(riskLevel);
  const hasLossLimit = dailyLossLimit > 0;
  const hasTradeMax = maxTradesPerDay > 0;
  const isLocked = riskLevel === 'locked';

  // Clamp bar width 0–100
  const barPct = Math.min(100, Math.max(0, lossUsedPercent));

  const shell: CSSProperties = {
    position: 'fixed',
    bottom: 16,
    left: 16,
    zIndex: 110,
    fontFamily: 'var(--font-sans, Inter, sans-serif)',
    userSelect: 'none',
  };

  // ── Collapsed pill ──────────────────────────────────────────────────────────
  if (!expanded) {
    return (
      <div style={shell}>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 36,
            padding: '0 12px 0 10px',
            borderRadius: 999,
            border: `1px solid rgba(255,255,255,0.08)`,
            background: 'rgba(20,19,18,0.92)',
            backdropFilter: 'blur(12px)',
            cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            transition: 'border-color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = `${accent}40`; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
        >
          {/* Status dot */}
          <span style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: accent,
            flexShrink: 0,
            boxShadow: `0 0 6px ${accent}80`,
          }} />

          {/* P&L */}
          <span style={{
            fontSize: 13,
            fontWeight: 650,
            color: pnlColor(todayPnL),
            letterSpacing: '-0.01em',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {fmtPnl(todayPnL)}
          </span>

          {/* Separator + trade count */}
          {hasTradeMax ? (
            <>
              <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, color: '#5c5751', fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: '#8a8178' }}>{tradesCount}</span>
                <span style={{ color: '#3a3835' }}>/{maxTradesPerDay}</span>
              </span>
            </>
          ) : tradesCount > 0 ? (
            <>
              <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, color: '#5c5751' }}>
                <span style={{ color: '#8a8178' }}>{tradesCount}</span> trade{tradesCount !== 1 ? 's' : ''}
              </span>
            </>
          ) : null}

          {/* Loss pct if warning/danger */}
          {hasLossLimit && barPct >= 60 && (
            <>
              <span style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, color: accent, fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(barPct)}%
              </span>
            </>
          )}
        </button>
      </div>
    );
  }

  // ── Expanded card ───────────────────────────────────────────────────────────
  const PnlIcon = todayPnL > 0 ? TrendingUp : todayPnL < 0 ? TrendingDown : Minus;

  return (
    <div style={shell}>
      <div style={{
        width: 226,
        borderRadius: 12,
        border: `1px solid rgba(255,255,255,0.07)`,
        borderLeft: `2px solid ${accent}`,
        background: 'rgba(18,17,16,0.96)',
        backdropFilter: 'blur(16px)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
        overflow: 'hidden',
      }}>
        {/* Header row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '9px 10px 8px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: accent,
              boxShadow: `0 0 6px ${accent}90`,
            }} />
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: '#5c5751',
            }}>
              {isLocked ? 'Session locked' : "Today's session"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: '#3a3835',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.1s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#8a8178'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#3a3835'; }}
          >
            <X size={12} />
          </button>
        </div>

        {/* P&L row */}
        <div style={{ padding: '12px 12px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: '-0.03em',
                color: pnlColor(todayPnL),
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {fmtPnl(todayPnL)}
              </div>
              <div style={{ fontSize: 10, color: '#3a3835', marginTop: 3, letterSpacing: '0.04em' }}>
                P &amp; L today
              </div>
            </div>
            <div style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: `${pnlColor(todayPnL)}10`,
              border: `1px solid ${pnlColor(todayPnL)}20`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <PnlIcon size={15} style={{ color: pnlColor(todayPnL) }} />
            </div>
          </div>
        </div>

        {/* Stats row */}
        {(hasTradeMax || tradesCount > 0) && (
          <div style={{
            display: 'flex',
            gap: 1,
            margin: '10px 12px 0',
            borderRadius: 7,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.05)',
          }}>
            <div style={{ flex: 1, padding: '7px 8px', background: 'rgba(255,255,255,0.025)' }}>
              <div style={{ fontSize: 14, fontWeight: 660, color: '#e8e3dc', fontVariantNumeric: 'tabular-nums' }}>
                {tradesCount}{hasTradeMax ? <span style={{ fontSize: 11, color: '#3a3835', fontWeight: 400 }}>/{maxTradesPerDay}</span> : ''}
              </div>
              <div style={{ fontSize: 9.5, color: '#3a3835', marginTop: 2, letterSpacing: '0.04em' }}>
                {hasTradeMax ? 'trades / max' : 'trades today'}
              </div>
            </div>
            {hasTradeMax && (
              <div style={{ flex: 1, padding: '7px 8px', background: 'rgba(255,255,255,0.025)' }}>
                <div style={{ fontSize: 14, fontWeight: 660, color: '#e8e3dc', fontVariantNumeric: 'tabular-nums' }}>
                  {maxTradesPerDay - tradesCount}
                </div>
                <div style={{ fontSize: 9.5, color: '#3a3835', marginTop: 2, letterSpacing: '0.04em' }}>
                  trades left
                </div>
              </div>
            )}
          </div>
        )}

        {/* Loss limit bar */}
        {hasLossLimit && (
          <div style={{ padding: '10px 12px 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: '#3a3835' }}>
                Daily loss limit
              </span>
              <span style={{
                fontSize: 10,
                fontWeight: 650,
                color: barPct >= 80 ? accent : '#5c5751',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {Math.round(barPct)}%
              </span>
            </div>
            {/* Track */}
            <div style={{
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.06)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${barPct}%`,
                borderRadius: 2,
                background: barPct >= 90
                  ? `linear-gradient(90deg, #f59e0b, #f05252)`
                  : barPct >= 70
                    ? '#f59e0b'
                    : '#22d68a',
                transition: 'width 0.5s ease',
              }} />
            </div>
            {isLocked && (
              <div style={{
                marginTop: 6,
                fontSize: 10,
                color: '#f05252',
                fontWeight: 600,
                letterSpacing: '0.04em',
              }}>
                Stop trading — limit reached
              </div>
            )}
          </div>
        )}

        {/* Spacer if no loss bar */}
        {!hasLossLimit && <div style={{ height: 12 }} />}
      </div>
    </div>
  );
}
