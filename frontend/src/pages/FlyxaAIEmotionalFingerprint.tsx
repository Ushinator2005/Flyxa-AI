import { CSSProperties, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import FlyxaNav from '../components/flyxa/FlyxaNav.js';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { Trade } from '../types/index.js';
import useFlyxaStore from '../store/flyxaStore.js';

// ── constants ────────────────────────────────────────────────────────────────

const EC = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252',
};

const CARD_BORDER = `1px solid ${EC.b0}`;
const SECTION_LABEL: CSSProperties = {
  fontSize: 9.5, fontWeight: 500, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: EC.t2,
};

const EMOTION_META: Record<string, { color: string; bg: string }> = {
  'Calm':            { color: '#22c55e', bg: 'rgba(34,197,94,0.12)'    },
  'Confident':       { color: '#4a9eff', bg: 'rgba(74,158,255,0.12)'   },
  'Anxious':         { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)'   },
  'Revenge Trading': { color: '#ef4444', bg: 'rgba(239,68,68,0.12)'    },
  'FOMO':            { color: '#f97316', bg: 'rgba(249,115,22,0.12)'   },
  'Overconfident':   { color: '#a855f7', bg: 'rgba(168,85,247,0.12)'   },
  'Tired':           { color: '#64748b', bg: 'rgba(100,116,139,0.12)'  },
};

const EMOTION_ORDER = ['Calm', 'Confident', 'Anxious', 'Revenge Trading', 'FOMO', 'Overconfident', 'Tired'];

// ── helpers ──────────────────────────────────────────────────────────────────

type EmotionStats = {
  emotion: string;
  trades: number;
  wins: number;
  winRate: number;
  netPnL: number;
  avgPnL: number;
  planRate: number;
  avgConfidence: number;
  confidenceSamples: number;
};

function computeEmotionStats(trades: Trade[]): EmotionStats[] {
  const map = new Map<string, { trades: Trade[] }>();
  for (const t of trades) {
    const key = t.emotional_state ?? 'Unknown';
    if (!map.has(key)) map.set(key, { trades: [] });
    map.get(key)!.trades.push(t);
  }

  return EMOTION_ORDER
    .filter(e => map.has(e))
    .map(emotion => {
      const { trades: et } = map.get(emotion)!;
      const wins = et.filter(t => t.pnl > 0).length;
      const netPnL = et.reduce((s, t) => s + t.pnl, 0);
      const planLogged = et.filter(t => typeof t.followed_plan === 'boolean');
      const planCount = planLogged.filter(t => t.followed_plan === true).length;
      const confidenceValues = et
        .map(t => t.confidence_level)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const confSum = confidenceValues.reduce((s, value) => s + value, 0);
      return {
        emotion,
        trades: et.length,
        wins,
        winRate: et.length > 0 ? (wins / et.length) * 100 : 0,
        netPnL,
        avgPnL: et.length > 0 ? netPnL / et.length : 0,
        planRate: planLogged.length > 0 ? (planCount / planLogged.length) * 100 : 0,
        avgConfidence: confidenceValues.length > 0 ? confSum / confidenceValues.length : 0,
        confidenceSamples: confidenceValues.length,
      };
    });
}

function pct(value: number) {
  return `${value.toFixed(0)}%`;
}

function currency(value: number) {
  const abs = Math.abs(value);
  const str = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(abs);
  return value < 0 ? `-${str}` : str;
}

// ── sub-components ───────────────────────────────────────────────────────────

