import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash } from 'lucide-react';
import { ALL_ACCOUNTS_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRisk } from '../contexts/RiskContext.js';
import { useTrades } from '../hooks/useTrades.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { Trade } from '../types/index.js';
import { getMostRecentDailyFlowBefore } from '../utils/dailyFlow.js';

type GateStatus = 'clear' | 'caution' | 'blocked';
type Phase     = 'idle' | 'active' | 'post';
type TradeDir  = 'long' | 'short';
type Outcome   = 'win' | 'loss' | 'be';

const C = {
  text:   'rgba(232,227,220,0.65)',
  muted:  'rgba(138,129,120,0.48)',
  subtle: 'rgba(92,87,81,0.42)',
  amber:  'rgba(245,158,11,0.85)',
  green:  'rgba(52,211,153,0.85)',
  red:    'rgba(248,113,113,0.85)',
  border: 'rgba(255,255,255,0.04)',
  sans:   'var(--font-sans)',
  mono:   'var(--font-mono)',
} as const;

const EMOTIONS: Array<{ full: string; short: string }> = [
  { full: 'Calm',          short: 'Clm'  },
  { full: 'Focused',       short: 'Foc'  },
  { full: 'Rushed',        short: 'Rush' },
  { full: 'FOMO',          short: 'FOMO' },
  { full: 'Revenge',       short: 'Rev'  },
  { full: 'Anxious',       short: 'Anx'  },
  { full: 'Overconfident', short: 'OC'   },
];

function todayKey() { return new Date().toISOString().slice(0, 10); }

function parseTradeDateTime(trade: Trade): Date | null {
  const rawDate = trade.trade_date || trade.created_at?.slice(0, 10);
  if (!rawDate) return null;
  const rawTime = trade.trade_time || '00:00:00';
  const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${rawDate}T${time}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function fmtMoney(v: number) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function isTilt(v: string) {
  return /revenge|fomo|rushed|anxious|overconfident|angry|frustrated|tilt/i.test(v);
}

function consecutiveLosses(trades: Trade[]) {
  let n = 0;
  for (const t of [...trades].sort((a, b) => (parseTradeDateTime(b)?.getTime() ?? 0) - (parseTradeDateTime(a)?.getTime() ?? 0))) {
    if (t.pnl < 0) n++;
    else if (t.pnl > 0) break;
  }
  return n;
}

function getCalRisk(): string | null {
  try {
    const raw = window.localStorage.getItem('flyxa_calendar_cache_v4');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { events?: Array<{ event?: string; date?: string; time?: string; impact?: string; actual?: string }> };
    if (!Array.isArray(parsed.events)) return null;
    const today = todayKey();
    const next = parsed.events
      .filter(e => e.impact === 'high' && e.date === today && !e.actual)
      .sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? '')))[0];
    return next?.event ? `${next.event}${next.time ? ` @ ${next.time}` : ''}` : null;
  } catch { return null; }
}

type NewsItem = { headline?: string; source?: string; timestamp?: string; impact?: string; isBreaking?: boolean };

function getNewsRisk(): string | null {
  const read = (key: string): NewsItem[] => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { items?: NewsItem[] };
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch { return []; }
  };
  const now = Date.now();
  const top = [...read('flyxa_breaking_cache_v1'), ...read('flyxa_news_cache_v2')]
    .filter(i => i.headline && i.timestamp)
    .filter(i => { const age = now - new Date(i.timestamp ?? '').getTime(); return Number.isFinite(age) && age <= 2 * 60 * 60 * 1000; })
    .filter(i => i.isBreaking === true || String(i.impact ?? '').toLowerCase() === 'high')
    .sort((a, b) => Number(b.isBreaking) - Number(a.isBreaking) || new Date(b.timestamp ?? '').getTime() - new Date(a.timestamp ?? '').getTime())[0];
  return top?.headline ? top.headline : null;
}

function flag(status: GateStatus, label: string) { return { status, label }; }

