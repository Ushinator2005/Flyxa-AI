import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Pencil, ArrowUp, ArrowDown } from 'lucide-react';
import { ALL_ACCOUNTS_ID, useAppSettings } from '../contexts/AppSettingsContext.js';
import { useRisk } from '../contexts/RiskContext.js';
import { useTrades } from '../hooks/useTrades.js';
import {
  clearStaleGuardSessionTrades,
  readGuardSessionTrades,
  saveGuardSessionTrades,
  type GuardSessionTrade,
} from '../hooks/useGuardSessionTrades.js';
import useFlyxaStore from '../store/flyxaStore.js';
import { riskApi } from '../services/api.js';
import type { Trade } from '../types/index.js';
import { getMostRecentDailyFlowBefore } from '../utils/dailyFlow.js';
import { getTimeZoneParts } from '../utils/calendarTime.js';
import { CALENDAR_CACHE_KEY } from '../utils/calendarCache.js';
import {
  parsePreSessionSync,
  PRE_SESSION_SYNC_STORAGE_KEY,
} from '../utils/preSessionSync.js';
import { isLivePreSession } from '../utils/sessionLifecycle.js';
import type { RiskRule } from '../store/types.js';

type GateStatus = 'clear' | 'caution' | 'blocked';
type Phase      = 'idle' | 'active' | 'post';
type TradeDir   = 'long' | 'short';
type Outcome    = 'win' | 'loss' | 'be';

const C = {
  bg:     '#0c0c0e',
  text:   'rgba(232,227,220,0.92)',
  muted:  'rgba(180,174,165,0.70)',
  subtle: 'rgba(138,129,120,0.50)',
  amber:  '#f59e0b',
  green:  '#34d399',
  red:    '#f87171',
  border: 'rgba(255,255,255,0.07)',
  sans:   'var(--font-sans)',
  mono:   'var(--font-mono)',
} as const;

// TEMP PREVIEW: set true to downgrade a hard "Blocked" to "Caution" so the
// Long/Short buttons enable and the unblocked dock can be inspected. Remove /
// set false before shipping — this bypasses real trading blocks.
const TEMP_UNBLOCK = false;

// Shared metric-bar styling for the session limit meters (loss / trades / target).
const metricLabel: React.CSSProperties = {
  fontSize: 9, color: C.subtle, letterSpacing: '0.11em', textTransform: 'uppercase', fontWeight: 600,
};
const metricTrack: React.CSSProperties = {
  height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.06)', overflow: 'hidden',
};
const metricFill: React.CSSProperties = {
  height: '100%', borderRadius: 3, transition: 'width 0.4s ease, background 0.3s ease',
};

// The session limit editor is driven entirely by the numeric rules the user has
// set on their Rules page — one field per enabled rule, shown in this order.
type RuleKind = NonNullable<RiskRule['kind']>;
const RULE_FIELD_META: Partial<Record<RuleKind, { label: string; step: string }>> = {
  max_daily_loss:      { label: 'Loss $',        step: '1'   },
  max_trades:          { label: 'Max trades',    step: '1'   },
  max_contracts:       { label: 'Max contracts', step: '1'   },
  min_rr:              { label: 'Min R:R',       step: '0.1' },
  cooldown_after_loss: { label: 'Cooldown min',  step: '1'   },
};
const RULE_FIELD_ORDER: RuleKind[] = ['max_daily_loss', 'max_trades', 'max_contracts', 'min_rr', 'cooldown_after_loss'];

// The number a rule shows in the editor. Max-contracts prefers its per-instrument
// caps (highest) so a rule set as "MNQ 10" reads 10, not its flat fallback value.
function ruleEditableValue(rule: RiskRule): string {
  if ((rule.kind ?? 'manual') === 'max_contracts') {
    const caps = Object.values(rule.contractLimits ?? {}).filter((n): n is number => Number.isFinite(n) && n > 0);
    if (caps.length > 0) return String(Math.max(...caps));
  }
  const v = Number(rule.value);
  return Number.isFinite(v) && v > 0 ? String(v) : '';
}

function todayKey(timeZone: string) {
  return getTimeZoneParts(new Date(), timeZone).date;
}

function fmtMoney(v: number) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// A win OR a break-even resets the consecutive loss streak.
function sessionConsecLosses(trades: GuardSessionTrade[]): number {
  let n = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].outcome === 'loss') n++;
    else break;
  }
  return n;
}

