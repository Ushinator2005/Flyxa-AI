import { CSSProperties, useMemo, useState } from 'react';
import FlyxaNav from '../components/flyxa/FlyxaNav.js';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';
import useFlyxaStore from '../store/flyxaStore.js';
import type { PreSessionData } from '../store/types.js';
import { buildDailyFlowInsight } from '../utils/dailyFlow.js';
import DatePicker from '../components/common/DatePicker.js';

const C = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252', amb: '#f59e0b',
  mono: "'DM Mono', ui-monospace, monospace",
};

const CARD_BORDER = `1px solid ${C.b0}`;
const SECTION_LABEL: CSSProperties = {
  fontSize: 9.5, fontWeight: 500, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: C.t2,
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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

export default function FlyxaAIPostSession() {
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);

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

  const ps: PreSessionData | null = preSessionHistory[selectedDate] ?? null;

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
    const withPlan = dayTrades.filter(t => typeof t.followed_plan === 'boolean');
    if (!withPlan.length) return null;
    const followed = withPlan.filter(t => t.followed_plan === true).length;
    return Math.round((followed / withPlan.length) * 100);
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

  const displayDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

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
      className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl"
      style={{ backgroundColor: C.d0, color: C.t0 }}
    >
      <div className="grid h-full grid-cols-[178px_minmax(0,1fr)] overflow-hidden">
        <FlyxaNav />

        <main className="min-h-0 overflow-y-auto" style={{ backgroundColor: C.d0 }}>
          {/* Header */}
          <section className="border-b px-6 py-5" style={{ borderColor: C.b0 }}>
            <div className="flex items-end justify-between gap-4">
              <div>
                <p style={SECTION_LABEL}>Post-session debrief</p>
                <h1
                  className="mt-2 text-[22px] font-bold tracking-[-0.02em]"
                  style={{ color: C.t0 }}
                >
                  {displayDate}
                </h1>
                <p className="mt-1 text-[12px]" style={{ color: C.t2 }}>
                  {dayTrades.length > 0
                    ? `${dayTrades.length} trade${dayTrades.length !== 1 ? 's' : ''} · ${fmtSigned(netPnl)}`
                    : 'No trades logged'}
                  {ps ? ' · Pre-session recorded' : ' · No pre-session data'}
                </p>
              </div>
              <DatePicker
                value={selectedDate}
                onChange={setSelectedDate}
                className="rounded-[6px] px-3 py-2 text-[12px]"
                style={{
                  backgroundColor: C.d3, color: C.t0,
                  border: CARD_BORDER, outline: 'none',
                  fontFamily: C.mono,
                }}
              />
            </div>
          </section>

          <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-2">
            {/* PRE-SESSION PLAN */}
            <div className="flex flex-col gap-4">
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
            <div className="flex flex-col gap-4">
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
                  <div className="rounded-[8px] p-4" style={{ border: `1px solid ${dailyFlow.biggestLeak ? `${C.red}55` : `${C.grn}44`}`, backgroundColor: dailyFlow.biggestLeak ? 'rgba(239,68,68,0.075)' : 'rgba(34,197,94,0.065)' }}>
                    <p style={{ ...SECTION_LABEL, color: dailyFlow.biggestLeak ? C.red : C.grn }}>Tomorrow&apos;s rule</p>
                    <p className="mt-2 text-[15px] font-bold leading-snug" style={{ color: C.t0 }}>
                      {dailyFlow.tomorrowRule}
                    </p>
                    <p className="mt-2 text-[12px] leading-relaxed" style={{ color: C.t1 }}>
                      {dailyFlow.summary}
                      {dailyFlow.worstState && dailyFlow.bestState && dailyFlow.worstState.label !== dailyFlow.bestState.label
                        ? ` Best state: ${dailyFlow.bestState.label}. Weakest state: ${dailyFlow.worstState.label}.`
                        : ''}
                    </p>
                  </div>

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
                          className="flex items-center justify-between px-4 py-3"
                          style={{ borderTop: idx > 0 ? `1px solid ${C.b0}` : 'none' }}
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
                          <span
                            className="text-[12px] font-semibold"
                            style={{ color: pnl >= 0 ? C.grn : C.red, fontFamily: C.mono }}
                          >
                            {fmtSigned(pnl)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Comparison summary — only shown when both sides have data */}
          {ps && dayTrades.length > 0 && (
            <div className="px-6 pb-6">
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
        </main>
      </div>
    </div>
  );
}