export default function TradeCheck() {
  const { trades, loading }                                  = useTrades();
  const { selectedAccountId, filterTradesBySelectedAccount } = useAppSettings();
  const { dailyStatus, riskLevel }                           = useRisk();
  const preSessionHistory                                    = useFlyxaStore(state => state.preSessionHistory);

  const [emotion, setEmotion]         = useState('Calm');
  const [phase, setPhase]             = useState<Phase>('idle');
  const [direction, setDirection]     = useState<TradeDir | null>(null);
  const [outcome, setOutcome]         = useState<Outcome | null>(null);
  const [localLosses, setLocalLosses] = useState(0);

  const scopedTrades = useMemo(() => {
    if (!selectedAccountId || selectedAccountId === ALL_ACCOUNTS_ID) return filterTradesBySelectedAccount(trades);
    return trades.filter(t => {
      const ids = t.accountIds ?? [t.accountId, t.account_id].filter(Boolean) as string[];
      return ids.includes(selectedAccountId);
    });
  }, [filterTradesBySelectedAccount, selectedAccountId, trades]);

  const priorFlow = useMemo(() => getMostRecentDailyFlowBefore(scopedTrades, todayKey()), [scopedTrades]);

  const gate = useMemo(() => {
    const today       = todayKey();
    const todayTrades = scopedTrades.filter(t => (t.trade_date || t.created_at?.slice(0, 10)) === today);
    const todayPnl    = todayTrades.reduce((s, t) => s + t.pnl, 0);
    const todayLoss   = Math.max(0, -todayPnl);
    const maxTrades   = dailyStatus?.maxTradesPerDay    ?? dailyStatus?.settings?.max_trades_per_day  ?? 0;
    const lossLimit   = dailyStatus?.dailyLossLimit     ?? dailyStatus?.settings?.daily_loss_limit     ?? 0;
    const lossPct     = dailyStatus?.lossUsedPercent    ?? (lossLimit > 0 ? (todayLoss / lossLimit) * 100 : 0);
    const preSession  = preSessionHistory[today];
    const losses      = consecutiveLosses(todayTrades);
    const newsRisk    = getNewsRisk();
    const calRisk     = getCalRisk();
    const flags       = [];

    // ── Hard stops ───────────────────────────────────────────────────
    if (dailyStatus?.isLocked || riskLevel === 'locked' || lossPct >= 100)
      flags.push(flag('blocked', 'Daily loss limit hit'));
    else if (lossPct >= 80)
      flags.push(flag('caution', `Loss at ${Math.round(lossPct)}% of limit`));

    if (maxTrades > 0 && todayTrades.length >= maxTrades)
      flags.push(flag('blocked', `Max trades reached (${todayTrades.length}/${maxTrades})`));
    else if (maxTrades > 0 && todayTrades.length === maxTrades - 1)
      flags.push(flag('caution', `Last trade — cap is ${maxTrades}/day`));

    if (losses >= 2)
      flags.push(flag('blocked', `${losses} consecutive losses — stand down`));
    else if (losses === 1)
      flags.push(flag('caution', 'Post-loss — confirm thesis first'));

    // ── Emotion ──────────────────────────────────────────────────────
    if (isTilt(emotion))
      flags.push(flag(emotion === 'Revenge' || emotion === 'FOMO' ? 'blocked' : 'caution', `${emotion} detected`));

    // ── Pre-session ──────────────────────────────────────────────────
    if (preSession?.readiness?.status === 'Stand Down')
      flags.push(flag('blocked', 'Pre-session: stand down'));
    else if (preSession?.readiness?.status === 'Caution')
      flags.push(flag('caution', 'Pre-session caution'));
    else if (!preSession)
      flags.push(flag('caution', 'No pre-session brief'));

    // ── Rules ────────────────────────────────────────────────────────
    if (priorFlow?.tomorrowRule) {
      const rule = priorFlow.tomorrowRule.toLowerCase();
      const blocked =
        (rule.includes('max 2 trades') && todayTrades.length >= 2) ||
        (rule.includes('stop after 2 losses') && losses >= 2) ||
        (rule.includes('after any frustration') && isTilt(emotion));
      flags.push(flag(blocked ? 'blocked' : 'caution', `Rule: ${priorFlow.tomorrowRule}`));
    }

    // ── Market ───────────────────────────────────────────────────────
    if (newsRisk)     flags.push(flag('caution', `News: ${newsRisk.length > 46 ? newsRisk.slice(0, 43) + '…' : newsRisk}`));
    else if (calRisk) flags.push(flag('caution', `Calendar: ${calRisk}`));

    const status: GateStatus = flags.some(f => f.status === 'blocked') ? 'blocked'
      : flags.some(f => f.status === 'caution') ? 'caution' : 'clear';

    return { status, flags, todayPnl, todayTrades: todayTrades.length, lossPct: Math.round(lossPct) };
  }, [dailyStatus, emotion, preSessionHistory, priorFlow, riskLevel, scopedTrades]);

  // Reminders shown during an active trade
  const reminders = useMemo<string[]>(() => {
    const list: string[] = [];
    if (priorFlow?.tomorrowRule) list.push(priorFlow.tomorrowRule);
    list.push('Respect your TP — no early exits');
    list.push("Don't move SL into a loss");
    if (isTilt(emotion)) list.push(`${emotion} state — pause before exiting`);
    else list.push('Stick to the plan, no improvising');
    return list.slice(0, 3);
  }, [priorFlow, emotion]);

  // Post-trade session health
  const healthResult = useMemo(() => {
    if (phase !== 'post' || outcome === null) return null;
    let score = 100;
    if (gate.lossPct >= 100) score -= 55;
    else if (gate.lossPct >= 80) score -= 30;
    else if (gate.lossPct >= 55) score -= 12;
    if (localLosses >= 3) score -= 50;
    else if (localLosses >= 2) score -= 35;
    else if (localLosses === 1) score -= 12;
    if (isTilt(emotion)) score -= 18;
    score = Math.max(0, Math.min(100, score));

    const color = score >= 65 ? C.green : score >= 40 ? C.amber : C.red;
    const msg =
      gate.status === 'blocked' || score < 35 ? 'Step down — limits hit' :
      outcome === 'win' && score >= 70 ? 'Good trade. Edge intact.' :
      score >= 55 ? 'Proceed with caution.' :
      'Consider stepping down.';

    return { score, color, msg };
  }, [phase, outcome, localLosses, gate.lossPct, gate.status, emotion]);

  const sc = gate.status === 'blocked'
    ? { label: 'Blocked', color: C.red,   Icon: CircleSlash  }
    : gate.status === 'caution'
      ? { label: 'Caution', color: C.amber, Icon: AlertTriangle }
      : { label: 'Clear',   color: C.green, Icon: CheckCircle2  };

  const pnlColor = gate.todayPnl >= 0 ? C.green : C.red;
  const pnlStr   = gate.todayPnl >= 0
    ? `+${fmtMoney(gate.todayPnl)}`
    : `-${fmtMoney(Math.abs(gate.todayPnl))}`;

  // ── Handlers ──────────────────────────────────────────────────────
  function handleEnterTrade(dir: TradeDir) {
    setDirection(dir);
    setPhase('active');
  }

  function handleOutcome(o: Outcome) {
    setOutcome(o);
    setLocalLosses(prev => o === 'loss' ? prev + 1 : 0);
    setPhase('post');
  }

  function handleReset() {
    setPhase('idle');
    setDirection(null);
    setOutcome(null);
    // localLosses intentionally persists across trades this session
  }

  function handleDone() {
    try { window.parent?.postMessage({ type: 'flyxa:close-dock' }, '*'); } catch { /* ignore */ }
    handleReset();
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <main
      style={{
        background: 'transparent',
        color: C.text,
        fontFamily: C.sans,
        padding: '7px 8px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >

      {/* ══ IDLE PHASE ══════════════════════════════════════════════ */}
      {phase === 'idle' && (
        <>
          {/* Emotion state */}
          <div>
            <p style={KICKER}>State</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 2 }}>
              {EMOTIONS.map(({ full, short }) => {
                const on   = emotion === full;
                const tilt = isTilt(full);
                return (
                  <button
                    key={full}
                    type="button"
                    title={full}
                    onClick={() => setEmotion(full)}
                    style={{
                      height: 20, borderRadius: 3, fontSize: 8, fontWeight: on ? 700 : 500,
                      cursor: 'pointer', padding: 0, overflow: 'hidden', transition: 'all 0.12s',
                      border: on
                        ? `1px solid ${tilt ? 'rgba(248,113,113,0.45)' : 'rgba(52,211,153,0.38)'}`
                        : `1px solid ${C.border}`,
                      background: on
                        ? (tilt ? 'rgba(248,113,113,0.10)' : 'rgba(52,211,153,0.07)')
                        : 'rgba(255,255,255,0.02)',
                      color: on ? (tilt ? C.red : C.green) : C.subtle,
                    }}
                  >{short}</button>
                );
              })}
            </div>
          </div>

          {/* Status verdict */}
          {loading ? (
            <p style={{ margin: 0, color: C.subtle, fontSize: 9.5 }}>Loading…</p>
          ) : (
            <>
              <div style={{ borderLeft: `3px solid ${sc.color}`, paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <sc.Icon size={12} color={sc.color} />
                    <span style={{ fontSize: 14, fontWeight: 760, color: sc.color, lineHeight: 1, letterSpacing: '-0.01em' }}>
                      {sc.label}
                    </span>
                  </div>
                  <span style={{ fontSize: 10, fontFamily: C.mono, fontWeight: 700, color: pnlColor }}>{pnlStr}</span>
                </div>
                <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
                  <span style={{ fontSize: 9, color: C.subtle }}>{gate.todayTrades} trade{gate.todayTrades !== 1 ? 's' : ''}</span>
                  <span style={{ fontSize: 9, color: gate.lossPct >= 80 ? C.red : C.subtle, fontFamily: C.mono }}>
                    {gate.lossPct}% loss used
                  </span>
                </div>
              </div>

              {/* Top flag only — keep layout tight */}
              {gate.flags.length > 0 && (
                <div style={{
                  borderLeft: `2px solid ${gate.flags[0].status === 'blocked' ? C.red : C.amber}`,
                  paddingLeft: 6, paddingTop: 2, paddingBottom: 2,
                }}>
                  <span style={{
                    fontSize: 9.5, fontWeight: 600,
                    color: gate.flags[0].status === 'blocked' ? C.red : C.amber,
                    display: 'block', lineHeight: 1.3, letterSpacing: '0.01em',
                  }}>
                    {gate.flags[0].label}
                  </span>
                  {gate.flags.length > 1 && (
                    <span style={{ fontSize: 8.5, color: C.subtle }}>+{gate.flags.length - 1} more</span>
                  )}
                </div>
              )}
            </>
          )}

          {/* Enter trade buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            <button
              type="button"
              onClick={() => handleEnterTrade('long')}
              disabled={gate.status === 'blocked'}
              style={dirBtn(C.green, gate.status === 'blocked')}
            >
              ↑ Long
            </button>
            <button
              type="button"
              onClick={() => handleEnterTrade('short')}
              disabled={gate.status === 'blocked'}
              style={dirBtn(C.red, gate.status === 'blocked')}
            >
              ↓ Short
            </button>
          </div>
        </>
      )}

      {/* ══ ACTIVE PHASE ════════════════════════════════════════════ */}
      {phase === 'active' && direction && (
        <>
          {/* Direction indicator */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: direction === 'long' ? C.green : C.red,
                boxShadow: `0 0 6px ${direction === 'long' ? C.green : C.red}99`,
                display: 'inline-block',
                flexShrink: 0,
              }} />
              <span style={{
                fontSize: 13, fontWeight: 750, letterSpacing: '0.04em',
                color: direction === 'long' ? C.green : C.red,
              }}>
                {direction === 'long' ? 'LONG' : 'SHORT'}
              </span>
              <span style={{ fontSize: 9, color: C.subtle }}>in trade</span>
            </div>
            <button
              type="button"
              title="Cancel — back to check"
              onClick={() => setPhase('idle')}
              style={{ background: 'none', border: 'none', color: C.subtle, fontSize: 10, cursor: 'pointer', padding: '2px 4px', lineHeight: 1 }}
            >✕</button>
          </div>

          {/* Reminders */}
          <div>
            <p style={KICKER}>Reminders</p>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {reminders.map((r, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 5,
                  padding: '4px 0',
                  borderTop: i > 0 ? `1px solid ${C.border}` : 'none',
                }}>
                  <span style={{ color: C.subtle, fontSize: 9, lineHeight: '14px', flexShrink: 0, marginTop: 1 }}>–</span>
                  <span style={{ fontSize: 9.5, color: 'rgba(232,227,220,0.50)', lineHeight: 1.4 }}>{r}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Outcome buttons */}
          <div style={{ marginTop: 4 }}>
            <p style={KICKER}>Close trade</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
              <button type="button" onClick={() => handleOutcome('win')}  style={outcomeBtn(C.green)}>Win</button>
              <button type="button" onClick={() => handleOutcome('loss')} style={outcomeBtn(C.red)}>Loss</button>
              <button type="button" onClick={() => handleOutcome('be')}   style={outcomeBtn(C.amber)}>BE</button>
            </div>
          </div>
        </>
      )}

      {/* ══ POST PHASE ══════════════════════════════════════════════ */}
      {phase === 'post' && outcome && healthResult && (
        <>
          {/* Outcome header */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <span style={{
              fontSize: 17, fontWeight: 780, lineHeight: 1, letterSpacing: '-0.02em',
              color: outcome === 'win' ? C.green : outcome === 'loss' ? C.red : C.amber,
            }}>
              {outcome === 'win' ? 'WIN' : outcome === 'loss' ? 'LOSS' : 'BREAK EVEN'}
            </span>
            <span style={{ fontSize: 9, color: C.subtle }}>
              {direction === 'long' ? '↑ long' : '↓ short'}
            </span>
          </div>

          {/* Session health bar */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ ...KICKER, margin: 0 }}>Session health</span>
              <span style={{ fontSize: 9.5, fontFamily: C.mono, fontWeight: 700, color: healthResult.color }}>
                {healthResult.score}
              </span>
            </div>
            <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 2,
                width: `${healthResult.score}%`,
                background: healthResult.color,
                transition: 'width 0.5s cubic-bezier(0.16,1,0.3,1)',
              }} />
            </div>
          </div>

          {/* Recommendation */}
          <p style={{
            margin: 0, fontSize: 10.5, fontWeight: 640, lineHeight: 1.4,
            letterSpacing: '0.005em', color: healthResult.color,
          }}>
            {healthResult.msg}
          </p>

          {/* Actions */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 2 }}>
            <button type="button" onClick={handleReset} style={actionBtn('primary')}>New trade</button>
            <button type="button" onClick={handleDone}  style={actionBtn('ghost')}>Done</button>
          </div>
        </>
      )}
    </main>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

const KICKER: React.CSSProperties = {
  margin: '0 0 4px',
  fontSize: 8,
  color: 'rgba(92,87,81,0.42)',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontWeight: 600,
};

function dirBtn(color: string, disabled: boolean): React.CSSProperties {
  return {
    height: 26, borderRadius: 4, fontSize: 10, fontWeight: 700,
    border: `1px solid ${color}${disabled ? '18' : '28'}`,
    background: `${color}${disabled ? '04' : '08'}`,
    color: disabled ? `${color}44` : color,
    cursor: disabled ? 'not-allowed' : 'pointer',
    letterSpacing: '0.04em',
    transition: 'all 0.1s',
  };
}

function outcomeBtn(color: string): React.CSSProperties {
  return {
    height: 26, borderRadius: 4, fontSize: 10, fontWeight: 700,
    border: `1px solid ${color}28`,
    background: `${color}08`,
    color,
    cursor: 'pointer',
    letterSpacing: '0.04em',
    transition: 'all 0.1s',
  };
}

function actionBtn(variant: 'primary' | 'ghost'): React.CSSProperties {
  return {
    height: 24, borderRadius: 4, fontSize: 9.5, fontWeight: 650,
    border: variant === 'primary' ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(255,255,255,0.04)',
    background: variant === 'primary' ? 'rgba(255,255,255,0.04)' : 'transparent',
    color: variant === 'primary' ? 'rgba(138,129,120,0.8)' : 'rgba(92,87,81,0.65)',
    cursor: 'pointer',
  };
}