function getCalRisk(timeZone: string): string | null {
  try {
    const raw = window.localStorage.getItem(CALENDAR_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { events?: Array<{ event?: string; date?: string; time?: string; impact?: string; actual?: string }> };
    if (!Array.isArray(parsed.events)) return null;
    const today = todayKey(timeZone);
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

function enabledPlanRule(rules: RiskRule[], kind: NonNullable<RiskRule['kind']>): RiskRule | null {
  return rules.find(rule => (rule.kind ?? 'manual') === kind && rule.enabled !== false) ?? null;
}

function numericRuleValue(rule: RiskRule | null): number | null {
  if (!rule) return null;
  const value = Number(rule.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function clockMinutes(value: string | null | undefined): number | null {
  if (!value || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function isInsideWindow(now: string, start: string | undefined, end: string | undefined): boolean | null {
  const current = clockMinutes(now);
  const startMinutes = clockMinutes(start);
  const endMinutes = clockMinutes(end);
  if (current === null || startMinutes === null || endMinutes === null) return null;
  return startMinutes <= endMinutes
    ? current >= startMinutes && current <= endMinutes
    : current >= startMinutes || current <= endMinutes;
}

export default function TradeCheck() {
  const { trades }                                           = useTrades();
  const { selectedAccountId, filterTradesBySelectedAccount, preferences } = useAppSettings();
  const { dailyStatus, riskLevel, settings: riskSettings, refreshSettings } = useRisk();
  const activePreSession                                      = useFlyxaStore(state => state.preSession);
  const preSessionHistory                                    = useFlyxaStore(state => state.preSessionHistory);
  const riskRules                                            = useFlyxaStore(state => state.riskRules);
  const activeStartedAt = isLivePreSession(activePreSession) ? activePreSession.startedAt : undefined;

  const [phase, setPhase]                 = useState<Phase>('idle');
  const [direction, setDirection]         = useState<TradeDir | null>(null);
  const [outcome, setOutcome]             = useState<Outcome | null>(null);
  const [sessionTrades, setSessionTrades] = useState<GuardSessionTrade[]>(() => readGuardSessionTrades(activeStartedAt));
  // pendingClose: Win or Loss was tapped — waiting for $ amount before confirming
  const [pendingClose, setPendingClose]   = useState<{ outcome: Exclude<Outcome, 'be'>; amount: string } | null>(null);
  // Inline risk-limit editor
  const [showLimits, setShowLimits]       = useState(false);
  const [ruleDraft, setRuleDraft]         = useState<Record<string, string>>({});
  const [limitSaving, setLimitSaving]     = useState(false);
  const sessionStartedAtRef = useRef<string | null>(activeStartedAt ?? null);
  const currentDate = todayKey(preferences.timezone);

  // Trade Lens can live in a separate popup window. Zustand updates in the main
  // app do not automatically update an already-open popup, so consume the
  // dedicated pre-session storage signal and refresh only the relevant fields.
  useEffect(() => {
    const applyPreSession = (value: string | null) => {
      const payload = parsePreSessionSync(value);
      if (!payload) return;

      useFlyxaStore.setState(state => ({
        preSession: isLivePreSession(payload.data) ? payload.data : null,
        preSessionHistory: {
          ...state.preSessionHistory,
          [payload.date]: payload.data,
        },
      }));
    };
    const syncPreSession = (event: StorageEvent) => {
      if (event.key !== PRE_SESSION_SYNC_STORAGE_KEY) return;
      applyPreSession(event.newValue);
    };

    applyPreSession(window.localStorage.getItem(PRE_SESSION_SYNC_STORAGE_KEY));
    window.addEventListener('storage', syncPreSession);
    return () => window.removeEventListener('storage', syncPreSession);
  }, []);

  useEffect(() => {
    clearStaleGuardSessionTrades(activeStartedAt);
    setSessionTrades(readGuardSessionTrades(activeStartedAt));
  }, []);

  // Persist session trades whenever they change (date-keyed, auto-expires next day)
  useEffect(() => {
    if (sessionStartedAtRef.current === (activeStartedAt ?? null)) return;
    sessionStartedAtRef.current = activeStartedAt ?? null;
    clearStaleGuardSessionTrades(activeStartedAt);
    setSessionTrades(readGuardSessionTrades(activeStartedAt));
  }, [activeStartedAt]);

  useEffect(() => {
    if (!sessionStartedAtRef.current) return;
    saveGuardSessionTrades(sessionTrades, sessionStartedAtRef.current);
  }, [sessionTrades]);

  // scopedTrades used only for priorFlow (yesterday's rules) — not for gate checks
  const scopedTrades = useMemo<Trade[]>(() => {
    if (!selectedAccountId || selectedAccountId === ALL_ACCOUNTS_ID) return filterTradesBySelectedAccount(trades);
    return trades.filter(t => {
      const ids = t.accountIds ?? [t.accountId, t.account_id].filter(Boolean) as string[];
      return ids.includes(selectedAccountId);
    });
  }, [filterTradesBySelectedAccount, selectedAccountId, trades]);

  const priorFlow = useMemo(
    () => getMostRecentDailyFlowBefore(scopedTrades, currentDate),
    [currentDate, scopedTrades],
  );

  // ── Gate: all session-level checks use local sessionTrades, not the DB ──
  const gate = useMemo(() => {
    const historyPreSession = preSessionHistory[currentDate];
    const activeSessionDate = activeStartedAt
      ? getTimeZoneParts(new Date(activeStartedAt), preferences.timezone).date
      : null;
    const preSession = historyPreSession
      ?? (activeSessionDate === currentDate ? activePreSession : null);

    const tradeCount  = sessionTrades.length;
    const sessionLoss = sessionTrades
      .filter(t => t.outcome === 'loss')
      .reduce((s, t) => s + t.amount, 0);
    const sessionPnl  = sessionTrades.reduce((s, t) =>
      s + (t.outcome === 'win' ? t.amount : t.outcome === 'loss' ? -t.amount : 0), 0);
    const consec      = sessionConsecLosses(sessionTrades);

    const planMaxTrades = numericRuleValue(enabledPlanRule(riskRules, 'max_trades'));
    const planLossLimit = numericRuleValue(enabledPlanRule(riskRules, 'max_daily_loss'));
    const timeWindowRule = enabledPlanRule(riskRules, 'time_window');
    const cooldownMinutes = numericRuleValue(enabledPlanRule(riskRules, 'cooldown_after_loss'));
    const maxTrades   = planMaxTrades ?? dailyStatus?.maxTradesPerDay  ?? dailyStatus?.settings?.max_trades_per_day ?? riskSettings?.max_trades_per_day ?? 0;
    // Session max loss: prefer pre-session override, then DB risk settings
    const lossLimit   = (preSession?.sessionMaxLoss ?? 0) > 0
      ? preSession!.sessionMaxLoss!
      : (planLossLimit ?? dailyStatus?.dailyLossLimit ?? dailyStatus?.settings?.daily_loss_limit ?? riskSettings?.daily_loss_limit ?? 0);
    const profitTarget = (preSession?.dailyTarget ?? 0) > 0 ? preSession!.dailyTarget! : null;
    const lossPct     = lossLimit > 0 ? (sessionLoss / lossLimit) * 100 : 0;
    const newsRisk    = getNewsRisk();
    const calRisk     = getCalRisk(preferences.timezone);
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
      flags.push(flag('caution', `Target hit ${fmtMoney(profitTarget)}, protect gains`));

    if (maxTrades > 0 && tradeCount >= maxTrades)
      flags.push(flag('blocked', `Max trades (${tradeCount}/${maxTrades})`));
    else if (maxTrades > 0 && tradeCount === maxTrades - 1)
      flags.push(flag('caution', `Last trade, cap is ${maxTrades}`));

    if (timeWindowRule) {
      const now = getTimeZoneParts(new Date(), preferences.timezone).time;
      const insideWindow = isInsideWindow(now, timeWindowRule.startTime, timeWindowRule.endTime);
      if (insideWindow === false) {
        flags.push(flag('blocked', `Outside plan window ${timeWindowRule.startTime}-${timeWindowRule.endTime}`));
      } else if (insideWindow === null) {
        flags.push(flag('caution', 'Trading window rule needs valid times'));
      }
    }

    if (consec >= 2)
      flags.push(flag('blocked', `${consec} consecutive losses`));
    else if (consec === 1)
      flags.push(flag('caution', 'Post-loss, confirm thesis'));

    if (cooldownMinutes && consec >= 1)
      flags.push(flag('blocked', `Trading Plan cooldown: wait ${cooldownMinutes} min after loss`));

    // Pre-session brief
    if (preSession?.readiness?.status === 'Stand Down') {
      const reason = preSession.readiness.reasons[0];
      flags.push(flag(
        'blocked',
        reason ? `Pre-session: ${reason}` : 'Pre-session: stand down',
      ));
    }
    else if (preSession?.readiness?.status === 'Caution')
      flags.push(flag('caution', 'Pre-session caution'));
    else if (!preSession)
      flags.push(flag('caution', 'No pre-session brief'));

    const prescriptions = preSession?.prescriptions ?? [];
    if (prescriptions.some(rule => rule.type === 'post_loss_pause' && rule.value === true) && consec >= 1)
      flags.push(flag('blocked', 'Active rule: pause after a loss'));
    if (prescriptions.some(rule => rule.type === 'plan_only' && rule.value === true))
      flags.push(flag('caution', 'Active rule: written-plan setups only'));

    // Yesterday's self-set rule
    if (priorFlow?.tomorrowRule) {
      const rule = priorFlow.tomorrowRule.toLowerCase();
      const blocked =
        (rule.includes('max 2 trades') && tradeCount >= 2) ||
        (rule.includes('stop after 2 losses') && consec >= 2);
      flags.push(flag(blocked ? 'blocked' : 'caution', `Rule: ${priorFlow.tomorrowRule}`));
    }

    // Market risk
    if (newsRisk)     flags.push(flag('caution', `News: ${newsRisk.length > 46 ? newsRisk.slice(0, 43) + '…' : newsRisk}`));
    else if (calRisk) flags.push(flag('caution', `Calendar: ${calRisk}`));

    let status: GateStatus = flags.some(f => f.status === 'blocked') ? 'blocked'
      : flags.some(f => f.status === 'caution') ? 'caution' : 'clear';
    // TEMP: let the user preview the unblocked dock (see TEMP_UNBLOCK note above).
    if (TEMP_UNBLOCK && status === 'blocked') status = 'caution';

    return { status, flags, sessionPnl, sessionLoss, tradeCount, lossPct: Math.round(lossPct), lossLimit, profitTarget, maxTrades };
  }, [
    activePreSession,
    currentDate,
    dailyStatus,
    preferences.timezone,
    preSessionHistory,
    priorFlow,
    riskLevel,
    riskSettings,
    riskRules,
    sessionTrades,
  ]);

  // Reminders for active phase — pulled from pre-session data
  const reminders = useMemo<string[]>(() => {
    const list: string[] = [];
    const activePlan = activePreSession?.sessionPlan ?? [];
    activePlan.slice(0, 2).forEach(item => list.push(item.rule));
    if (priorFlow?.tomorrowRule) list.push(priorFlow.tomorrowRule);
    list.push('Respect your TP, no early exits');
    list.push("Don't move SL into a loss");
    list.push('Stick to the plan, no improvising');
    return list.slice(0, 3);
  }, [activePreSession?.sessionPlan, priorFlow]);

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
    score = Math.max(0, Math.min(100, score));

    const color = score >= 65 ? C.green : score >= 40 ? C.amber : C.red;
    const msg =
      gate.status === 'blocked' || score < 35 ? 'Step down, limits hit' :
      outcome === 'win' && score >= 70 ? 'Good trade. Edge intact.' :
      score >= 55 ? 'Proceed with caution.' :
      'Consider stepping down.';

    return { score, color, msg };
  }, [phase, outcome, sessionTrades, gate.lossPct, gate.status]);

  const maxTrades = gate.maxTrades;

  const sc = gate.status === 'blocked'
    ? { label: 'Blocked', color: C.red,   Icon: CircleSlash  }
    : gate.status === 'caution'
      ? { label: 'Caution', color: C.amber, Icon: AlertTriangle }
      : { label: 'Clear',   color: C.green, Icon: CheckCircle2  };

  // The editor pulls straight from the user's Rules page: every enabled numeric
  // rule they have, in a sensible order. Nothing is invented — if a rule isn't
  // on their Rules page, it doesn't show here.
  const editableRules = useMemo<RiskRule[]>(() =>
    RULE_FIELD_ORDER
      .map(kind => riskRules.find(r => (r.kind ?? 'manual') === kind && r.enabled !== false && RULE_FIELD_META[kind]))
      .filter((r): r is RiskRule => !!r && ruleEditableValue(r) !== ''),
  [riskRules]);

  function openLimitEditor() {
    // Seed each field straight from the user's Rules page value.
    const draft: Record<string, string> = {};
    for (const rule of editableRules) draft[rule.id] = ruleEditableValue(rule);
    setRuleDraft(draft);
    setShowLimits(true);
  }

  async function saveLimits() {
    // Write every edited value back to its rule on the Rules page (store →
    // Supabase). Per-instrument contract caps are left to the Rules page when
    // there is more than one instrument, so a single edit can't flatten them.
    const current = useFlyxaStore.getState().riskRules;
    const settingsUpdate: Record<string, number> = {};
    let changed = false;

    const next = current.map(rule => {
      const kind = (rule.kind ?? 'manual') as RuleKind;
      if (rule.enabled === false || !RULE_FIELD_META[kind]) return rule;
      const raw = ruleDraft[rule.id];
      if (raw === undefined || raw.trim() === '') return rule;
      const v = parseFloat(raw);
      if (!isFinite(v) || v < 0) return rule;

      // Mirror the gate-relevant caps into risk settings so the backend daily
      // status and warnings stay in step with the Rules page.
      if (kind === 'max_daily_loss') settingsUpdate.daily_loss_limit = v;
      if (kind === 'max_trades')     settingsUpdate.max_trades_per_day = v;
      if (kind === 'max_contracts')  settingsUpdate.max_contracts_per_trade = v;

      if (kind === 'max_contracts') {
        const entries = Object.entries(rule.contractLimits ?? {});
        if (entries.length === 1) {
          const [sym] = entries[0];
          if ((rule.contractLimits ?? {})[sym] === v) return rule;
          changed = true;
          return { ...rule, contractLimits: { ...rule.contractLimits, [sym]: v } };
        }
        if (entries.length > 1) return rule; // multiple caps, edit on the Rules page
      }
      if (rule.value === String(v)) return rule;
      changed = true;
      return { ...rule, value: String(v) };
    });

    setLimitSaving(true);
    try {
      if (changed) useFlyxaStore.getState().updateRiskRules(next);
      if (Object.keys(settingsUpdate).length > 0) {
        await riskApi.updateSettings(settingsUpdate);
        await refreshSettings();
      }
    } catch { /* ignore */ }
    setShowLimits(false);
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
    // Do NOT clear sessionTrades — accumulate across the full day's sessions.
    // The stored trades auto-expire on the next calendar day.
  }

  function handleNewSession() {
    // Deliberately clear all session trades for a manual fresh start within the same day.
    // Requires the user to explicitly tap "New session" — not triggered automatically.
    saveGuardSessionTrades([], sessionStartedAtRef.current);
    setSessionTrades([]);
    setPhase('idle');
    setDirection(null);
    setOutcome(null);
    setPendingClose(null);
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <main style={{ background: C.bg, color: C.text, fontFamily: C.sans, padding: '8px', display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto' }}>

      {/* ══ IDLE ════════════════════════════════════════════════════ */}
      {phase === 'idle' && (
        <>
          {/* Status header — a solid dark status bar with a colored accent stripe,
              distinct from the solid color-fill Long/Short buttons below. */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '9px 11px',
            background: '#17171c',
            border: '1px solid rgba(255,255,255,0.07)',
            borderLeft: `3px solid ${sc.color}`,
            borderRadius: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <sc.Icon size={13} color={sc.color} strokeWidth={2.4} style={{ flexShrink: 0 }} />
              <span style={{ fontSize: 10, fontWeight: 600, color: sc.color, lineHeight: 1, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: C.sans }}>
                {sc.label}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {gate.sessionPnl !== 0 && (
                <span style={{ fontSize: 11, fontFamily: C.mono, fontWeight: 700, color: gate.sessionPnl > 0 ? C.green : C.red }}>
                  {gate.sessionPnl > 0 ? '+' : ''}{fmtMoney(gate.sessionPnl)}
                </span>
              )}
              <button type="button" onClick={openLimitEditor} title="Edit limits"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  fontSize: 9, fontWeight: 600, color: C.muted, background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${C.border}`, cursor: 'pointer', padding: '3px 7px',
                  letterSpacing: '0.04em', borderRadius: 5, fontFamily: C.sans, textTransform: 'uppercase',
                }}>
                <Pencil size={9} strokeWidth={2.2} /> Edit
              </button>
            </div>
          </div>

          {/* Live stats bars — hidden when limit editor is open */}
          {!showLimits && (
            <>
              {(gate.lossLimit > 0 || maxTrades > 0 || (gate.profitTarget !== null && gate.profitTarget > 0)) && (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 10,
                  padding: '11px 11px 12px',
                  background: 'rgba(255,255,255,0.015)',
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                }}>
                  {/* Loss bar */}
                  {gate.lossLimit > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                        <span style={metricLabel}>Loss</span>
                        <span style={{ fontSize: 10, fontFamily: C.mono, color: gate.lossPct >= 80 ? C.red : C.muted }}>
                          {fmtMoney(gate.sessionLoss)}<span style={{ opacity: 0.4 }}> / {fmtMoney(gate.lossLimit)}</span>
                        </span>
                      </div>
                      <div style={metricTrack}>
                        <div style={{ ...metricFill,
                          width: `${Math.min(100, gate.lossPct)}%`,
                          background: gate.lossPct >= 100 ? C.red
                            : gate.sessionPnl > 0 ? C.green
                            : gate.lossPct >= 80 ? C.red
                            : gate.sessionPnl < 0 ? 'rgba(248,113,113,0.65)'
                            : 'rgba(255,255,255,0.12)' }} />
                      </div>
                    </div>
                  )}

                  {/* Trade segments */}
                  {maxTrades > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                        <span style={metricLabel}>Trades</span>
                        <span style={{ fontSize: 10, fontFamily: C.mono, color: gate.tradeCount >= maxTrades ? C.red : C.muted }}>
                          {gate.tradeCount}<span style={{ opacity: 0.4 }}> / {maxTrades}</span>
                        </span>
                      </div>
                      {maxTrades <= 8 ? (
                        <div style={{ display: 'flex', gap: 3 }}>
                          {Array.from({ length: maxTrades }).map((_, i) => (
                            <div key={i} style={{ flex: 1, height: 5, borderRadius: 3,
                              background: i < gate.tradeCount
                                ? (gate.tradeCount >= maxTrades ? C.red : C.amber)
                                : 'rgba(255,255,255,0.06)',
                              transition: 'background 0.3s ease' }} />
                          ))}
                        </div>
                      ) : (
                        <div style={metricTrack}>
                          <div style={{ ...metricFill,
                            width: `${Math.min(100, (gate.tradeCount / maxTrades) * 100)}%`,
                            background: gate.tradeCount >= maxTrades ? C.red : C.amber }} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* Profit target bar */}
                  {gate.profitTarget !== null && gate.profitTarget > 0 && (
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                        <span style={metricLabel}>Target</span>
                        <span style={{ fontSize: 10, fontFamily: C.mono, color: gate.sessionPnl >= gate.profitTarget ? C.green : C.muted }}>
                          {fmtMoney(Math.max(0, gate.sessionPnl))}<span style={{ opacity: 0.4 }}> / {fmtMoney(gate.profitTarget)}</span>
                        </span>
                      </div>
                      <div style={metricTrack}>
                        <div style={{ ...metricFill,
                          width: `${Math.min(100, Math.max(0, (gate.sessionPnl / gate.profitTarget) * 100))}%`,
                          background: gate.sessionPnl >= gate.profitTarget ? C.green : 'rgba(52,211,153,0.4)' }} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* No limits set hint */}
              {gate.lossLimit === 0 && maxTrades === 0 && gate.profitTarget === null && (
                <span style={{ fontSize: 10, color: C.subtle }}>no limits set, <button type="button" onClick={openLimitEditor} style={{ background: 'none', border: 'none', color: C.amber, cursor: 'pointer', fontSize: 10, padding: 0, fontFamily: C.sans }}>add limits</button></span>
              )}
            </>
          )}

          {/* Limit editor (inline) */}
          {showLimits && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              padding: '9px 9px',
              background: 'rgba(255,255,255,0.015)',
              border: `1px solid ${C.border}`,
              borderRadius: 7,
            }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
                {editableRules.map((rule) => {
                  const meta = RULE_FIELD_META[(rule.kind ?? 'manual') as RuleKind]!;
                  return (
                    <div key={rule.id}>
                      <p style={{ ...metricLabel, fontSize: 8.5, margin: '0 0 3px' }}>
                        {meta.label}
                      </p>
                      <input type="number" min="0" step={meta.step} inputMode="decimal"
                        placeholder="0" value={ruleDraft[rule.id] ?? ''}
                        onChange={e => setRuleDraft(prev => ({ ...prev, [rule.id]: e.target.value }))}
                        onFocus={e => { e.currentTarget.style.borderColor = C.amber; e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
                        onBlur={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                        style={{ width: '100%', boxSizing: 'border-box', height: 26, background: 'rgba(255,255,255,0.03)',
                          border: `1px solid ${C.border}`, borderRadius: 5, padding: '0 7px',
                          color: C.text, fontSize: 11.5, fontFamily: C.mono, outline: 'none',
                          transition: 'border-color 0.12s, background 0.12s' }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <button type="button" onClick={() => { void saveLimits(); }} disabled={limitSaving}
                  style={{ height: 28, borderRadius: 6, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.02em',
                    border: '1px solid transparent', background: limitSaving ? `${C.amber}55` : C.amber, color: '#0b0b0d',
                    cursor: limitSaving ? 'default' : 'pointer', transition: 'all 0.12s' }}>
                  {limitSaving ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => setShowLimits(false)}
                  style={{ height: 28, borderRadius: 6, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.02em',
                    border: `1px solid ${C.border}`, background: 'rgba(255,255,255,0.045)', color: C.muted, cursor: 'pointer', transition: 'all 0.12s' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Reason — one clean line: the single most important flag, with a quiet
              count if others exist. The amber status header carries the rest. */}
          {gate.flags.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 11px',
              background: 'rgba(255,255,255,0.015)',
              border: `1px solid ${C.border}`,
              borderRadius: 8,
            }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                background: gate.flags[0].status === 'blocked' ? C.red : C.amber,
              }} />
              <span style={{
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontSize: 9.5, fontWeight: 600, letterSpacing: '0.01em',
                color: gate.flags[0].status === 'blocked' ? C.red : C.amber,
              }}>
                {gate.flags[0].label}
              </span>
              {gate.flags.length > 1 && (
                <span style={{ fontSize: 8.5, color: C.subtle, flexShrink: 0 }}>
                  +{gate.flags.length - 1}
                </span>
              )}
            </div>
          )}

          {/* Enter trade */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <button type="button" onClick={() => handleEnterTrade('long')}  disabled={gate.status === 'blocked'} style={dirBtn(C.green, gate.status === 'blocked')}>
              <ArrowUp size={13} strokeWidth={2.5} /> Long
            </button>
            <button type="button" onClick={() => handleEnterTrade('short')} disabled={gate.status === 'blocked'} style={dirBtn(C.red,   gate.status === 'blocked')}>
              <ArrowDown size={13} strokeWidth={2.5} /> Short
            </button>
          </div>

          {/* New session reset — only shown when blocked by session trades */}
          {gate.status === 'blocked' && sessionTrades.length > 0 && (
            <button
              type="button"
              onClick={handleNewSession}
              style={{
                background: 'none', border: `1px solid rgba(255,255,255,0.08)`,
                borderRadius: 5, color: C.subtle, fontSize: 9, fontWeight: 600,
                cursor: 'pointer', padding: '5px 0', letterSpacing: '0.06em',
                textTransform: 'uppercase', width: '100%',
              }}
            >
              New session, clear {sessionTrades.length} trade{sessionTrades.length !== 1 ? 's' : ''}
            </button>
          )}
        </>
      )}

      {/* ══ ACTIVE ══════════════════════════════════════════════════ */}
      {phase === 'active' && direction && (
        <>
          {/* Direction banner */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '6px 8px',
            background: direction === 'long' ? `${C.green}0e` : `${C.red}0e`,
            border: `1px solid ${direction === 'long' ? `${C.green}28` : `${C.red}28`}`,
            borderRadius: 5,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: direction === 'long' ? C.green : C.red,
                display: 'inline-block', flexShrink: 0,
              }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: direction === 'long' ? C.green : C.red, textTransform: 'uppercase' }}>
                {direction === 'long' ? 'LONG' : 'SHORT'}
              </span>
              <span style={{ fontSize: 9, color: C.subtle }}>in trade</span>
            </div>
            <button
              type="button"
              title="Abort, back to Lens"
              onClick={() => { setPhase('idle'); setPendingClose(null); }}
              style={{ background: 'none', border: 'none', color: C.subtle, fontSize: 12, cursor: 'pointer', padding: '2px 4px', lineHeight: 1 }}
            >✕</button>
          </div>

          {/* Reminders */}
          <div>
            <p style={KICKER}>Reminders</p>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {reminders.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, padding: '5px 0', borderTop: i > 0 ? `1px solid ${C.border}` : 'none' }}>
                  <span style={{ color: C.amber, fontSize: 9, lineHeight: '15px', flexShrink: 0 }}>–</span>
                  <span style={{ fontSize: 10, color: 'rgba(232,227,220,0.58)', lineHeight: 1.45 }}>{r}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Close trade — Win/Loss/BE OR amount entry */}
          {pendingClose === null ? (
            <div style={{ marginTop: 2 }}>
              <p style={KICKER}>Close trade</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4 }}>
                <button type="button" onClick={() => setPendingClose({ outcome: 'win',  amount: '' })} style={outcomeBtn(C.green)}>Win</button>
                <button type="button" onClick={() => setPendingClose({ outcome: 'loss', amount: '' })} style={outcomeBtn(C.red)}>Loss</button>
                <button type="button" onClick={() => handleOutcome('be', 0)}                           style={outcomeBtn(C.amber)}>BE</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 2 }}>
              <p style={KICKER}>{pendingClose.outcome === 'win' ? 'Win amount' : 'Loss amount'}</p>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', flexShrink: 0, color: pendingClose.outcome === 'win' ? C.green : C.red, textTransform: 'uppercase' }}>
                  {pendingClose.outcome === 'win' ? 'WIN' : 'LOSS'}
                </span>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: `1px solid ${pendingClose.outcome === 'win' ? C.green : C.red}28`, borderRadius: 4, padding: '0 6px' }}>
                  <span style={{ fontSize: 11, color: C.subtle, marginRight: 2, flexShrink: 0 }}>$</span>
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
                      width: '100%', background: 'transparent', border: 'none',
                      color: C.text, fontSize: 12, fontFamily: C.mono,
                      padding: '5px 0', outline: 'none',
                    }}
                  />
                </div>
                <button
                  type="button"
                  onClick={handleConfirmClose}
                  style={{ height: 26, width: 26, borderRadius: 4, fontSize: 12, flexShrink: 0, border: `1px solid ${pendingClose.outcome === 'win' ? C.green : C.red}35`, background: `${pendingClose.outcome === 'win' ? C.green : C.red}12`, color: pendingClose.outcome === 'win' ? C.green : C.red, cursor: 'pointer' }}
                >✓</button>
                <button
                  type="button"
                  onClick={() => setPendingClose(null)}
                  style={{ height: 26, width: 22, borderRadius: 4, fontSize: 10, flexShrink: 0, border: '1px solid rgba(255,255,255,0.07)', background: 'transparent', color: C.subtle, cursor: 'pointer' }}
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
        const outColor = outcome === 'win' ? C.green : outcome === 'loss' ? C.red : C.amber;
        return (
          <>
            {/* Outcome card */}
            <div style={{
              padding: '7px 9px',
              background: `${outColor}0d`,
              border: `1px solid ${outColor}28`,
              borderRadius: 5,
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <span style={{ fontSize: 17, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.02em', color: outColor }}>
                  {outcome === 'win' ? 'WIN' : outcome === 'loss' ? 'LOSS' : 'BE'}
                </span>
                {last && last.amount > 0 && (
                  <span style={{ fontSize: 11, fontFamily: C.mono, fontWeight: 700, color: outColor }}>
                    {outcome === 'win' ? '+' : outcome === 'loss' ? '−' : ''}{fmtMoney(last.amount)}
                  </span>
                )}
                <span style={{ fontSize: 9, color: C.subtle, marginLeft: 'auto' }}>
                  {direction === 'long' ? '↑ long' : '↓ short'}
                </span>
              </div>
            </div>

            {/* Session summary */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 9.5, color: C.subtle, fontFamily: C.mono }}>
                {wins}W {losses}L{bes > 0 ? ` ${bes}BE` : ''}
              </span>
              {gate.sessionPnl !== 0 && (
                <span style={{ fontSize: 9.5, fontFamily: C.mono, fontWeight: 600, color: gate.sessionPnl > 0 ? C.green : C.red }}>
                  {gate.sessionPnl > 0 ? '+' : ''}{fmtMoney(gate.sessionPnl)} net
                </span>
              )}
              {gate.lossLimit > 0 && (
                <span style={{ fontSize: 9.5, fontFamily: C.mono, color: gate.lossPct >= 80 ? C.red : C.subtle }}>
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
              <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                <div style={{ height: '100%', borderRadius: 2, width: `${healthResult.score}%`, background: healthResult.color, boxShadow: `0 0 8px ${healthResult.color}70`, transition: 'width 0.5s cubic-bezier(0.16,1,0.3,1)' }} />
              </div>
            </div>

            {/* Recommendation */}
            <p style={{ margin: 0, fontSize: 10.5, fontWeight: 650, lineHeight: 1.4, letterSpacing: '0.005em', color: healthResult.color }}>
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
  fontSize: 8.5,
  color: 'rgba(138,129,120,0.48)',
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontWeight: 600,
};

function dirBtn(color: string, disabled: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
    height: 36, borderRadius: 7, fontSize: 12, fontWeight: 700,
    // Solid fill with dark text when active; a clean muted solid when blocked.
    border: disabled ? '1px solid rgba(255,255,255,0.08)' : `1px solid ${color}`,
    background: disabled ? 'rgba(255,255,255,0.045)' : color,
    color: disabled ? 'rgba(180,174,165,0.5)' : '#0b0b0d',
    cursor: disabled ? 'not-allowed' : 'pointer',
    letterSpacing: '0.04em',
    transition: 'all 0.12s',
  };
}

function outcomeBtn(color: string): React.CSSProperties {
  return {
    height: 28, borderRadius: 4, fontSize: 11, fontWeight: 700,
    border: `1px solid ${color}32`,
    background: `${color}0e`,
    color, cursor: 'pointer',
    letterSpacing: '0.04em',
    transition: 'all 0.12s',
  };
}

function actionBtn(variant: 'primary' | 'ghost'): React.CSSProperties {
  return {
    height: 26, borderRadius: 4, fontSize: 9.5, fontWeight: 650,
    border: variant === 'primary' ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(255,255,255,0.05)',
    background: variant === 'primary' ? 'rgba(255,255,255,0.06)' : 'transparent',
    color: variant === 'primary' ? 'rgba(210,204,195,0.85)' : 'rgba(138,129,120,0.65)',
    cursor: 'pointer',
  };
}
