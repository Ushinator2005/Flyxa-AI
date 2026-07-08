import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { PreSessionData } from '../store/types.js';
import { buildDailyFlowInsight } from '../utils/dailyFlow.js';
import DatePicker from '../components/common/DatePicker.js';
import { getTimeZoneParts } from '../utils/calendarTime.js';
import { limitsFromPreSession, summarizePerformanceOutcome } from '../utils/performanceLoop.js';
import { isLivePreSession } from '../utils/sessionLifecycle.js';
import { flushSupabaseStoreNow } from '../store/supabaseStorage.js';

const C = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252', amb: '#f59e0b',
  mono: "'DM Mono', ui-monospace, monospace",
};

const CARD_BORDER = `1px solid ${C.b0}`;

function fmtCurrency(v: number) {
  return v.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function fmtSigned(v: number) {
  return `${v >= 0 ? '+' : '-'}${fmtCurrency(Math.abs(v))}`;
}

const EMOTION_COLORS: Record<string, string> = {
  Frustrated: C.red,
  Anxious: C.amb,
  Neutral: C.t1,
  Focused: C.grn,
  Confident: '#4a9eff',
};

function emotionColor(emotion: string): string {
  return EMOTION_COLORS[emotion] ?? C.t1;
}

function readinessColor(status: string): string {
  if (status === 'Ready') return C.grn;
  if (status === 'Caution') return C.amb;
  return C.red;
}

function biasColor(bias: string): string {
  if (bias === 'Bull') return C.grn;
  if (bias === 'Bear') return C.red;
  return C.t2;
}

function adherenceColor(pct: number): string {
  if (pct >= 80) return C.grn;
  if (pct >= 50) return C.amb;
  return C.red;
}

type InsightType = 'good' | 'warn' | 'bad' | 'neutral';
interface Insight { type: InsightType; text: string; }

function insightColor(type: InsightType) {
  if (type === 'good')    return C.grn;
  if (type === 'warn')    return C.amb;
  if (type === 'bad')     return C.red;
  return C.t1;
}

function insightDot(type: InsightType) {
  if (type === 'good')    return C.grn;
  if (type === 'warn')    return C.amb;
  if (type === 'bad')     return C.red;
  return C.t2;
}

export default function FlyxaAIPostSession() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount, preferences } = useAppSettings();
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);
  const setPreSessionForDate = useFlyxaStore(state => state.setPreSessionForDate);
  const activePreSession = useFlyxaStore(state => state.preSession);
  const riskRules = useFlyxaStore(state => state.riskRules);
  const requestedDate = searchParams.get('date');
  // Use timezone-aware date so it matches how pre-session saves its history key
  const [selectedDate, setSelectedDate] = useState(() =>
    requestedDate || getTimeZoneParts(new Date(), preferences.timezone).date
  );

  useEffect(() => {
    if (requestedDate && requestedDate !== selectedDate) {
      setSelectedDate(requestedDate);
    }
  }, [requestedDate, selectedDate]);

  const handleSelectedDateChange = (date: string) => {
    setSelectedDate(date);
    setSearchParams(date ? { date } : {});
  };

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades]
  );

  const safeTrades = useMemo(
    () => accountTrades.filter((t): t is Trade => Boolean(t)),
    [accountTrades]
  );

  const dayTrades = useMemo(
    () => safeTrades.filter(t => {
      const dateStr = t.trade_date || (t as unknown as { date?: string }).date;
      return dateStr === selectedDate;
    }),
    [safeTrades, selectedDate]
  );

  const ps: PreSessionData | null = useMemo(() => {
    const fromHistory = preSessionHistory[selectedDate];
    if (fromHistory) return fromHistory;
    // Fallback: use the active pre-session if its tz-aware date matches selectedDate
    if (isLivePreSession(activePreSession)) {
      const psDate = getTimeZoneParts(new Date(activePreSession.startedAt), preferences.timezone).date;
      if (psDate === selectedDate) return activePreSession;
    }
    return null;
  }, [preSessionHistory, selectedDate, activePreSession, preferences.timezone]);

  const bias = useMemo((): Record<string, string> => {
    if (!ps?.bias || typeof ps.bias !== 'object') return {};
    return ps.bias as Record<string, string>;
  }, [ps]);

  const checklistState = useMemo((): Record<string, boolean> => {
    if (!ps?.checklistState || typeof ps.checklistState !== 'object') return {};
    return ps.checklistState as Record<string, boolean>;
  }, [ps]);

  const netPnl = dayTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const wins = dayTrades.filter(t => Number(t.pnl ?? 0) > 0).length;
  const losses = dayTrades.filter(t => Number(t.pnl ?? 0) < 0).length;
  const winRate = dayTrades.length ? Math.round((wins / dayTrades.length) * 100) : 0;
  const dailyFlow = useMemo(
    () => buildDailyFlowInsight(safeTrades, selectedDate),
    [safeTrades, selectedDate]
  );

  const planAdherence = useMemo((): number | null => {
    // Prefer per-trade plan_score (severity-weighted + PnL modifier) when available
    const withScore = dayTrades.filter(t => typeof t.plan_score === 'number');
    if (withScore.length) {
      const total = withScore.reduce((s, t) => s + (t.plan_score as number), 0);
      return Math.round(total / withScore.length);
    }
    // Fallback: boolean count for trades that have no score data
    const withPlan = dayTrades.filter(t => typeof t.followed_plan === 'boolean');
    if (!withPlan.length) return null;
    return Math.round(withPlan.filter(t => t.followed_plan === true).length / withPlan.length * 100);
  }, [dayTrades]);

  const performanceOutcome = useMemo(() => summarizePerformanceOutcome(
    dayTrades,
    ps?.prescriptions ?? [],
    limitsFromPreSession(ps, { dailyLossLimit: ps?.sessionMaxLoss ?? 0 }),
    ps,
  ), [dayTrades, ps]);

  useEffect(() => {
    if (!ps || dayTrades.length === 0) return;
    const previous = ps.outcome;
    if (
      previous &&
      previous.adherencePct === performanceOutcome.adherencePct &&
      previous.violations.length === performanceOutcome.violations.length &&
      previous.netPnl === performanceOutcome.netPnl
    ) return;
    setPreSessionForDate(selectedDate, { ...ps, violations: performanceOutcome.violations, outcome: performanceOutcome });
  }, [dayTrades.length, performanceOutcome, ps, selectedDate, setPreSessionForDate]);

  const biasAdherence = useMemo(() => {
    if (!Object.keys(bias).length) return [];
    return Object.entries(bias)
      .filter(([, dir]) => dir !== 'Neutral')
      .map(([instrument, direction]) => {
        const instTrades = dayTrades.filter(t =>
          t.symbol?.toUpperCase().includes(instrument.toUpperCase())
        );
        let aligned = 0;
        instTrades.forEach(t => {
          const dir = (t.direction as string | undefined)?.toLowerCase();
          if (direction === 'Bull' && dir === 'long') aligned++;
          if (direction === 'Bear' && dir === 'short') aligned++;
        });
        return { instrument, direction, total: instTrades.length, aligned };
      });
  }, [bias, dayTrades]);

  const oathsChecked = useMemo(() => {
    const oathKeys = Object.keys(checklistState).filter(k => k.startsWith('oath-'));
    const checked = oathKeys.filter(k => checklistState[k]).length;
    return { checked, total: oathKeys.length };
  }, [checklistState]);

  // Reflection note — resync only when the selected date changes, never on
  // store updates: `ps` gets a new object reference every time this page's
  // outcome-sync effect writes to the store, and keying on it clobbered the
  // textarea mid-typing and cleared the Saved indicator right after saving.
  const [postNote, setPostNote] = useState(() => ps?.postSessionNote ?? '');
  const [noteSaved, setNoteSaved] = useState(false);
  useEffect(() => {
    setPostNote(preSessionHistory[selectedDate]?.postSessionNote ?? '');
    setNoteSaved(false);
  }, [selectedDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveNote = () => {
    const base: PreSessionData = ps ?? {
      emotion: '', note: '', bias: {}, checklistState: {}, startedAt: null,
    };
    setPreSessionForDate(selectedDate, { ...base, postSessionNote: postNote });
    void flushSupabaseStoreNow().catch(() => {});
    setNoteSaved(true);
  };

  // AI debrief — client-side rule-based observations
  const aiInsights = useMemo((): Insight[] => {
    if (!dayTrades.length) return [];
    const insights: Insight[] = [];
    const sessionMaxLoss = (ps as PreSessionData & { sessionMaxLoss?: number | null })?.sessionMaxLoss ?? null;
    const dailyTarget    = (ps as PreSessionData & { dailyTarget?: number | null })?.dailyTarget ?? null;

    // P&L vs target
    if (dailyTarget && dailyTarget > 0) {
      if (netPnl >= dailyTarget)
        insights.push({ type: 'good', text: `Profit target of ${fmtCurrency(dailyTarget)} was reached — session closed at ${fmtSigned(netPnl)}.` });
      else if (netPnl > 0)
        insights.push({ type: 'neutral', text: `Profitable but fell $${Math.round(dailyTarget - netPnl)} short of the ${fmtCurrency(dailyTarget)} target.` });
      else
        insights.push({ type: 'bad', text: `Target was ${fmtCurrency(dailyTarget)} but session ended at ${fmtSigned(netPnl)} — a ${fmtCurrency(Math.abs(dailyTarget - netPnl))} miss.` });
    }

    // Loss limit
    if (sessionMaxLoss && sessionMaxLoss > 0 && netPnl < 0) {
      const pct = Math.round((Math.abs(netPnl) / sessionMaxLoss) * 100);
      if (pct >= 100)
        insights.push({ type: 'bad', text: `Session max loss of ${fmtCurrency(sessionMaxLoss)} was breached — final loss ${fmtSigned(netPnl)}.` });
      else if (pct >= 80)
        insights.push({ type: 'warn', text: `Came close to the ${fmtCurrency(sessionMaxLoss)} loss limit — used ${pct}% of allowed risk.` });
    }

    // Plan adherence
    if (planAdherence !== null) {
      if (planAdherence === 100)
        insights.push({ type: 'good', text: 'Every trade followed the plan — clean, disciplined execution.' });
      else if (planAdherence >= 80)
        insights.push({ type: 'good', text: `${planAdherence}% plan adherence — minor deviations but execution was largely disciplined.` });
      else if (planAdherence >= 65)
        insights.push({ type: 'warn', text: `${planAdherence}% plan adherence — some behavioral flags or execution misses pulled the score down.` });
      else if (planAdherence >= 40)
        insights.push({ type: 'bad', text: `${planAdherence}% plan adherence — significant deviations from the plan detected.` });
      else
        insights.push({ type: 'bad', text: `${planAdherence}% plan adherence — trades showed major rule violations or repeated behavioral flags.` });
    }

    // Off-plan P&L vs on-plan
    const offPlanTrades = dayTrades.filter(t => t.followed_plan === false);
    const onPlanTrades  = dayTrades.filter(t => t.followed_plan === true);
    if (offPlanTrades.length > 0 && onPlanTrades.length > 0) {
      const offPnl = offPlanTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      const onPnl  = onPlanTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      if (offPnl < 0 && onPnl >= 0)
        insights.push({ type: 'bad', text: `On-plan trades: ${fmtSigned(onPnl)}. Off-plan trades: ${fmtSigned(offPnl)} — the deviations were the only losing trades.` });
      else if (offPnl < onPnl / Math.max(onPlanTrades.length, 1) * offPlanTrades.length)
        insights.push({ type: 'warn', text: `Off-plan trades underperformed planned trades — ${fmtSigned(onPnl)} vs ${fmtSigned(offPnl)}.` });
    }

    // Bias alignment
    biasAdherence.forEach(({ instrument, direction, total, aligned }) => {
      if (total === 0) return;
      const pct = Math.round((aligned / total) * 100);
      if (pct === 100)
        insights.push({ type: 'good', text: `All ${instrument} trades were ${direction}-aligned, matching the pre-session bias.` });
      else if (pct < 50)
        insights.push({ type: 'warn', text: `Pre-session bias was ${direction} on ${instrument} but only ${pct}% of trades were directionally aligned.` });
    });

    // Emotion vs outcome
    if (ps?.emotion) {
      const isTilt = /frustrated|anxious/i.test(ps.emotion);
      if (isTilt && netPnl < 0)
        insights.push({ type: 'warn', text: `Session started ${ps.emotion} and ended with a loss — ${ps.emotion.toLowerCase()} days may warrant reduced size or skipping altogether.` });
      else if (isTilt && netPnl > 0)
        insights.push({ type: 'good', text: `Despite starting ${ps.emotion.toLowerCase()}, the session was profitable — strong execution discipline.` });
    }

    // Pre-session readiness vs result
    if (ps?.readiness) {
      if (ps.readiness.status === 'Stand Down' && netPnl > 0)
        insights.push({ type: 'neutral', text: `Pre-session was Stand Down but the session was profitable — consider whether the rules still applied.` });
      else if (ps.readiness.status === 'Ready' && netPnl < 0)
        insights.push({ type: 'neutral', text: `High readiness score but still a losing session — review whether the plan held or external conditions changed.` });
    }

    // Session plan rule review
    if (ps?.sessionPlan) {
      const hardStop = ps.sessionPlan.find(r => r.source === 'Hard stop');
      if (hardStop && netPnl < 0)
        insights.push({ type: 'neutral', text: `Hard stop rule was: "${hardStop.rule}" — verify this was respected.` });
      const avoidRule = ps.sessionPlan.find(r => r.source === 'Avoid today');
      if (avoidRule)
        insights.push({ type: 'neutral', text: `Rule to avoid: "${avoidRule.rule}" — did the session stay clear of this pattern?` });
    }

    return insights;
  }, [ps, dayTrades, netPnl, planAdherence, biasAdherence]);

  const displayDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const reviewStatus = dayTrades.length === 0 ? 'No trades' : netPnl >= 0 ? 'Profitable' : 'Drawdown';
  const reviewColor = dayTrades.length === 0 ? C.t2 : netPnl >= 0 ? C.grn : C.red;

  if (loading) {
    return (
      <div
        className="animate-fade-in flex h-[calc(100vh-3.5rem)] items-center justify-center rounded-2xl"
        style={{ backgroundColor: C.d0 }}
      >
        <div className="text-[13px]" style={{ color: C.t1 }}>Loading...</div>
      </div>
    );
  }

  return (
    <div
      className="animate-fade-in"
      style={{ height: 'calc(100vh - 3.5rem)', backgroundColor: C.d0, color: C.t0, borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
    >
        <main className="flex h-full min-h-0 flex-col overflow-hidden" style={{ backgroundColor: C.d0 }}>
          <header style={{ padding: '10px 16px', borderBottom: `1px solid ${C.b0}`, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
              <div>
                <p style={{ fontSize: 10, color: C.t2, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 1 }}>
                  Session
                </p>
                <h1
                  style={{ fontSize: 14, fontWeight: 700, color: C.t0, letterSpacing: '-0.01em' }}
                >
                  Post-session review
                </h1>
                <p className="mt-1 text-[11px]" style={{ color: C.t2 }}>
                  {dayTrades.length > 0
                    ? `${dayTrades.length} trade${dayTrades.length !== 1 ? 's' : ''} · ${fmtSigned(netPnl)}`
                    : 'No trades logged'}
                  {ps ? ' · Pre-session recorded' : ' · No pre-session data'}
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                <div style={{ display: 'flex', borderRadius: 4, border: `1px solid ${C.b0}`, overflow: 'hidden' }}>
                  {([
                    { label: 'Pre-session',  to: '/pre-session'  },
                    { label: 'Post-session', to: '/post-session' },
                  ] as const).map(tab => (
                    <button
                      key={tab.to}
                      type="button"
                      onClick={() => navigate(tab.to)}
                      style={{
                        fontSize: 11,
                        fontWeight: tab.to === '/post-session' ? 600 : 400,
                        color: tab.to === '/post-session' ? C.t0 : C.t2,
                        backgroundColor: tab.to === '/post-session' ? C.d3 : 'transparent',
                        border: 'none', borderRight: tab.to === '/pre-session' ? `1px solid ${C.b0}` : 'none',
                        padding: '5px 12px', cursor: 'pointer',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <DatePicker
                  compact
                  value={selectedDate}
                  onChange={handleSelectedDateChange}
                  className="rounded-[4px] text-[11px]"
                  style={{
                    backgroundColor: C.d3, color: C.t0,
                    border: CARD_BORDER, outline: 'none',
                    fontFamily: C.mono,
                  }}
                />
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto" style={{ padding: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(300px, 0.75fr)', gap: 12, alignItems: 'start' }}>

              {/* ── LEFT COLUMN ─────────────────────────── */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

                {/* Stat strip */}
                <div style={{ display: 'flex', borderRadius: 8, border: `1px solid ${C.b0}`, backgroundColor: C.d1, overflow: 'hidden' }}>
                  {([
                    { label: 'DATE', value: displayDate, color: C.t0, wide: true },
                    { label: 'RESULT', value: reviewStatus, color: reviewColor },
                    { label: 'NET P&L', value: dayTrades.length ? fmtSigned(netPnl) : '--', color: reviewColor },
                    { label: 'TRADES', value: String(dayTrades.length), color: C.t0 },
                    { label: 'PLAN', value: planAdherence !== null ? `${planAdherence}%` : '--', color: planAdherence !== null ? adherenceColor(planAdherence) : C.t2 },
                    { label: 'LOOP', value: `${performanceOutcome.adherencePct}%`, color: adherenceColor(performanceOutcome.adherencePct) },
                  ] as { label: string; value: string; color: string; wide?: boolean }[]).map((stat, i) => (
                    <div key={stat.label} style={{ flex: stat.wide ? 1.6 : 1, padding: '9px 12px', borderLeft: i === 0 ? 'none' : `1px solid ${C.b0}`, minWidth: 0 }}>
                      <p style={{ fontSize: 9, fontWeight: 600, color: C.t2, letterSpacing: '0.07em', marginBottom: 4 }}>{stat.label}</p>
                      <p style={{ fontFamily: stat.wide ? 'inherit' : C.mono, fontSize: 13, fontWeight: 600, color: stat.color, fontVariantNumeric: 'tabular-nums', lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stat.value}</p>
                    </div>
                  ))}
                </div>

                {/* Carry-forward rule */}
                {dayTrades.length > 0 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    padding: '9px 14px', borderRadius: 8,
                    border: `1px solid ${dailyFlow.biggestLeak ? `${C.red}30` : `${C.grn}28`}`,
                    borderLeft: `3px solid ${dailyFlow.biggestLeak ? C.red : C.grn}`,
                    backgroundColor: dailyFlow.biggestLeak ? `${C.red}0a` : `${C.grn}08`,
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: 9, fontWeight: 700, color: dailyFlow.biggestLeak ? C.red : C.grn, letterSpacing: '0.09em', textTransform: 'uppercase', marginBottom: 3 }}>Carry-forward rule</p>
                      <p style={{ fontSize: 12, color: C.t0, fontWeight: 600, lineHeight: 1.4 }}>{dailyFlow.tomorrowRule}</p>
                    </div>
                    <span style={{ fontSize: 11, color: C.t2, flexShrink: 0 }}>{ps ? 'Plan compared' : 'No pre-session'}</span>
                  </div>
                )}

                {/* ── Pre-session plan card ── */}
                <div style={{ borderRadius: 8, border: CARD_BORDER, backgroundColor: C.d1, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ width: 3, height: 12, borderRadius: 2, background: C.acc, flexShrink: 0 }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t1 }}>Pre-session plan</span>
                    <span style={{ flex: 1 }} />
                    {ps?.emotion && (
                      <span style={{ fontSize: 10, fontWeight: 600, color: emotionColor(ps.emotion), padding: '2px 9px', borderRadius: 999, background: `${emotionColor(ps.emotion)}12`, border: `1px solid ${emotionColor(ps.emotion)}30` }}>
                        {ps.emotion}
                      </span>
                    )}
                    {ps?.readiness && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: readinessColor(ps.readiness.status), padding: '2px 9px', borderRadius: 999, background: `${readinessColor(ps.readiness.status)}12`, border: `1px solid ${readinessColor(ps.readiness.status)}30` }}>
                        {ps.readiness.status} · <span style={{ fontFamily: C.mono }}>{ps.readiness.score}</span>
                      </span>
                    )}
                    {ps && oathsChecked.total > 0 && (
                      <span style={{ fontSize: 10, fontWeight: 600, color: oathsChecked.checked === oathsChecked.total ? C.grn : C.amb, padding: '2px 9px', borderRadius: 999, background: `${oathsChecked.checked === oathsChecked.total ? C.grn : C.amb}12`, border: `1px solid ${oathsChecked.checked === oathsChecked.total ? C.grn : C.amb}30`, fontFamily: C.mono }}>
                        {oathsChecked.checked}/{oathsChecked.total} oaths
                      </span>
                    )}
                  </div>

                  {!ps ? (
                    <div style={{ padding: '12px 14px' }}>
                      <p style={{ fontSize: 12, color: C.t1 }}>No pre-session data recorded for this day.</p>
                      <p style={{ fontSize: 11, color: C.t2, marginTop: 3 }}>Use the pre-session brief before the market opens to capture your plan.</p>
                    </div>
                  ) : (
                    <>
                      {Object.keys(bias).length > 0 && (
                        <div style={{ padding: '9px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t2, marginRight: 2 }}>Bias</span>
                          {Object.entries(bias).map(([inst, dir]) => (
                            <span key={inst} style={{
                              fontSize: 10, fontWeight: 600, color: biasColor(String(dir)),
                              padding: '2px 9px', borderRadius: 4,
                              background: `${biasColor(String(dir))}14`, border: `1px solid ${biasColor(String(dir))}30`,
                            }}>
                              <span style={{ fontFamily: C.mono, color: C.t2, marginRight: 5 }}>{inst}</span>{String(dir)}
                            </span>
                          ))}
                        </div>
                      )}

                      {ps.sessionPlan && ps.sessionPlan.length > 0 && ps.sessionPlan.map((row, i) => (
                        <div key={row.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 14px', borderTop: i === 0 ? 'none' : `1px solid ${C.b0}` }}>
                          <span style={{
                            fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
                            color: row.source === 'Primary focus' ? C.grn : row.source === 'Avoid today' ? C.amb : C.red,
                            backgroundColor: row.source === 'Primary focus' ? `${C.grn}12` : row.source === 'Avoid today' ? `${C.amb}12` : `${C.red}12`,
                            border: `1px solid ${row.source === 'Primary focus' ? C.grn : row.source === 'Avoid today' ? C.amb : C.red}30`,
                            padding: '2px 7px', borderRadius: 3, flexShrink: 0, marginTop: 1, whiteSpace: 'nowrap',
                          }}>
                            {row.source}
                          </span>
                          <span style={{ fontSize: 12, color: C.t0, lineHeight: 1.5 }}>{row.rule}</span>
                        </div>
                      ))}

                      {ps.note?.trim() && (
                        <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.b0}`, background: `${C.acc}05`, fontSize: 12, color: C.t1, lineHeight: 1.6, fontStyle: 'italic' }}>
                          "{ps.note.trim()}"
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* ── Performance loop ── */}
                {dayTrades.length > 0 && ps?.prescriptions && ps.prescriptions.length > 0 && (
                  <div style={{ borderRadius: 8, border: CARD_BORDER, backgroundColor: C.d1, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 3, height: 12, borderRadius: 2, background: adherenceColor(performanceOutcome.adherencePct), flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t1 }}>Performance loop</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
                      {[
                        { label: 'Rules followed', value: `${performanceOutcome.rulesFollowed}/${performanceOutcome.totalRules}`, color: adherenceColor(performanceOutcome.adherencePct) },
                        { label: 'Violations', value: String(performanceOutcome.violations.length), color: performanceOutcome.violations.length ? C.red : C.grn },
                        { label: 'Estimated cost', value: fmtCurrency(performanceOutcome.estimatedCost), color: performanceOutcome.estimatedCost > 0 ? C.red : C.grn },
                      ].map((item, index) => (
                        <div key={item.label} style={{ padding: '11px 14px', borderLeft: index ? `1px solid ${C.b0}` : 'none' }}>
                          <p style={{ fontSize: 9, fontWeight: 600, color: C.t2, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 5 }}>{item.label}</p>
                          <p style={{ color: item.color, fontFamily: C.mono, fontSize: 15, fontWeight: 700 }}>{item.value}</p>
                        </div>
                      ))}
                    </div>
                    {performanceOutcome.violations.slice(0, 3).map(item => (
                      <div key={item.id} style={{ padding: '9px 14px', borderTop: `1px solid ${C.b0}`, display: 'flex', gap: 10 }}>
                        <span style={{ color: item.severity === 'critical' ? C.red : C.amb, fontSize: 9, fontWeight: 700, minWidth: 52, textTransform: 'uppercase', paddingTop: 1 }}>{item.severity}</span>
                        <p style={{ margin: 0, color: C.t1, fontSize: 11, lineHeight: 1.45 }}>{item.evidence}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── Actual execution card ── */}
                <div style={{ borderRadius: 8, border: CARD_BORDER, backgroundColor: C.d1, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ width: 3, height: 12, borderRadius: 2, background: dayTrades.length === 0 ? C.t2 : netPnl >= 0 ? C.grn : C.red, flexShrink: 0 }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t1 }}>Actual execution</span>
                    <span style={{ flex: 1 }} />
                    {dayTrades.length > 0 && (
                      <>
                        <span style={{ fontSize: 12, fontWeight: 700, fontFamily: C.mono, color: netPnl >= 0 ? C.grn : C.red }}>{fmtSigned(netPnl)}</span>
                        <span style={{ fontSize: 10, color: C.t2 }}>·</span>
                        <span style={{ fontSize: 11, fontFamily: C.mono, color: winRate >= 50 ? C.grn : C.red, fontWeight: 600 }}>{winRate}%</span>
                        <span style={{ fontSize: 10, color: C.t2 }}>{wins}W / {losses}L</span>
                        {planAdherence !== null && (
                          <>
                            <span style={{ fontSize: 10, color: C.t2 }}>·</span>
                            <span style={{ fontSize: 11, fontFamily: C.mono, color: adherenceColor(planAdherence), fontWeight: 600 }}>{planAdherence}% plan</span>
                          </>
                        )}
                      </>
                    )}
                  </div>

                  {dayTrades.length === 0 ? (
                    <div style={{ padding: '12px 14px' }}>
                      <p style={{ fontSize: 12, color: C.t1 }}>No trades logged for this day.</p>
                      <p style={{ fontSize: 11, color: C.t2, marginTop: 3 }}>Trades from the Journal will appear here once logged.</p>
                    </div>
                  ) : (
                    <>
                      {biasAdherence.length > 0 && (
                        <div style={{ padding: '9px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t2 }}>Bias adherence</span>
                          {biasAdherence.map(({ instrument, direction, total, aligned }) => {
                            const pct = total > 0 ? Math.round((aligned / total) * 100) : null;
                            return (
                              <span key={instrument} style={{ fontSize: 11, color: C.t1 }}>
                                <span style={{ fontFamily: C.mono }}>{instrument}</span>{' '}
                                <span style={{ color: biasColor(direction) }}>{direction}</span>
                                {pct !== null
                                  ? <> → <span style={{ color: adherenceColor(pct), fontFamily: C.mono, fontWeight: 600 }}>{pct}% aligned</span> <span style={{ color: C.t2 }}>({total})</span></>
                                  : <span style={{ color: C.t2 }}> — no trades</span>}
                              </span>
                            );
                          })}
                        </div>
                      )}

                      {dayTrades.map((t, idx) => {
                        const pnl = Number(t.pnl ?? 0);
                        const dir = (t.direction as string | undefined)?.toLowerCase();
                        return (
                          <div
                            key={t.id}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              padding: '9px 14px',
                              borderTop: idx > 0 || biasAdherence.length > 0 ? `1px solid ${C.b0}` : 'none',
                              cursor: 'pointer', transition: 'background 0.1s',
                            }}
                            onClick={() => {
                              const date = t.trade_date || selectedDate;
                              navigate(`/scanner?date=${encodeURIComponent(date)}&tradeId=${encodeURIComponent(t.id)}`);
                            }}
                            onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.03)')}
                            onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: C.t0 }}>{t.symbol}</span>
                              <span style={{
                                fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                                color: dir === 'long' ? C.grn : C.red,
                                backgroundColor: dir === 'long' ? `${C.grn}14` : `${C.red}14`,
                                border: `1px solid ${dir === 'long' ? C.grn : C.red}28`,
                                padding: '2px 6px', borderRadius: 3,
                              }}>
                                {t.direction}
                              </span>
                              {typeof t.followed_plan === 'boolean' && (
                                <span style={{ fontSize: 10, color: t.followed_plan ? C.grn : C.red }}>
                                  {t.followed_plan ? '✓ plan' : '✗ off-plan'}
                                </span>
                              )}
                              {t.trade_time && (
                                <span style={{ fontSize: 10, color: C.t2, fontFamily: C.mono }}>{t.trade_time}</span>
                              )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: pnl >= 0 ? C.grn : C.red, fontFamily: C.mono }}>
                                {fmtSigned(pnl)}
                              </span>
                              <span title="View trade" style={{ color: C.t2, lineHeight: 0 }}>
                                <Eye size={13} />
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </div>

              {/* ── RIGHT RAIL ──────────────────────────── */}
              <aside style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'sticky', top: 0 }}>

                {/* Your reflection */}
                <div style={{ borderRadius: 8, border: CARD_BORDER, backgroundColor: C.d1, overflow: 'hidden' }}>
                  <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 3, height: 12, borderRadius: 2, background: C.acc, flexShrink: 0 }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t1 }}>Your reflection</span>
                    <span style={{ flex: 1 }} />
                    {noteSaved && <span style={{ fontSize: 10, color: C.grn, fontWeight: 600 }}>Saved</span>}
                  </div>
                  <div style={{ padding: '12px 14px' }}>
                    {riskRules.filter(r => r.enabled !== false).length > 0 && (
                      <div style={{ marginBottom: 10 }}>
                        <p style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t2, marginBottom: 5 }}>Your rules</p>
                        {riskRules.filter(r => r.enabled !== false).slice(0, 4).map(rule => (
                          <p key={rule.id} style={{ fontSize: 11, lineHeight: 1.55, color: C.t2 }}>
                            <span style={{ color: rule.color === 'red' ? C.red : rule.color === 'green' ? C.grn : C.amb, fontWeight: 600 }}>– </span>
                            {rule.label}{rule.value ? `: ${rule.value}${rule.unit ? ' ' + rule.unit : ''}` : ''}
                          </p>
                        ))}
                      </div>
                    )}
                    <textarea
                      value={postNote}
                      onChange={e => { setPostNote(e.target.value); setNoteSaved(false); }}
                      placeholder="How close was the actual session to what you planned? What matched, what deviated, and what's the one thing to carry forward?"
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        minHeight: 110, resize: 'vertical',
                        background: C.d3, border: `1px solid ${C.b0}`,
                        borderRadius: 6, color: C.t0, fontSize: 12.5,
                        lineHeight: 1.65, padding: '10px 12px',
                        outline: 'none', fontFamily: 'inherit',
                      }}
                    />
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        onClick={saveNote}
                        disabled={!postNote.trim()}
                        style={{
                          height: 30, padding: '0 14px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                          border: `1px solid ${C.acc}44`,
                          background: postNote.trim() ? `${C.acc}12` : 'transparent',
                          color: postNote.trim() ? C.acc : C.t2,
                          cursor: postNote.trim() ? 'pointer' : 'default',
                        }}
                      >
                        Save reflection
                      </button>
                    </div>
                  </div>
                </div>

                {/* AI debrief */}
                {dayTrades.length > 0 && (
                  <div style={{ borderRadius: 8, border: CARD_BORDER, backgroundColor: C.d1, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 3, height: 12, borderRadius: 2, background: C.grn, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t1 }}>AI debrief</span>
                    </div>
                    {aiInsights.length === 0 ? (
                      <div style={{ padding: '12px 14px' }}>
                        <p style={{ fontSize: 12, color: C.t2, lineHeight: 1.5 }}>
                          Not enough data to generate observations — tag trades with plan adherence to unlock deeper analysis.
                        </p>
                      </div>
                    ) : (
                      aiInsights.map((insight, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', borderTop: i === 0 ? 'none' : `1px solid ${C.b0}` }}>
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%',
                            backgroundColor: insightDot(insight.type),
                            flexShrink: 0, marginTop: 5,
                          }} />
                          <p style={{ fontSize: 12, lineHeight: 1.55, color: insightColor(insight.type), margin: 0 }}>
                            {insight.text}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Debrief summary */}
                {ps && dayTrades.length > 0 && (
                  <div style={{ borderRadius: 8, border: CARD_BORDER, backgroundColor: C.d1, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.b0}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 3, height: 12, borderRadius: 2, background: C.t2, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: C.t1 }}>Debrief summary</span>
                    </div>
                    <div style={{ padding: '4px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 14px' }}>
                        <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.09em', color: C.t2, fontFamily: C.mono, minWidth: 72, flexShrink: 0 }}>Emotion</span>
                        <span style={{ fontSize: 12, lineHeight: 1.5, color: C.t1 }}>
                          <span style={{ color: emotionColor(ps.emotion), fontWeight: 600 }}>{ps.emotion || 'Not set'}</span>
                          {' → '}
                          <span style={{ color: netPnl >= 0 ? C.grn : C.red }}>{netPnl >= 0 ? 'Profitable' : 'Unprofitable'} ({fmtSigned(netPnl)})</span>
                        </span>
                      </div>
                      {ps.readiness && (
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 14px' }}>
                          <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.09em', color: C.t2, fontFamily: C.mono, minWidth: 72, flexShrink: 0 }}>Readiness</span>
                          <span style={{ fontSize: 12, lineHeight: 1.5, color: C.t1 }}>
                            <span style={{ color: readinessColor(ps.readiness.status), fontWeight: 600 }}>{ps.readiness.status} ({ps.readiness.score}/100)</span>
                            {' → '}{winRate}% win rate across {dayTrades.length} trade{dayTrades.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      )}
                      {planAdherence !== null && ps.sessionPlan && ps.sessionPlan.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 14px' }}>
                          <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.09em', color: C.t2, fontFamily: C.mono, minWidth: 72, flexShrink: 0 }}>Plan</span>
                          <span style={{ fontSize: 12, lineHeight: 1.5, color: C.t1 }}>
                            {ps.sessionPlan.length} rule{ps.sessionPlan.length !== 1 ? 's' : ''} defined
                            {' → '}
                            <span style={{ color: adherenceColor(planAdherence), fontWeight: 600 }}>{planAdherence}% adherence</span>
                          </span>
                        </div>
                      )}
                      {biasAdherence.length > 0 && (
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 14px' }}>
                          <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.09em', color: C.t2, fontFamily: C.mono, minWidth: 72, flexShrink: 0 }}>Bias</span>
                          <span style={{ fontSize: 12, lineHeight: 1.5, color: C.t1 }}>
                            {biasAdherence.map(({ instrument, direction, total, aligned }, i) => {
                              const pct = total > 0 ? Math.round((aligned / total) * 100) : null;
                              return (
                                <span key={instrument}>
                                  {i > 0 && ' · '}
                                  {instrument} <span style={{ color: biasColor(direction) }}>{direction}</span>
                                  {pct !== null && <> → <span style={{ color: adherenceColor(pct) }}>{pct}%</span></>}
                                </span>
                              );
                            })}
                          </span>
                        </div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 14px' }}>
                        <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.09em', color: C.t2, fontFamily: C.mono, minWidth: 72, flexShrink: 0 }}>Next rule</span>
                        <span style={{ fontSize: 12, lineHeight: 1.5, color: C.t0 }}>{dailyFlow.tomorrowRule}</span>
                      </div>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </div>
        </main>
    </div>
  );
}
