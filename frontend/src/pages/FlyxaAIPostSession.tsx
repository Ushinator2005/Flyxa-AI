import { CSSProperties, useEffect, useMemo, useState } from 'react';
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

const C = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252', amb: '#f59e0b',
  mono: "'DM Mono', ui-monospace, monospace",
};

const CARD_BORDER = `1px solid ${C.b0}`;
const SECTION_LABEL: CSSProperties = {
  fontSize: 11, fontWeight: 500, color: C.t2,
};

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
    if (activePreSession?.startedAt) {
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

  // Reflection note — synced when date or ps changes
  const [postNote, setPostNote] = useState(() => ps?.postSessionNote ?? '');
  const [noteSaved, setNoteSaved] = useState(false);
  useEffect(() => { setPostNote(ps?.postSessionNote ?? ''); setNoteSaved(false); }, [ps]);

  const saveNote = () => {
    const base: PreSessionData = ps ?? {
      emotion: '', note: '', bias: {}, checklistState: {}, startedAt: null,
    };
    setPreSessionForDate(selectedDate, { ...base, postSessionNote: postNote });
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
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(280px, 0.7fr)', gap: 10, alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', borderRadius: 6, border: `1px solid ${C.b0}`, backgroundColor: C.d1, overflow: 'hidden' }}>
                  {([
                    { label: 'DATE', value: displayDate, color: C.t0, wide: true },
                    { label: 'RESULT', value: reviewStatus, color: reviewColor },
                    { label: 'NET P&L', value: dayTrades.length ? fmtSigned(netPnl) : '--', color: reviewColor },
                    { label: 'TRADES', value: String(dayTrades.length), color: C.t0 },
                    { label: 'PLAN', value: planAdherence !== null ? `${planAdherence}%` : '--', color: planAdherence !== null ? adherenceColor(planAdherence) : C.t2 },
                  ] as { label: string; value: string; color: string; wide?: boolean }[]).map((stat, i) => (
                    <div key={stat.label} style={{ flex: stat.wide ? 1.6 : 1, padding: '9px 12px', borderLeft: i === 0 ? 'none' : `1px solid ${C.b0}`, minWidth: 0 }}>
                      <p style={{ fontSize: 9, fontWeight: 600, color: C.t2, letterSpacing: '0.07em', marginBottom: 4 }}>{stat.label}</p>
                      <p style={{ fontFamily: stat.wide ? 'inherit' : C.mono, fontSize: 13, fontWeight: 600, color: stat.color, fontVariantNumeric: 'tabular-nums', lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stat.value}</p>
                    </div>
                  ))}
                </div>

                {dayTrades.length > 0 && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                    padding: '8px 12px', borderRadius: 4,
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

            {/* PRE-SESSION PLAN */}
            <div className="flex flex-col gap-2">
              <p style={SECTION_LABEL}>Pre-session plan</p>

              {!ps ? (
                <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                  <p className="text-[13px]" style={{ color: C.t2 }}>
                    No pre-session data recorded for this day.
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: C.t2 }}>
                    Use the pre-session brief before the market opens to capture your plan.
                  </p>
                </div>
              ) : (
                <>
                  {/* Emotion + readiness */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Emotion</p>
                      <p
                        className="mt-2 text-[18px] font-semibold"
                        style={{ color: emotionColor(ps.emotion) }}
                      >
                        {ps.emotion || 'Not set'}
                      </p>
                    </div>
                    {ps.readiness && (
                      <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                        <p style={SECTION_LABEL}>Readiness</p>
                        <p
                          className="mt-2 text-[18px] font-semibold"
                          style={{ color: readinessColor(ps.readiness.status) }}
                        >
                          {ps.readiness.status}
                        </p>
                        <p className="mt-0.5 text-[11px]" style={{ color: C.t2, fontFamily: C.mono }}>
                          {ps.readiness.score}/100
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Bias */}
                  {Object.keys(bias).length > 0 && (
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Market bias</p>
                      <div className="mt-3 flex flex-wrap gap-4">
                        {Object.entries(bias).map(([inst, dir]) => (
                          <div key={inst} className="flex items-center gap-2">
                            <span
                              className="text-[11px]"
                              style={{ color: C.t2, fontFamily: C.mono }}
                            >
                              {inst}
                            </span>
                            <span
                              className="rounded-[4px] px-2 py-[2px] text-[10.5px] font-medium"
                              style={{
                                color: biasColor(String(dir)),
                                backgroundColor: `${biasColor(String(dir))}18`,
                                border: `1px solid ${biasColor(String(dir))}35`,
                              }}
                            >
                              {String(dir)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Session plan */}
                  {ps.sessionPlan && ps.sessionPlan.length > 0 && (
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Session plan ({ps.sessionPlan.length} rules)</p>
                      <div className="mt-3 space-y-2">
                        {ps.sessionPlan.map(row => (
                          <div key={row.id} className="flex items-start gap-2">
                            <span
                              className="mt-[1px] shrink-0 rounded-[3px] px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-[0.08em]"
                              style={{
                                color: row.source === 'Primary focus'
                                  ? C.grn
                                  : row.source === 'Avoid today'
                                    ? C.amb
                                    : C.red,
                                backgroundColor: row.source === 'Primary focus'
                                  ? `${C.grn}15`
                                  : row.source === 'Avoid today'
                                    ? `${C.amb}15`
                                    : `${C.red}15`,
                              }}
                            >
                              {row.source}
                            </span>
                            <span className="text-[12px]" style={{ color: C.t0 }}>{row.rule}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Oaths */}
                  {oathsChecked.total > 0 && (
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Commitment</p>
                      <div className="mt-2 flex items-center gap-2">
                        <span
                          className="text-[20px] font-bold"
                          style={{
                            color: oathsChecked.checked === oathsChecked.total ? C.grn : C.amb,
                            fontFamily: C.mono,
                          }}
                        >
                          {oathsChecked.checked}/{oathsChecked.total}
                        </span>
                        <span className="text-[12px]" style={{ color: C.t1 }}>oaths committed before session</span>
                      </div>
                    </div>
                  )}

                  {/* Pre-session note */}
                  {ps.note?.trim() && (
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Pre-session note</p>
                      <p
                        className="mt-2 text-[12.5px] leading-relaxed"
                        style={{ color: C.t1 }}
                      >
                        {ps.note}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* ACTUAL EXECUTION */}
            <div className="flex flex-col gap-2">
              <p style={SECTION_LABEL}>Actual execution</p>

              {dayTrades.length === 0 ? (
                <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                  <p className="text-[13px]" style={{ color: C.t2 }}>
                    No trades logged for this day.
                  </p>
                  <p className="mt-1 text-[11px]" style={{ color: C.t2 }}>
                    Trades from the Journal will appear here once logged.
                  </p>
                </div>
              ) : (
                <>
                  {/* P&L summary */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Net P&L</p>
                      <p
                        className="mt-2 text-[20px] font-bold"
                        style={{ color: netPnl >= 0 ? C.grn : C.red, fontFamily: C.mono }}
                      >
                        {fmtSigned(netPnl)}
                      </p>
                    </div>
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Win rate</p>
                      <p
                        className="mt-2 text-[20px] font-bold"
                        style={{ color: winRate >= 50 ? C.grn : C.red, fontFamily: C.mono }}
                      >
                        {winRate}%
                      </p>
                      <p className="mt-0.5 text-[10.5px]" style={{ color: C.t2 }}>
                        {wins}W / {losses}L
                      </p>
                    </div>
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Plan adherence</p>
                      {planAdherence !== null ? (
                        <p
                          className="mt-2 text-[20px] font-bold"
                          style={{ color: adherenceColor(planAdherence), fontFamily: C.mono }}
                        >
                          {planAdherence}%
                        </p>
                      ) : (
                        <p className="mt-2 text-[13px]" style={{ color: C.t2 }}>—</p>
                      )}
                    </div>
                  </div>

                  {/* Bias adherence */}
                  {biasAdherence.length > 0 && (
                    <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                      <p style={SECTION_LABEL}>Bias adherence</p>
                      <div className="mt-3 space-y-3">
                        {biasAdherence.map(({ instrument, direction, total, aligned }) => {
                          const pct = total > 0 ? Math.round((aligned / total) * 100) : null;
                          return (
                            <div key={instrument} className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span
                                  className="text-[11px] font-medium"
                                  style={{ color: C.t1, fontFamily: C.mono }}
                                >
                                  {instrument}
                                </span>
                                <span
                                  className="rounded-[3px] px-1.5 py-[1px] text-[10px]"
                                  style={{
                                    color: biasColor(direction),
                                    backgroundColor: `${biasColor(direction)}15`,
                                    border: `1px solid ${biasColor(direction)}30`,
                                  }}
                                >
                                  {direction}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="text-[11px]" style={{ color: C.t2 }}>
                                  {total} trade{total !== 1 ? 's' : ''}
                                </span>
                                {pct !== null ? (
                                  <span
                                    className="text-[12px] font-semibold"
                                    style={{ color: adherenceColor(pct), fontFamily: C.mono }}
                                  >
                                    {pct}% aligned
                                  </span>
                                ) : (
                                  <span className="text-[11px]" style={{ color: C.t2 }}>no trades</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Trades list */}
                  <div className="rounded-[8px] overflow-hidden" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                    <div className="border-b px-4 py-3" style={{ borderColor: C.b0 }}>
                      <p style={SECTION_LABEL}>Trades ({dayTrades.length})</p>
                    </div>
                    {dayTrades.map((t, idx) => {
                      const pnl = Number(t.pnl ?? 0);
                      const dir = (t.direction as string | undefined)?.toLowerCase();
                      return (
                        <div
                          key={t.id}
                          className="flex items-center justify-between px-4 py-3 transition-colors"
                          style={{
                            borderTop: idx > 0 ? `1px solid ${C.b0}` : 'none',
                            cursor: 'pointer',
                          }}
                          onClick={() => {
                            const date = t.trade_date || selectedDate;
                            navigate(`/scanner?date=${encodeURIComponent(date)}&tradeId=${encodeURIComponent(t.id)}`);
                          }}
                          onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.03)')}
                          onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-[12px] font-medium" style={{ color: C.t0 }}>
                              {t.symbol}
                            </span>
                            <span
                              className="rounded-[3px] px-1.5 py-[1px] text-[10px] font-medium uppercase"
                              style={{
                                color: dir === 'long' ? C.grn : C.red,
                                backgroundColor: dir === 'long' ? `${C.grn}15` : `${C.red}15`,
                              }}
                            >
                              {t.direction}
                            </span>
                            {typeof t.followed_plan === 'boolean' && (
                              <span
                                className="text-[10px]"
                                style={{ color: t.followed_plan ? C.grn : C.red }}
                              >
                                {t.followed_plan ? '✓ plan' : '✗ off-plan'}
                              </span>
                            )}
                            {t.trade_time && (
                              <span className="text-[10px]" style={{ color: C.t2, fontFamily: C.mono }}>
                                {t.trade_time}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className="text-[12px] font-semibold"
                              style={{ color: pnl >= 0 ? C.grn : C.red, fontFamily: C.mono }}
                            >
                              {fmtSigned(pnl)}
                            </span>
                            <span
                              title="View trade"
                              className="inline-flex items-center"
                              style={{ color: C.t2, lineHeight: 0 }}
                            >
                              <Eye size={13} />
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* AI Debrief — always shown if there are trades */}
          <aside style={{ display: 'flex', flexDirection: 'column', gap: 8, position: 'sticky', top: 0 }}>
          {dayTrades.length > 0 && (
            <div className="flex flex-col gap-2">
              <p style={SECTION_LABEL}>AI debrief</p>
              <div className="mt-3 rounded-[8px] overflow-hidden" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
                {aiInsights.length === 0 ? (
                  <div className="p-5">
                    <p className="text-[12.5px]" style={{ color: C.t2 }}>
                      Not enough data to generate observations — tag trades with plan adherence to unlock deeper analysis.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y" style={{ borderColor: C.b0 }}>
                    {aiInsights.map((insight, i) => (
                      <div key={i} className="flex items-start gap-3 px-5 py-3.5"
                        style={{ backgroundColor: i % 2 === 0 ? 'transparent' : `${C.d1}` }}>
                        <span style={{
                          width: 6, height: 6, borderRadius: '50%',
                          backgroundColor: insightDot(insight.type),
                          flexShrink: 0, marginTop: 6,
                        }} />
                        <p className="text-[12.5px] leading-relaxed" style={{ color: insightColor(insight.type) }}>
                          {insight.text}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* User reflection */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between mb-3">
              <p style={SECTION_LABEL}>Your reflection</p>
              {ps?.postSessionNote && !noteSaved && (
                <span className="text-[10px]" style={{ color: C.t2 }}>saved</span>
              )}
            </div>
            <div className="rounded-[8px] p-4" style={{ border: CARD_BORDER, backgroundColor: C.d2 }}>
              {ps?.sessionPlan && ps.sessionPlan.length > 0 && (
                <div className="mb-3 space-y-1">
                  <p className="text-[10px] uppercase tracking-[0.1em]" style={{ color: C.t2 }}>Pre-session rules to compare against</p>
                  {ps.sessionPlan.slice(0, 3).map(row => (
                    <p key={row.id} className="text-[11px] leading-relaxed" style={{ color: C.t2 }}>
                      <span style={{
                        color: row.source === 'Primary focus' ? C.grn : row.source === 'Avoid today' ? C.amb : C.red,
                        fontWeight: 600,
                      }}>{row.source}: </span>
                      {row.rule}
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
              <div className="mt-3 flex items-center justify-between">
                <p className="text-[11px]" style={{ color: C.t2 }}>
                  {noteSaved ? (
                    <span style={{ color: C.grn }}>Saved</span>
                  ) : postNote.trim() ? 'Unsaved changes' : 'Write your post-session reflection above'}
                </p>
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

          {/* Comparison summary — only shown when both sides have data */}
          {ps && dayTrades.length > 0 && (
            <div className="flex flex-col gap-2">
              <p style={SECTION_LABEL}>Debrief summary</p>
              <div
                className="mt-3 rounded-[8px] p-5"
                style={{ border: CARD_BORDER, backgroundColor: C.d2 }}
              >
                <div className="space-y-4">
                  {/* Emotion vs outcome */}
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-[2px] shrink-0 text-[9.5px] uppercase tracking-[0.1em]"
                      style={{ color: C.t2, fontFamily: C.mono, minWidth: 100 }}
                    >
                      Emotion
                    </span>
                    <span
                      className="text-[12.5px] font-medium"
                      style={{ color: emotionColor(ps.emotion) }}
                    >
                      {ps.emotion || 'Not set'}
                    </span>
                    <span className="text-[12px]" style={{ color: C.t2 }}>→</span>
                    <span className="text-[12.5px]" style={{ color: netPnl >= 0 ? C.grn : C.red }}>
                      {netPnl >= 0 ? 'Profitable' : 'Unprofitable'} session ({fmtSigned(netPnl)})
                    </span>
                  </div>

                  {/* Readiness vs execution */}
                  {ps.readiness && (
                    <div className="flex items-start gap-3">
                      <span
                        className="mt-[2px] shrink-0 text-[9.5px] uppercase tracking-[0.1em]"
                        style={{ color: C.t2, fontFamily: C.mono, minWidth: 100 }}
                      >
                        Readiness
                      </span>
                      <span
                        className="text-[12.5px] font-medium"
                        style={{ color: readinessColor(ps.readiness.status) }}
                      >
                        {ps.readiness.status} ({ps.readiness.score}/100)
                      </span>
                      <span className="text-[12px]" style={{ color: C.t2 }}>→</span>
                      <span className="text-[12.5px]" style={{ color: C.t1 }}>
                        {winRate}% win rate across {dayTrades.length} trade{dayTrades.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  )}

                  {/* Plan adherence */}
                  {planAdherence !== null && ps.sessionPlan && ps.sessionPlan.length > 0 && (
                    <div className="flex items-start gap-3">
                      <span
                        className="mt-[2px] shrink-0 text-[9.5px] uppercase tracking-[0.1em]"
                        style={{ color: C.t2, fontFamily: C.mono, minWidth: 100 }}
                      >
                        Plan
                      </span>
                      <span className="text-[12.5px]" style={{ color: C.t1 }}>
                        {ps.sessionPlan.length} rule{ps.sessionPlan.length !== 1 ? 's' : ''} defined
                      </span>
                      <span className="text-[12px]" style={{ color: C.t2 }}>→</span>
                      <span
                        className="text-[12.5px] font-medium"
                        style={{ color: adherenceColor(planAdherence) }}
                      >
                        {planAdherence}% plan adherence
                      </span>
                    </div>
                  )}

                  {/* Bias adherence summary */}
                  {biasAdherence.length > 0 && (
                    <div className="flex items-start gap-3">
                      <span
                        className="mt-[2px] shrink-0 text-[9.5px] uppercase tracking-[0.1em]"
                        style={{ color: C.t2, fontFamily: C.mono, minWidth: 100 }}
                      >
                        Bias
                      </span>
                      <div className="flex flex-wrap gap-3">
                        {biasAdherence.map(({ instrument, direction, total, aligned }) => {
                          const pct = total > 0 ? Math.round((aligned / total) * 100) : null;
                          return (
                            <span key={instrument} className="text-[12px]" style={{ color: C.t1 }}>
                              {instrument}{' '}
                              <span style={{ color: biasColor(direction) }}>{direction}</span>
                              {pct !== null && (
                                <>
                                  {' → '}
                                  <span style={{ color: adherenceColor(pct) }}>{pct}% aligned</span>
                                </>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="flex items-start gap-3">
                    <span
                      className="mt-[2px] shrink-0 text-[9.5px] uppercase tracking-[0.1em]"
                      style={{ color: C.t2, fontFamily: C.mono, minWidth: 100 }}
                    >
                      Next rule
                    </span>
                    <span className="text-[12.5px]" style={{ color: C.t0 }}>
                      {dailyFlow.tomorrowRule}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}
          </aside>
            </div>
          </div>{/* end scroll wrapper */}
        </main>
    </div>
  );
}