function StatPill({ label, value, tone }: { label: string; value: string; tone?: 'pos' | 'neg' | 'neutral' }) {
  const color = tone === 'pos' ? EC.grn : tone === 'neg' ? EC.red : EC.t1;
  return (
    <div>
      <p style={SECTION_LABEL}>{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold" style={{ color }}>{value}</p>
    </div>
  );
}

function EmotionCard({ stat }: { stat: EmotionStats }) {
  const meta = EMOTION_META[stat.emotion] ?? { color: EC.t1, bg: 'rgba(138,129,120,0.1)' };
  const pnlTone = stat.avgPnL >= 0 ? 'pos' : 'neg';

  return (
    <div
      className="rounded-[8px] p-4 space-y-3"
      style={{ backgroundColor: EC.d2, border: CARD_BORDER }}
    >
      <div className="flex items-center justify-between">
        <span
          className="rounded-[4px] px-2.5 py-1 text-[11px] font-semibold"
          style={{ color: meta.color, backgroundColor: meta.bg, border: `1px solid ${meta.color}30` }}
        >
          {stat.emotion}
        </span>
        <span className="text-[12px]" style={{ color: EC.t2 }}>{stat.trades} trade{stat.trades !== 1 ? 's' : ''}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <StatPill label="Win rate"    value={pct(stat.winRate)}          tone={stat.winRate >= 50 ? 'pos' : 'neg'} />
        <StatPill label="Avg P&L"     value={currency(stat.avgPnL)}       tone={pnlTone} />
        <StatPill label="Plan rate"   value={pct(stat.planRate)}          tone={stat.planRate >= 70 ? 'pos' : stat.planRate >= 40 ? 'neutral' : 'neg'} />
        <StatPill label="Avg confid." value={stat.confidenceSamples > 0 ? `${stat.avgConfidence.toFixed(1)}/10` : 'Not logged'} tone="neutral" />
      </div>

      <div>
        <div className="h-[2px] rounded-[2px]" style={{ backgroundColor: EC.d4 }}>
          <div
            className="h-[2px] rounded-[2px] transition-all"
            style={{ width: `${stat.winRate}%`, backgroundColor: meta.color }}
          />
        </div>
      </div>
    </div>
  );
}

// ── custom tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: EmotionStats }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const meta = EMOTION_META[d.emotion] ?? { color: EC.t1, bg: 'rgba(138,129,120,0.1)' };
  return (
    <div className="rounded-[8px] border px-3 py-2 text-[12px] space-y-1" style={{ borderColor: EC.b1, backgroundColor: EC.d2 }}>
      <p style={{ color: meta.color, fontWeight: 600 }}>{d.emotion}</p>
      <p style={{ color: EC.t1 }}>Avg P&L: <span style={{ color: d.avgPnL >= 0 ? EC.grn : EC.red }}>{currency(d.avgPnL)}</span></p>
      <p style={{ color: EC.t1 }}>Win rate: {pct(d.winRate)}</p>
      <p style={{ color: EC.t1 }}>Trades: {d.trades}</p>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function FlyxaAIEmotionalFingerprint() {
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const preSessionHistory = useFlyxaStore(state => state.preSessionHistory);
  const filtered = useMemo(() => filterTradesBySelectedAccount(trades), [filterTradesBySelectedAccount, trades]);
  const stats = useMemo(() => computeEmotionStats(filtered), [filtered]);

  // Pre-session emotion vs day performance
  const preSessionEmotionStats = useMemo(() => {
    const tradesByDate: Record<string, Trade[]> = {};
    filtered.forEach(t => {
      if (!t.trade_date) return;
      (tradesByDate[t.trade_date] ??= []).push(t);
    });
    const byEmotion: Record<string, { dayPnls: number[]; dayWinRates: number[] }> = {};
    Object.entries(preSessionHistory).forEach(([date, ps]) => {
      const emotion = ps.emotion?.trim();
      if (!emotion) return;
      const dayTrades = tradesByDate[date];
      if (!dayTrades?.length) return;
      const dayPnl = dayTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      const wins = dayTrades.filter(t => Number(t.pnl ?? 0) > 0).length;
      const winRate = (wins / dayTrades.length) * 100;
      if (!byEmotion[emotion]) byEmotion[emotion] = { dayPnls: [], dayWinRates: [] };
      byEmotion[emotion].dayPnls.push(dayPnl);
      byEmotion[emotion].dayWinRates.push(winRate);
    });
    return Object.entries(byEmotion)
      .map(([emotion, { dayPnls, dayWinRates }]) => ({
        emotion,
        days: dayPnls.length,
        avgDayPnl: dayPnls.reduce((s, v) => s + v, 0) / dayPnls.length,
        avgWinRate: dayWinRates.reduce((s, v) => s + v, 0) / dayWinRates.length,
      }))
      .sort((a, b) => b.avgDayPnl - a.avgDayPnl);
  }, [filtered, preSessionHistory]);

  const bestState  = useMemo(() => stats.filter(s => s.trades >= 3).sort((a, b) => b.winRate - a.winRate)[0] ?? null, [stats]);
  const worstState = useMemo(() => stats.filter(s => s.trades >= 3).sort((a, b) => a.winRate - b.winRate)[0] ?? null, [stats]);
  const planLeader = useMemo(() => stats.filter(s => s.trades >= 3).sort((a, b) => b.planRate - a.planRate)[0] ?? null, [stats]);

  if (loading) {
    return (
      <div className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl" style={{ backgroundColor: EC.d0 }}>
        <div className="grid h-full grid-cols-[178px_minmax(0,1fr)] overflow-hidden">
          <FlyxaNav />
          <div className="flex items-center justify-center">
            <LoadingSpinner size="lg" />
          </div>
        </div>
      </div>
    );
  }

  const hasData = stats.length > 0;

  return (
    <div className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl" style={{ backgroundColor: EC.d0, color: EC.t0 }}>
      <div className="grid h-full grid-cols-[178px_minmax(0,1fr)] overflow-hidden">
        <FlyxaNav />

        <main className="min-h-0 overflow-hidden" style={{ backgroundColor: EC.d0 }}>
          <div className="flex h-full min-h-0 flex-col">
            <section className="border-b px-6 py-5" style={{ borderColor: EC.b0 }}>
              <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: EC.t2 }}>Flyxa AI</p>
              <h1 className="mt-2 text-[24px] font-bold tracking-[-0.02em]" style={{ color: EC.t0 }}>Emotional fingerprint</h1>
              <p className="mt-1 text-[12px]" style={{ color: EC.t2 }}>How your mental state shapes execution quality and P&amp;L.</p>
            </section>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-4">
                {!hasData ? (
                  <div className="rounded-[8px] border p-10 text-center" style={{ border: CARD_BORDER, backgroundColor: EC.d2 }}>
                    <p className="text-[14px]" style={{ color: EC.t1 }}>No trade data yet.</p>
                    <p className="mt-1 text-[12px]" style={{ color: EC.t2 }}>Log trades with an emotional state to see your fingerprint.</p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      {bestState && (
                        <div className="rounded-[8px] border p-4" style={{ border: CARD_BORDER, backgroundColor: EC.d2 }}>
                          <p style={SECTION_LABEL}>Your best state</p>
                          <div className="mt-2 flex items-center gap-2">
                            <span
                              className="rounded-[4px] px-2.5 py-1 text-[12px] font-semibold"
                              style={{ color: EMOTION_META[bestState.emotion]?.color ?? EC.t1, backgroundColor: EMOTION_META[bestState.emotion]?.bg ?? 'rgba(138,129,120,0.1)' }}
                            >
                              {bestState.emotion}
                            </span>
                          </div>
                          <p className="mt-2 text-[22px] font-semibold" style={{ color: EC.grn }}>{pct(bestState.winRate)} WR</p>
                          <p className="text-[12px]" style={{ color: EC.t2 }}>{currency(bestState.avgPnL)} avg · {bestState.trades} trades</p>
                        </div>
                      )}

                      {worstState && worstState.emotion !== bestState?.emotion && (
                        <div className="rounded-[8px] border p-4" style={{ border: CARD_BORDER, backgroundColor: EC.d2 }}>
                          <p style={SECTION_LABEL}>Biggest risk state</p>
                          <div className="mt-2 flex items-center gap-2">
                            <span
                              className="rounded-[4px] px-2.5 py-1 text-[12px] font-semibold"
                              style={{ color: EMOTION_META[worstState.emotion]?.color ?? EC.t1, backgroundColor: EMOTION_META[worstState.emotion]?.bg ?? 'rgba(138,129,120,0.1)' }}
                            >
                              {worstState.emotion}
                            </span>
                          </div>
                          <p className="mt-2 text-[22px] font-semibold" style={{ color: EC.red }}>{pct(worstState.winRate)} WR</p>
                          <p className="text-[12px]" style={{ color: EC.t2 }}>{currency(worstState.avgPnL)} avg · {worstState.trades} trades</p>
                        </div>
                      )}

                      {planLeader && (
                        <div className="rounded-[8px] border p-4" style={{ border: CARD_BORDER, backgroundColor: EC.d2 }}>
                          <p style={SECTION_LABEL}>Most disciplined state</p>
                          <div className="mt-2 flex items-center gap-2">
                            <span
                              className="rounded-[4px] px-2.5 py-1 text-[12px] font-semibold"
                              style={{ color: EMOTION_META[planLeader.emotion]?.color ?? EC.t1, backgroundColor: EMOTION_META[planLeader.emotion]?.bg ?? 'rgba(138,129,120,0.1)' }}
                            >
                              {planLeader.emotion}
                            </span>
                          </div>
                          <p className="mt-2 text-[22px] font-semibold" style={{ color: EC.acc }}>{pct(planLeader.planRate)} plan rate</p>
                          <p className="text-[12px]" style={{ color: EC.t2 }}>{pct(planLeader.winRate)} WR · {planLeader.trades} trades</p>
                        </div>
                      )}
                    </div>

                    <div className="rounded-[8px] border p-4" style={{ border: CARD_BORDER, backgroundColor: EC.d2 }}>
                      <p style={SECTION_LABEL}>Average P&amp;L by emotional state</p>
                      <div className="mt-4 h-52">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={stats} barCategoryGap="30%" margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                            <XAxis
                              dataKey="emotion"
                              tick={{ fill: EC.t2, fontSize: 11 }}
                              axisLine={false}
                              tickLine={false}
                              tickFormatter={e => e.length > 8 ? e.slice(0, 8) + '…' : e}
                            />
                            <YAxis
                              tick={{ fill: EC.t2, fontSize: 11 }}
                              axisLine={false}
                              tickLine={false}
                              tickFormatter={v => `$${v}`}
                              width={46}
                            />
                            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                            <ReferenceLine y={0} stroke={EC.b1} strokeDasharray="3 3" />
                            <Bar dataKey="avgPnL" radius={[4, 4, 0, 0]}>
                              {stats.map(s => (
                                <Cell
                                  key={s.emotion}
                                  fill={s.avgPnL >= 0 ? (EMOTION_META[s.emotion]?.color ?? EC.grn) : EC.red}
                                  fillOpacity={0.85}
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div>
                      <p style={{ ...SECTION_LABEL, marginBottom: 12 }}>Breakdown by state</p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {stats.map(s => <EmotionCard key={s.emotion} stat={s} />)}
                      </div>
                    </div>

                    {preSessionEmotionStats.length > 0 && (
                      <div className="rounded-[8px] border p-4" style={{ border: CARD_BORDER, backgroundColor: EC.d2 }}>
                        <p style={SECTION_LABEL}>Pre-session emotion vs session P&amp;L</p>
                        <p className="mt-1 mb-3 text-[11px]" style={{ color: EC.t2 }}>How your pre-open mental state correlates with that day&apos;s overall performance.</p>
                        <div className="space-y-2">
                          {preSessionEmotionStats.map(row => {
                            const meta = EMOTION_META[row.emotion] ?? { color: EC.t1, bg: 'rgba(138,129,120,0.1)' };
                            return (
                              <div key={row.emotion} className="flex items-center gap-3 rounded-[6px] px-3 py-2.5" style={{ backgroundColor: EC.d3 }}>
                                <span className="min-w-0 flex-1 rounded-[3px] px-2 py-0.5 text-[11px] font-semibold" style={{ color: meta.color, backgroundColor: meta.bg }}>
                                  {row.emotion}
                                </span>
                                <span className="text-[10px]" style={{ color: EC.t2 }}>{row.days} day{row.days !== 1 ? 's' : ''}</span>
                                <span className="w-16 text-right text-[12px] font-medium" style={{ color: row.avgDayPnl >= 0 ? EC.grn : EC.red, fontFamily: 'DM Mono, ui-monospace, monospace' }}>
                                  {row.avgDayPnl >= 0 ? '+' : ''}{row.avgDayPnl.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
                                </span>
                                <span className="w-12 text-right text-[11px]" style={{ color: EC.t2 }}>
                                  {row.avgWinRate.toFixed(0)}% WR
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div className="rounded-[8px] border p-4" style={{ border: CARD_BORDER, backgroundColor: EC.d2 }}>
                      <p style={SECTION_LABEL}>Recent trades — emotion timeline</p>
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {[...filtered]
                          .sort((a, b) => {
                            const da = `${a.trade_date}T${a.trade_time ?? '00:00'}`;
                            const db = `${b.trade_date}T${b.trade_time ?? '00:00'}`;
                            return db < da ? -1 : db > da ? 1 : 0;
                          })
                          .slice(0, 40)
                          .map((t, i) => {
                            const meta = EMOTION_META[t.emotional_state ?? ''] ?? { color: EC.t2, bg: 'rgba(92,87,81,0.1)' };
                            return (
                              <div
                                key={`${t.id}-${i}`}
                                title={`${t.trade_date} · ${t.emotional_state ?? '—'} · ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(0)}`}
                                className="h-7 w-7 rounded-full flex items-center justify-center text-[9px] font-bold cursor-default"
                                style={{ backgroundColor: meta.bg, border: `1px solid ${meta.color}40`, color: meta.color }}
                              >
                                {(t.emotional_state ?? '?').slice(0, 2).toUpperCase()}
                              </div>
                            );
                          })}
                      </div>
                      <p className="mt-2 text-[11px]" style={{ color: EC.t2 }}>Hover a dot to see date, state, and P&amp;L. Newest left to right.</p>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
