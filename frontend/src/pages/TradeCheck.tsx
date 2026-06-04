import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash } from 'lucide-react';
import { ALL_ACCOUNTS_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRisk } from '../contexts/RiskContext.js';
import { useTrades } from '../hooks/useTrades.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { riskApi } from '../services/api.js';
import type { Trade } from '../types/index.js';
import { getMostRecentDailyFlowBefore } from '../utils/dailyFlow.js';

type GateStatus = 'clear' | 'caution' | 'blocked';
type Phase      = 'idle' | 'active' | 'post';
type TradeDir   = 'long' | 'short';
type Outcome    = 'win' | 'loss' | 'be';

interface SessionTrade {
  direction: TradeDir;
  outcome: Outcome;
  amount: number; // always positive — outcome determines sign
}

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

function fmtMoney(v: number) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function isTilt(v: string) {
  return /revenge|fomo|rushed|anxious|overconfident|angry|frustrated|tilt/i.test(v);
}

// A win OR a break-even resets the consecutive loss streak.
function sessionConsecLosses(trades: SessionTrade[]): number {
  let n = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].outcome === 'loss') n++;
    else break;
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
  const { trades }                                           = useTrades();
  const { selectedAccountId, filterTradesBySelectedAccount } = useAppSettings();
  const { dailyStatus, riskLevel, settings: riskSettings, refreshSettings } = useRisk();
  const preSessionHistory                                    = useFlyxaStore(state => state.preSessionHistory);

  const [emotion, setEmotion]             = useState('Calm');
  const [phase, setPhase]                 = useState<Phase>('idle');
  const [direction, setDirection]         = useState<TradeDir | null>(null);
  const [outcome, setOutcome]             = useState<Outcome | null>(null);
  const [sessionTrades, setSessionTrades] = useState<SessionTrade[]>([]);
  // pendingClose: Win or Loss was tapped — waiting for $ amount before confirming
  const [pendingClose, setPendingClose]   = useState<{ outcome: Exclude<Outcome, 'be'>; amount: string } | null>(null);
  // Inline risk-limit editor
  const [showLimits, setShowLimits]       = useState(false);
  const [limitDraft, setLimitDraft]       = useState({ loss: '', trades: '', riskPct: '', contracts: '' });
  const [limitSaving, setLimitSaving]     = useState(false);

  // scopedTrades used only for priorFlow (yesterday's rules) — not for gate checks
  const scopedTrades = useMemo<Trade[]>(() => {
    if (!selectedAccountId || selectedAccountId === ALL_ACCOUNTS_ID) return filterTradesBySelectedAccount(trades);
    return trades.filter(t => {
      const ids = t.accountIds ?? [t.accountId, t.account_id].filter(Boolean) as string[];
      return ids.includes(selectedAccountId);
    });
  }, [filterTradesBySelectedAccount, selectedAccountId, trades]);

  const priorFlow = useMemo(() => getMostRecentDailyFlowBefore(scopedTrades, todayKey()), [scopedTrades]);

  // ── Gate: all session-level checks use local sessionTrades, not the DB ──
  const gate = useMemo(() => {
    const today      = todayKey();
    const preSession = preSessionHistory[today];

    const tradeCount  = sessionTrades.length;
    const sessionLoss = sessionTrades
      .filter(t => t.outcome === 'loss')
      .reduce((s, t) => s + t.amount, 0);
    const sessionPnl  = sessionTrades.reduce((s, t) =>
      s + (t.outcome === 'win' ? t.amount : t.outcome === 'loss' ? -t.amount : 0), 0);
    const consec      = sessionConsecLosses(sessionTrades);

    const maxTrades   = dailyStatus?.maxTradesPerDay  ?? dailyStatus?.settings?.max_trades_per_day ?? riskSettings?.max_trades_per_day ?? 0;
    // Session max loss: prefer pre-session override, then DB risk settings
    const lossLimit   = (preSession?.sessionMaxLoss ?? 0) > 0
      ? preSession!.sessionMaxLoss!
      : (dailyStatus?.dailyLossLimit ?? dailyStatus?.settings?.daily_loss_limit ?? riskSettings?.daily_loss_limit ?? 0);
    const profitTarget = (preSession?.dailyTarget ?? 0) > 0 ? preSession!.dailyTarget! : null;
    const lossPct     = lossLimit > 0 ? (sessionLoss / lossLimit) * 100 : 0;
    const newsRisk    = getNewsRisk();
    const calRisk     = getCalRisk();
    const flags       = [];

    // Hard stops
    if (dailyStatus?.isLocked || riskLevel === 'locked')
      flags.push(flag('blocked', 'Risk locked'));
    else if (lossLimit > 0 && lossPct >= 100)
      flags.push(flag('blocked', 'Session loss limit hit'));
    else if (lossLimit > 0 && lossPct >= 80)
      flags.push(flag('caution', `Loss at ${Math.round(lossPct)}% of limit`));

    // Profit target hit — caution to stop trading and lock in
    if (profitTarget !== null && sessionPnl >= profitTarget)
      flags.push(flag('caution', `Target hit ${fmtMoney(profitTarget)} — protect gains`));

    if (maxTrades > 0 && tradeCount >= maxTrades)
      flags.push(flag('blocked', `Max trades (${tradeCount}/${maxTrades})`));
    else if (maxTrades > 0 && tradeCount === maxTrades - 1)
      flags.push(flag('caution', `Last trade — cap is ${maxTrades}`));

    if (consec >= 2)
      flags.push(flag('blocked', `${consec} consecutive losses`));
    else if (consec === 1)
      flags.push(flag('caution', 'Post-loss — confirm thesis'));

    // Emotion
    if (isTilt(emotion))
      flags.push(flag(emotion === 'Revenge' || emotion === 'FOMO' ? 'blocked' : 'caution', `${emotion} detected`));

    // Pre-session brief
    if (preSession?.readiness?.status === 'Stand Down')
      flags.push(flag('blocked', 'Pre-session: stand down'));
    else if (preSession?.readiness?.status === 'Caution')
      flags.push(flag('caution', 'Pre-session caution'));
    else if (!preSession)
      flags.push(flag('caution', 'No pre-session brief'));

    // Yesterday's self-set rule
    if (priorFlow?.tomorrowRule) {
      const rule = priorFlow.tomorrowRule.toLowerCase();
      const blocked =
        (rule.includes('max 2 trades') && tradeCount >= 2) ||
        (rule.includes('stop after 2 losses') && consec >= 2) ||
        (rule.includes('after any frustration') && isTilt(emotion));
      flags.push(flag(blocked ? 'blocked' : 'caution', `Rule: ${priorFlow.tomorrowRule}`));
    }

    // Market risk
    if (newsRisk)     flags.push(flag('caution', `News: ${newsRisk.length > 46 ? newsRisk.slice(0, 43) + '…' : newsRisk}`));
    else if (calRisk) flags.push(flag('caution', `Calendar: ${calRisk}`));

    const status: GateStatus = flags.some(f => f.status === 'blocked') ? 'blocked'
      : flags.some(f => f.status === 'caution') ? 'caution' : 'clear';

    return { status, flags, sessionPnl, sessionLoss, tradeCount, lossPct: Math.round(lossPct), lossLimit, profitTarget };
  }, [sessionTrades, dailyStatus, riskSettings, emotion, preSessionHistory, priorFlow, riskLevel]);

  // Reminders for active phase — pulled from pre-session data + emotion
  const reminders = useMemo<string[]>(() => {
    const list: string[] = [];
    if (priorFlow?.tomorrowRule) list.push(priorFlow.tomorrowRule);
    list.push('Respect your TP — no early exits');
    list.push("Don't move SL into a loss");
    if (isTilt(emotion)) list.push(`${emotion} state — pause before exiting`);
    else list.push('Stick to the plan, no improvising');
    return list.slice(0, 3);
  }, [priorFlow, emotion]);

  // Post-trade session health score
  const healthResult = useMemo(() => {
    if (phase !== 'post' || outcome === null) return null;
    const consec = sessionConsecLosses(sessionTrades);
    let score = 100;
    if (gate.lossPct >= 100) score -= 55;
    else if (gate.lossPct >= 80) score -= 30;
    else if (gate.lossPct >= 55) score -= 12;
    if (consec >= 3) score -= 50;
    else if (consec >= 2) score -= 35;
    else if (consec === 1) score -= 12;
    if (isTilt(emotion)) score -= 18;
    score = Math.max(0, Math.min(100, score));

    const color = score >= 65 ? C.green : score >= 40 ? C.amber : C.red;
    const msg =
      gate.status === 'blocked' || score < 35 ? 'Step down — limits hit' :
      outcome === 'win' && score >= 70 ? 'Good trade. Edge intact.' :
      score >= 55 ? 'Proceed with caution.' :
      'Consider stepping down.';

    return { score, color, msg };
  }, [phase, outcome, sessionTrades, gate.lossPct, gate.status, emotion]);

  const sc = gate.status === 'blocked'
    ? { label: 'Blocked', color: C.red,   Icon: CircleSlash  }
    : gate.status === 'caution'
      ? { label: 'Caution', color: C.amber, Icon: AlertTriangle }
      : { label: 'Clear',   color: C.green, Icon: CheckCircle2  };

  function openLimitEditor() {
    const loss  = gate.lossLimit > 0 ? String(gate.lossLimit) : riskSettings?.daily_loss_limit ? String(riskSettings.daily_loss_limit) : '';
    const max   = (dailyStatus?.maxTradesPerDay ?? riskSettings?.max_trades_per_day ?? 0);
    setLimitDraft({
      loss,
      trades:    max > 0 ? String(max) : '',
      riskPct:   riskSettings?.risk_percentage ? String(riskSettings.risk_percentage) : '',
      contracts: riskSettings?.max_contracts_per_trade ? String(riskSettings.max_contracts_per_trade) : '',
    });
    setShowLimits(true);
  }

  async function saveLimits() {
    const loss  = parseFloat(limitDraft.loss);
    const trades = parseInt(limitDraft.trades, 10);
    if (!isFinite(loss) || loss <= 0 || !isFinite(trades) || trades <= 0) return;
    const update: Record<string, number> = { daily_loss_limit: loss, max_trades_per_day: trades };
    const pct = parseFloat(limitDraft.riskPct);
    if (isFinite(pct) && pct > 0) update.risk_percentage = pct;
    const contracts = parseInt(limitDraft.contracts, 10);
    if (isFinite(contracts) && contracts > 0) update.max_contracts_per_trade = contracts;
    setLimitSaving(true);
    try {
      await riskApi.updateSettings(update);
      await refreshSettings();
      setShowLimits(false);
    } catch { /* ignore */ }
    setLimitSaving(false);
  }

  // ── Handlers ──────────────────────────────────────────────────────
  function handleEnterTrade(dir: TradeDir) {
    setDirection(dir);
    setPhase('active');
    setPendingClose(null);
  }

  function handleOutcome(o: Outcome, amount: number) {
    setSessionTrades(prev => [...prev, { direction: direction!, outcome: o, amount }]);
    setOutcome(o);
    setPhase('post');
  }

  function handleConfirmClose() {
    if (!pendingClose) return;
    const amt = Math.max(0, parseFloat(pendingClose.amount) || 0);
    handleOutcome(pendingClose.outcome, amt);
    setPendingClose(null);
  }

  function handleReset() {
    // "New trade" — keep sessionTrades so health/gate reflect the full session
    setPhase('idle');
    setDirection(null);
    setOutcome(null);
    setPendingClose(null);
  }

  function handleDone() {
    const tradeCount = sessionTrades.length;
    const pnl = gate.sessionPnl;
    const msg = { type: 'flyxa:session-done', tradeCount, pnl };

    // Write directly to localStorage — fires a `storage` event in the main Flyxa tab
    // even when this is running in a popup (cross-window localStorage events work cross-tab)
    if (tradeCount > 0) {
      try { localStorage.setItem('flyxa.session-done-prompt', JSON.stringify({ tradeCount, pnl })); } catch { /* ignore */ }
    }
    // Also send via postMessage as secondary channel (iframe + popup modes)
    try { window.parent?.postMessage(msg, '*'); } catch { /* ignore */ }
    try {
      if (window.opener && window.opener !== window) {
        (window.opener as Window).postMessage(msg, '*');
      }
    } catch { /* ignore */ }
    setPhase('idle');
    setDirection(null);
    setOutcome(null);
    setPendingClose(null);
    setSessionTrades([]);
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <main style={{ background: 'transparent', color: C.text, fontFamily: C.sans, padding: '7px 8px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>

      {/* ══ IDLE ════════════════════════════════════════════════════ */}
      {phase === 'idle' && (
        <>
          {/* Emotion pills */}
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

          {/* Verdict */}
          <div style={{ borderLeft: `3px solid ${sc.color}`, paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <sc.Icon size={12} color={sc.color} />
                <span style={{ fontSize: 14, fontWeight: 760, color: sc.color, lineHeight: 1, letterSpacing: '-0.01em' }}>
                  {sc.label}
                </span>
              </div>
              {gate.sessionPnl !== 0 && (
                <span style={{ fontSize: 10, fontFamily: C.mono, fontWeight: 700, color: gate.sessionPnl > 0 ? C.green : C.red }}>
                  {gate.sessionPnl > 0 ? '+' : ''}{fmtMoney(gate.sessionPnl)}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: C.subtle }}>
                {gate.tradeCount} trade{gate.tradeCount !== 1 ? 's' : ''}
              </span>
              {gate.lossLimit > 0 && (
                <span style={{ fontSize: 9, color: gate.lossPct >= 80 ? C.red : C.subtle, fontFamily: C.mono }}>
                  {gate.lossPct}% loss used
                </span>
              )}
            </div>
          </div>

          {/* Top flag */}
          {gate.flags.length > 0 && (
            <div style={{ borderLeft: `2px solid ${gate.flags[0].status === 'blocked' ? C.red : C.amber}`, paddingLeft: 6, paddingTop: 2, paddingBottom: 2 }}>
              <span style={{ fontSize: 9.5, fontWeight: 600, color: gate.flags[0].status === 'blocked' ? C.red : C.amber, display: 'block', lineHeight: 1.3, letterSpacing: '0.01em' }}>
                {gate.flags[0].label}
              </span>
              {gate.flags.length > 1 && (
                <span style={{ fontSize: 8.5, color: C.subtle }}>+{gate.flags.length - 1} more</span>
              )}
            </div>
          )}

          {/* Risk limits row */}
          {!showLimits ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {gate.lossLimit > 0 && (
                  <span style={{ fontSize: 8.5, color: C.subtle, fontFamily: C.mono }}>
                    loss {fmtMoney(gate.lossLimit)}
                  </span>
                )}
                {gate.profitTarget !== null && (
                  <span style={{ fontSize: 8.5, color: gate.sessionPnl >= gate.profitTarget ? C.green : C.subtle, fontFamily: C.mono }}>
                    target {fmtMoney(gate.profitTarget)}
                  </span>
                )}
                {(dailyStatus?.maxTradesPerDay ?? riskSettings?.max_trades_per_day ?? 0) > 0 && (
                  <span style={{ fontSize: 8.5, color: C.subtle, fontFamily: C.mono }}>
                    max {dailyStatus?.maxTradesPerDay ?? riskSettings?.max_trades_per_day} trades
                  </span>
                )}
                {gate.lossLimit === 0 && gate.profitTarget === null && (dailyStatus?.maxTradesPerDay ?? riskSettings?.max_trades_per_day ?? 0) === 0 && (
                  <span style={{ fontSize: 8.5, color: C.subtle }}>no limits set</span>
                )}
              </div>
              <button
                type="button"
                onClick={openLimitEditor}
                style={{ fontSize: 8.5, fontWeight: 600, color: C.amber, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0', letterSpacing: '0.02em' }}
              >edit</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <p style={{ ...KICKER, margin: 0 }}>Risk limits</p>
              {/* Loss limit + max trades */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                {([
                  { key: 'loss',      label: 'Loss limit $', required: true  },
                  { key: 'trades',    label: 'Max trades',   required: true  },
                  { key: 'riskPct',   label: 'Risk %',       required: false },
                  { key: 'contracts', label: 'Max contracts',required: false },
                ] as const).map(({ key, label, required }) => (
                  <div key={key}>
                    <p style={{ margin: '0 0 2px', fontSize: 7.5, color: C.subtle, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {label}{!required && <span style={{ color: C.subtle, opacity: 0.6 }}> opt</span>}
                    </p>
                    <input
                      type="number"
                      min="0"
                      step={key === 'riskPct' ? '0.1' : '1'}
                      placeholder={required ? '—' : 'skip'}
                      value={limitDraft[key]}
                      onChange={e => setLimitDraft(prev => ({ ...prev, [key]: e.target.value }))}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        background: 'rgba(255,255,255,0.04)',
                        border: `1px solid ${C.border}`,
                        borderRadius: 3, padding: '3px 5px',
                        color: C.text, fontSize: 10, fontFamily: C.mono,
                        outline: 'none',
                      }}
                    />
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
                <button
                  type="button"
                  onClick={() => { void saveLimits(); }}
                  disabled={limitSaving}
                  style={{ height: 22, borderRadius: 3, fontSize: 9, fontWeight: 700, border: `1px solid ${C.amber}30`, background: `${C.amber}10`, color: C.amber, cursor: 'pointer' }}
                >{limitSaving ? 'Saving…' : 'Save'}</button>
                <button
                  type="button"
                  onClick={() => setShowLimits(false)}
                  style={{ height: 22, borderRadius: 3, fontSize: 9, border: `1px solid ${C.border}`, background: 'transparent', color: C.subtle, cursor: 'pointer' }}
                >Cancel</button>
              </div>
            </div>
          )}

          {/* Enter trade */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            <button type="button" onClick={() => handleEnterTrade('long')}  disabled={gate.status === 'blocked'} style={dirBtn(C.green, gate.status === 'blocked')}>↑ Long</button>
            <button type="button" onClick={() => handleEnterTrade('short')} disabled={gate.status === 'blocked'} style={dirBtn(C.red,   gate.status === 'blocked')}>↓ Short</button>
          </div>
        </>
      )}

      {/* ══ ACTIVE ══════════════════════════════════════════════════ */}
      {phase === 'active' && direction && (
        <>
          {/* Direction + abort */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: direction === 'long' ? C.green : C.red, boxShadow: `0 0 6px ${direction === 'long' ? C.green : C.red}99`, display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 750, letterSpacing: '0.04em', color: direction === 'long' ? C.green : C.red }}>
                {direction === 'long' ? 'LONG' : 'SHORT'}
              </span>
              <span style={{ fontSize: 9, color: C.subtle }}>in trade</span>
            </div>
            <button
              type="button"
              title="Abort — back to guard"
              onClick={() => { setPhase('idle'); setPendingClose(null); }}
              style={{ background: 'none', border: 'none', color: C.subtle, fontSize: 10, cursor: 'pointer', padding: '2px 4px', lineHeight: 1 }}
            >✕</button>
          </div>

          {/* Reminders */}
          <div>
            <p style={KICKER}>Reminders</p>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {reminders.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 5, padding: '4px 0', borderTop: i > 0 ? `1px solid ${C.border}` : 'none' }}>
                  <span style={{ color: C.subtle, fontSize: 9, lineHeight: '14px', flexShrink: 0, marginTop: 1 }}>–</span>
                  <span style={{ fontSize: 9.5, color: 'rgba(232,227,220,0.50)', lineHeight: 1.4 }}>{r}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Close trade — Win/Loss/BE OR amount entry */}
          {pendingClose === null ? (
            <div style={{ marginTop: 4 }}>
              <p style={KICKER}>Close trade</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                <button type="button" onClick={() => setPendingClose({ outcome: 'win',  amount: '' })} style={outcomeBtn(C.green)}>Win</button>
                <button type="button" onClick={() => setPendingClose({ outcome: 'loss', amount: '' })} style={outcomeBtn(C.red)}>Loss</button>
                <button type="button" onClick={() => handleOutcome('be', 0)}                           style={outcomeBtn(C.amber)}>BE</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 4 }}>
              <p style={KICKER}>{pendingClose.outcome === 'win' ? 'Win amount' : 'Loss amount'}</p>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', flexShrink: 0, color: pendingClose.outcome === 'win' ? C.green : C.red }}>
                  {pendingClose.outcome === 'win' ? 'WIN' : 'LOSS'}
                </span>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: `1px solid ${pendingClose.outcome === 'win' ? C.green : C.red}28`, borderRadius: 3, padding: '0 6px' }}>
                  <span style={{ fontSize: 10, color: C.subtle, marginRight: 2, flexShrink: 0 }}>$</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    placeholder="0"
                    value={pendingClose.amount}
                    onChange={e => setPendingClose(prev => prev ? { ...prev, amount: e.target.value } : null)}
                    onKeyDown={e => { if (e.key === 'Enter') handleConfirmClose(); if (e.key === 'Escape') setPendingClose(null); }}
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                    style={{
                      width: '100%',
                      background: 'transparent',
                      border: 'none',
                      color: C.text,
                      fontSize: 11,
                      fontFamily: C.mono,
                      padding: '4px 0',
                      outline: 'none',
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleConfirmClose}
                  style={{ height: 26, width: 28, borderRadius: 3, fontSize: 12, flexShrink: 0, border: `1px solid ${pendingClose.outcome === 'win' ? C.green : C.red}30`, background: `${pendingClose.outcome === 'win' ? C.green : C.red}10`, color: pendingClose.outcome === 'win' ? C.green : C.red, cursor: 'pointer' }}
                >✓</button>
                <button
                  type="button"
                  onClick={() => setPendingClose(null)}
                  style={{ height: 26, width: 24, borderRadius: 3, fontSize: 10, flexShrink: 0, border: '1px solid rgba(255,255,255,0.06)', background: 'transparent', color: C.subtle, cursor: 'pointer' }}
                >✕</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ══ POST ════════════════════════════════════════════════════ */}
      {phase === 'post' && outcome && healthResult && (() => {
        const last = sessionTrades[sessionTrades.length - 1];
        const wins = sessionTrades.filter(t => t.outcome === 'win').length;
        const losses = sessionTrades.filter(t => t.outcome === 'loss').length;
        const bes = sessionTrades.filter(t => t.outcome === 'be').length;
        return (
          <>
            {/* Outcome + amount */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 17, fontWeight: 780, lineHeight: 1, letterSpacing: '-0.02em', color: outcome === 'win' ? C.green : outcome === 'loss' ? C.red : C.amber }}>
                {outcome === 'win' ? 'WIN' : outcome === 'loss' ? 'LOSS' : 'BE'}
              </span>
              {last && last.amount > 0 && (
                <span style={{ fontSize: 10, fontFamily: C.mono, fontWeight: 700, color: outcome === 'win' ? C.green : outcome === 'loss' ? C.red : C.amber }}>
                  {outcome === 'win' ? '+' : outcome === 'loss' ? '−' : ''}{fmtMoney(last.amount)}
                </span>
              )}
              <span style={{ fontSize: 9, color: C.subtle, marginLeft: 'auto' }}>
                {direction === 'long' ? '↑ long' : '↓ short'}
              </span>
            </div>

            {/* Session summary — cross-referenced with pre-session limits */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9, color: C.subtle }}>
                {wins}W {losses}L{bes > 0 ? ` ${bes}BE` : ''}
              </span>
              {gate.sessionPnl !== 0 && (
                <span style={{ fontSize: 9, fontFamily: C.mono, fontWeight: 600, color: gate.sessionPnl > 0 ? C.green : C.red }}>
                  {gate.sessionPnl > 0 ? '+' : ''}{fmtMoney(gate.sessionPnl)} net
                </span>
              )}
              {gate.lossLimit > 0 && (
                <span style={{ fontSize: 9, fontFamily: C.mono, color: gate.lossPct >= 80 ? C.red : C.subtle }}>
                  {gate.lossPct}% of limit
                </span>
              )}
            </div>

            {/* Health bar */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span style={{ ...KICKER, margin: 0 }}>Session health</span>
                <span style={{ fontSize: 9.5, fontFamily: C.mono, fontWeight: 700, color: healthResult.color }}>{healthResult.score}</span>
              </div>
              <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 2, width: `${healthResult.score}%`, background: healthResult.color, transition: 'width 0.5s cubic-bezier(0.16,1,0.3,1)' }} />
              </div>
            </div>

            {/* Recommendation */}
            <p style={{ margin: 0, fontSize: 10.5, fontWeight: 640, lineHeight: 1.4, letterSpacing: '0.005em', color: healthResult.color }}>
              {healthResult.msg}
            </p>

            {/* Actions */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginTop: 2 }}>
              <button type="button" onClick={handleReset} style={actionBtn('primary')}>New trade</button>
              <button type="button" onClick={handleDone}  style={actionBtn('ghost')}>Done</button>
            </div>
          </>
        );
      })()}
    </main>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

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
    color, cursor: 'pointer',
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
