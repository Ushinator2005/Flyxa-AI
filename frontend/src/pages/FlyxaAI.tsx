import { CSSProperties, Dispatch, SetStateAction, useMemo, useState } from 'react';
import { NavLink, useNavigate, type NavigateFunction } from 'react-router-dom';
import FlyxaNav from '../components/flyxa/FlyxaNav.js';
import LoadingSpinner from '../components/common/LoadingSpinner.js';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';
import useFlyxaStore, { type AiReflection } from '../store/flyxaStore.js';
import type { JournalEntry as StoreJournalEntry } from '../store/types.js';
import {
  buildData,
  escapeRegExp,
  formatSignedCompactCurrency,
  formatSignedCurrency,
  getPeriodWindow,
  parseTradeDate,
  parseTradeDateTime,
  summarize,
  type InsightType,
  type ProcessBreakdownItem,
  type TagTone,
  type TimeFrame,
  type WeeklyInsight,
  type WeeklyStat,
} from '../utils/weeklyDebrief.js';

const colors = {
  d0: 'var(--d0, #0e0d0d)',
  d1: 'var(--d1, #141312)',
  d2: 'var(--d2, #1a1917)',
  d3: 'var(--d3, #201f1d)',
  d4: 'var(--d4, #27251f)',
  b0: 'var(--b0, rgba(255,255,255,0.07))',
  b1: 'var(--b1, rgba(255,255,255,0.12))',
  t0: 'var(--t0, #e8e3dc)',
  t1: 'var(--t1, #8a8178)',
  t2: 'var(--t2, #5c5751)',
  acc: 'var(--acc, #f59e0b)',
  grn: 'var(--grn, #22d68a)',
  red: 'var(--red, #f05252)',
  amb: 'var(--amb, #f59e0b)',
  blu: 'var(--blu, #f59e0b)',
  mono: 'var(--mono, \'DM Mono\', ui-monospace, monospace)',
};

const insightTypeStyles: Record<InsightType, { accent: string }> = {
  risk: { accent: colors.red },
  pattern: { accent: colors.blu },
  psychology: { accent: colors.amb },
  edge: { accent: colors.grn },
};

type NavItemDef = { key: string; label: string; to: string; end: boolean };

type SparklineData = {
  width: number;
  height: number;
  baselineY: number;
  linePath: string;
  areaPath: string;
  endDot: { x: number; y: number; labelX: number; textAnchor: 'start' | 'middle' | 'end'; label: string };
};

type SessionBreakdownRow = { label: string; netPnl: number; winRate: number; trades: number; barWidth: number };

type BestTradeSummary = {
  symbol: string;
  direction: string;
  resultPnl: string;
  session: string;
  time: string;
  date: string;
  note: string;
  journal: string;
};

function statToneColor(tone: WeeklyStat['tone']) {
  if (tone === 'positive') return colors.grn;
  if (tone === 'negative') return colors.red;
  if (tone === 'info') return colors.amb;
  return colors.t0;
}

function tagStyle(_tone: TagTone): CSSProperties {
  return {
    color: colors.t1,
    backgroundColor: colors.d3,
    border: `1px solid ${colors.b0}`,
    borderRadius: 4,
    padding: '3px 8px',
    fontSize: 10.5,
    lineHeight: 1.3,
    fontFamily: colors.mono,
  };
}

function breakdownColor(value: number) {
  if (value >= 80) return colors.grn;
  if (value >= 40) return colors.amb;
  return colors.red;
}

function gradeColor(grade: string) {
  if (grade === 'A') return colors.grn;
  if (grade === 'B') return '#60a5fa';
  if (grade === 'C') return colors.amb;
  return colors.red;
}

function renderBodyWithHighlights(body: string, keyPhrases: string[]) {
  if (!keyPhrases.length) return body;
  const lookup = new Set(keyPhrases.map(k => k.toLowerCase()));
  const pattern = new RegExp(`(${keyPhrases.map(escapeRegExp).join('|')})`, 'gi');
  return body.split(pattern).map((segment, idx) =>
    lookup.has(segment.toLowerCase()) ? (
      <mark
        key={`${segment}-${idx}`}
        style={{
          color: colors.t0,
          backgroundColor: 'rgba(255,255,255,0.07)',
          borderRadius: 3,
          padding: '1px 4px',
          fontWeight: 500,
        }}
      >
        {segment}
      </mark>
    ) : (
      <span key={`${segment}-${idx}`} style={{ color: colors.t1 }}>
        {segment}
      </span>
    )
  );
}

export default function FlyxaAI() {
  const { trades, loading } = useTrades();
  const { filterTradesBySelectedAccount, selectedAccountId } = useAppSettings();
  const navigate = useNavigate();
  const [respondOpen, setRespondOpen] = useState(false);
  const [respondText, setRespondText] = useState('');
  const [timeframe, setTimeframe] = useState<TimeFrame>('1W');
  const [weekOffset, setWeekOffset] = useState(0);
  const aiReflections = useFlyxaStore(state => state.aiReflections);
  const addAiReflection = useFlyxaStore(state => state.addAiReflection);
  const entries = useFlyxaStore(state => state.entries);
  const riskRules = useFlyxaStore(state => state.riskRules);

  const accountTrades = useMemo(
    () => filterTradesBySelectedAccount(trades),
    [filterTradesBySelectedAccount, trades]
  );
  const safeAccountTrades = useMemo(
    () => accountTrades.filter(trade => Boolean(trade)),
    [accountTrades]
  );
  const weeklyDebriefData = useMemo(
    () => buildData(safeAccountTrades, timeframe, weekOffset, entries as StoreJournalEntry[], riskRules, selectedAccountId),
    [entries, riskRules, safeAccountTrades, selectedAccountId, timeframe, weekOffset]
  );
  const processScoreNumeric = Number.parseInt(weeklyDebriefData.stats.processScore.value, 10);
  const boundedScore = Math.max(0, Math.min(100, Number.isFinite(processScoreNumeric) ? processScoreNumeric : 0));
  const dedupedFocusItems = Array.from(new Set(weeklyDebriefData.focusItems));

  const themeVars = {
    '--d0': '#0e0d0d',
    '--d1': '#141312',
    '--d2': '#1a1917',
    '--d3': '#201f1d',
    '--d4': '#27251f',
    '--b0': 'rgba(255,255,255,0.07)',
    '--b1': 'rgba(255,255,255,0.12)',
    '--t0': '#e8e3dc',
    '--t1': '#8a8178',
    '--t2': '#5c5751',
    '--acc': '#f59e0b',
    '--grn': '#22d68a',
    '--red': '#f05252',
    '--amb': '#f59e0b',
    '--blu': '#f59e0b',
    '--mono': '\'DM Mono\', ui-monospace, monospace',
  } as CSSProperties;

  const weeklyWindow = useMemo(() => {
    const ordered = [...safeAccountTrades].sort((a, b) => (parseTradeDateTime(a)?.getTime() ?? 0) - (parseTradeDateTime(b)?.getTime() ?? 0));
    const { periodStart, periodEnd, prevStart, prevEnd } = getPeriodWindow(timeframe, weekOffset);
    const inRange = (trade: Trade, start: Date, end: Date) => {
      const date = parseTradeDate(trade);
      return Boolean(date && date.getTime() >= start.getTime() && date.getTime() <= end.getTime());
    };
    const weeklyTrades = ordered.filter(trade => inRange(trade, periodStart, periodEnd));
    const previousTrades = timeframe !== 'All' ? ordered.filter(trade => inRange(trade, prevStart, prevEnd)) : [];
    return { weeklyTrades, previousTrades };
  }, [safeAccountTrades, timeframe, weekOffset]);

  const previousWeekPnl = useMemo(
    () => summarize(weeklyWindow.previousTrades).netPnl,
    [weeklyWindow.previousTrades]
  );

  const dataCompleteness = useMemo(() => {
    const wt = weeklyWindow.weeklyTrades;
    if (!wt.length) return null;
    const withEmotion = wt.filter(t => t.emotional_state && (t.emotional_state as string) !== 'Unspecified').length;
    const withPlan = wt.filter(t => typeof t.followed_plan === 'boolean').length;
    const withNotes = wt.filter(t => t.post_trade_notes?.trim()).length;
    return {
      total: wt.length,
      emotionPct: Math.round((withEmotion / wt.length) * 100),
      planPct: Math.round((withPlan / wt.length) * 100),
      notesPct: Math.round((withNotes / wt.length) * 100),
    };
  }, [weeklyWindow.weeklyTrades]);
  const netRNumeric = Number.parseFloat(weeklyDebriefData.stats.netR.value.replace(/[^\d.+-]/g, '')) || 0;
  const weakestProcess = useMemo(
    () => [...weeklyDebriefData.processBreakdown].filter(item => !item.noData).sort((a, b) => a.value - b.value)[0],
    [weeklyDebriefData.processBreakdown]
  );

  const displayedInsights = weeklyDebriefData.insights.slice(0, 4);
  const recentReflections = aiReflections.slice(0, 3);

  function saveReflection() {
    const answer = respondText.trim();
    if (!answer) return;
    const period = getPeriodWindow(timeframe);
    addAiReflection({
      id: crypto.randomUUID(),
      question: weeklyDebriefData.question,
      answer,
      timeframe,
      periodLabel: period.headerLabel,
      createdAt: new Date().toISOString(),
    });
    setRespondOpen(false);
    setRespondText('');
  }

  const sparkline = useMemo(() => {
    const width = 168;
    const height = 42;
    const padX = 6;
    const padTop = 4;
    const padBottom = 6;
    const chartHeight = height - padTop - padBottom;
    const pnls = weeklyWindow.weeklyTrades.map(trade => Number(trade.pnl ?? 0) - Number(trade.commission ?? 0));
    const cumulative: number[] = [0];
    pnls.forEach(pnl => cumulative.push((cumulative[cumulative.length - 1] ?? 0) + pnl));
    const min = Math.min(0, ...cumulative);
    const max = Math.max(0, ...cumulative);
    const dynamicPad = Math.max(20, Math.abs(max - min) * 0.15);
    const scaleMin = min - dynamicPad;
    const scaleMax = max + dynamicPad;
    const range = Math.max(1, scaleMax - scaleMin);
    const xAt = (step: number) => padX + ((step / Math.max(1, cumulative.length - 1)) * (width - (padX * 2)));
    const yAt = (value: number) => padTop + (((scaleMax - value) / range) * chartHeight);
    const baselineY = yAt(0);

    let linePath = `M ${xAt(0)} ${yAt(cumulative[0])}`;
    let areaPath = `M ${xAt(0)} ${baselineY} L ${xAt(0)} ${yAt(cumulative[0])}`;
    for (let index = 1; index < cumulative.length; index += 1) {
      linePath += ` L ${xAt(index)} ${yAt(cumulative[index])}`;
      areaPath += ` L ${xAt(index)} ${yAt(cumulative[index])}`;
    }
    areaPath += ` L ${xAt(cumulative.length - 1)} ${baselineY} Z`;

    const endX = xAt(cumulative.length - 1);
    const endY = yAt(cumulative[cumulative.length - 1] ?? 0);
    const endValue = cumulative[cumulative.length - 1] ?? 0;
    const isNearRightEdge = endX > width - 20;
    const isNearLeftEdge = endX < 20;

    return {
      width,
      height,
      baselineY,
      linePath,
      areaPath,
      endDot: {
        x: endX,
        y: endY,
        labelX: isNearRightEdge ? endX - 4 : isNearLeftEdge ? endX + 4 : endX,
        textAnchor: isNearRightEdge ? 'end' as const : isNearLeftEdge ? 'start' as const : 'middle' as const,
        label: formatSignedCompactCurrency(endValue),
      },
    };
  }, [weeklyWindow.weeklyTrades]);

  const bestTrade = useMemo(() => {
    if (!weeklyWindow.weeklyTrades.length) return null;
    const ranked = weeklyWindow.weeklyTrades
      .map(trade => ({ trade, pnl: Number(trade.pnl ?? 0) - Number(trade.commission ?? 0) }))
      .sort((a, b) => b.pnl - a.pnl);
    const top = ranked[0];
    if (!top) return null;

    const parsed = parseTradeDateTime(top.trade);
    const dateLabel = parsed
      ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : (top.trade.trade_date || '--');

    return {
      symbol: top.trade.symbol || 'N/A',
      direction: top.trade.direction,
      resultPnl: formatSignedCurrency(top.pnl),
      session: top.trade.session || 'Other',
      time: top.trade.trade_time || '--:--',
      date: dateLabel,
      note: top.trade.pre_trade_notes?.trim() || 'Clean execution aligned with your process plan.',
      journal: top.trade.post_trade_notes?.trim() || 'Journal note not captured for this trade yet.',
    };
  }, [weeklyWindow.weeklyTrades]);

  const sessionBreakdownRows = useMemo(() => {
    const labels = ['London', 'New York', 'Asia'] as const;
    const rows = labels.map(label => {
      const tradesForSession = weeklyWindow.weeklyTrades.filter(trade => trade.session === label);
      const netPnl = tradesForSession.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
      const scored = tradesForSession.filter(trade => trade.pnl !== 0);
      const wins = scored.filter(trade => trade.pnl > 0).length;
      const winRate = scored.length ? Math.round((wins / scored.length) * 100) : 0;
      return { label, netPnl, winRate, trades: tradesForSession.length };
    });
    const maxAbs = Math.max(1, ...rows.map(row => Math.abs(row.netPnl)));
    return rows.map(row => ({ ...row, barWidth: row.trades ? Math.max(8, (Math.abs(row.netPnl) / maxAbs) * 100) : 0 }));
  }, [weeklyWindow.weeklyTrades]);

  const weekGrade = boundedScore >= 90 ? 'A' : boundedScore >= 75 ? 'B' : boundedScore >= 60 ? 'C' : 'D';
  const nextThreshold = weekGrade === 'A' ? null : weekGrade === 'B' ? 90 : weekGrade === 'C' ? 75 : 60;
  const gradeHint = nextThreshold === null
    ? `Process score at ${boundedScore}/100 — all four metrics are holding. The focus now is protecting these conditions rather than changing anything that's working.`
    : `${weakestProcess?.label ?? 'Execution quality'} is scoring ${weakestProcess?.value ?? boundedScore}/100 — the biggest single drag on the overall grade. Closing that specific gap is worth more than adding trades.`;

  const actionItems = useMemo(() => {
    const items: string[] = [];
    const wt = weeklyWindow.weeklyTrades;
    const wp = weakestProcess;

    if (wp?.label === 'Entry patience') {
      items.push(`Entry patience at ${wp.value}/100 — the trade idea is there but the timing is costing edge. The gap between anticipating a move and waiting for it to confirm is where this score lives. Until there's a specific condition defined that triggers the entry, you're relying on feel rather than criteria.`);
    } else if (wp?.label === 'Post-loss mgmt') {
      const lossCount = wt.filter(t => Number(t.pnl ?? 0) < 0).length;
      items.push(`Post-loss management at ${wp.value}/100 across ${lossCount} losing trade${lossCount !== 1 ? 's' : ''} this week. The first loss is rarely the problem — it's what happens in the 30 minutes after it. Re-entering before you've reset the emotional state or the position sizing is where the real damage gets done. A loss doesn't clear itself by winning the next trade.`);
    } else if (wp?.label === 'Size discipline') {
      items.push(`Size discipline at ${wp.value}/100. If the conditions for sizing up aren't defined in advance and objective, the decisions are being made on confidence — and confidence tends to peak right before a trade fails just as often as right before it works. The edge in sizing comes from criteria, not from feel.`);
    } else if (wp?.label === 'Plan adherence') {
      const violations = wt.filter(t => t.followed_plan === false);
      const violPnl = violations.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      if (violations.length > 0) {
        items.push(`Plan adherence at ${wp.value}/100 — ${violations.length} trade${violations.length !== 1 ? 's' : ''} off-plan this week totalling ${formatSignedCurrency(violPnl)}. Every off-plan trade that produces a win makes the next deviation easier to justify. Every one that loses adds to the actual cost. The data has made its argument.`);
      } else {
        items.push(`Plan adherence at ${wp.value}/100 — the gap is in coverage rather than outright violations. Trades logged without plan data count against the score because they can't be verified. Filling in the followed_plan field consistently is what gives this metric its signal.`);
      }
    }

    const riskInsight = displayedInsights.find(i => i.type === 'risk');
    if (riskInsight) {
      const firstSentence = riskInsight.body.split(/[.!?]/)[0];
      items.push(`${firstSentence}. That's not a hypothesis — it's the active risk pattern in the data this period.`);
    }
    const edgeInsight = displayedInsights.find(i => i.type === 'edge');
    if (edgeInsight) {
      const firstSentence = edgeInsight.body.split(/[.!?]/)[0];
      items.push(`${firstSentence}. That's the working edge right now — it deserves priority in terms of preparation and entry selection.`);
    }

    dedupedFocusItems.forEach(item => items.push(item));
    return Array.from(new Set(items)).slice(0, 3);
  }, [dedupedFocusItems, displayedInsights, weakestProcess, weeklyWindow.weeklyTrades]);

  const periodWindow = getPeriodWindow(timeframe, weekOffset);
  const navItems = [
    { key: 'weekly', label: 'Debrief', to: '/flyxa-ai', end: true },
    { key: 'weekly-report', label: 'Weekly report', to: '/flyxa-ai/weekly-report', end: false },
    { key: 'pattern', label: 'Pattern library', to: '/flyxa-ai/patterns', end: false },
    { key: 'ask', label: 'Ask Flyxa', to: '/flyxa-ai/ask', end: false },
  ];
  const primaryAction = actionItems[0] ?? gradeHint;
  const topInsights = displayedInsights.slice(0, 3);
  const keyMetrics = [
    weeklyDebriefData.stats.netR,
    weeklyDebriefData.stats.winRate,
    weeklyDebriefData.stats.processScore,
    { label: 'Trades', value: String(weeklyDebriefData.tradeCount), subLabel: `${weeklyDebriefData.sessionCount} sessions`, tone: 'neutral' as const },
  ];
  const coachHeadline = boundedScore >= 75
    ? 'Your process is stable enough to refine, not rebuild.'
    : 'Your edge needs fewer decisions and cleaner execution.';
  const coachSubcopy = safeAccountTrades.length === 0
    ? 'Log a few trades and Flyxa will turn the journal into a practical debrief.'
    : primaryAction;
  const gradeSoftBackground = weekGrade === 'A'
    ? 'rgba(34,214,138,0.10)'
    : weekGrade === 'B'
      ? 'rgba(245,158,11,0.11)'
      : weekGrade === 'C'
        ? 'rgba(245,158,11,0.08)'
        : 'rgba(240,82,82,0.10)';

  if (loading) {
    return (
      <div className="animate-fade-in flex h-[calc(100vh-3.5rem)] items-center justify-center rounded-2xl" style={{ ...themeVars, backgroundColor: colors.d0 }}>
        <LoadingSpinner size="lg" label="Analyzing your trade journal..." />
      </div>
    );
  }

  return (
    <div className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl" style={{ ...themeVars, backgroundColor: colors.d0, color: colors.t0 }}>
      <div className="grid h-full grid-cols-1 overflow-hidden lg:grid-cols-[190px_minmax(0,1fr)]">
        <FlyxaNav />

        <main className="min-h-0 overflow-y-auto" style={{ backgroundColor: colors.d0 }}>
          <MobileNavBar items={navItems} />

          <div className="mx-auto max-w-[1180px] px-4 py-5 lg:px-8 lg:py-7">
            <HeaderSection
              weekRange={weeklyDebriefData.weekRange}
              timeframe={timeframe}
              setTimeframe={setTimeframe}
              weekOffset={weekOffset}
              setWeekOffset={setWeekOffset}
            />

            {safeAccountTrades.length === 0 ? (
              <LockedEmptyState navigate={navigate} />
            ) : (
              /* One continuous report sheet — sections divided by hairlines,
                 not boxes. The document is the design. */
              <section className="mt-6 overflow-hidden rounded-[18px] border" style={{ borderColor: colors.b0, backgroundColor: colors.d1 }}>
                <SummarySection
                  gradeSoftBackground={gradeSoftBackground}
                  weekGrade={weekGrade}
                  boundedScore={boundedScore}
                  sessionCount={weeklyDebriefData.sessionCount}
                  tradeCount={weeklyDebriefData.tradeCount}
                  instruments={weeklyDebriefData.instruments}
                  coachHeadline={coachHeadline}
                  coachSubcopy={coachSubcopy}
                  actionItems={actionItems}
                  netRValue={weeklyDebriefData.stats.netR.value}
                  netRNumeric={netRNumeric}
                  timeframe={timeframe}
                  previousWeekPnl={previousWeekPnl}
                  prevLabel={periodWindow.prevLabel}
                  weeklyTradesCount={weeklyWindow.weeklyTrades.length}
                  sparkline={sparkline}
                  completeness={dataCompleteness}
                  navigate={navigate}
                />

                <KeyMetricsSection metrics={keyMetrics} />

                <div className="grid lg:grid-cols-[minmax(0,1fr)_320px]">
                  <InsightsListSection topInsights={topInsights} navigate={navigate} />

                  <DebriefAsideSection
                    weakestProcess={weakestProcess}
                    boundedScore={boundedScore}
                    weekGrade={weekGrade}
                    processBreakdown={weeklyDebriefData.processBreakdown}
                    sessionBreakdownRows={sessionBreakdownRows}
                    bestTrade={bestTrade}
                  />
                </div>

                <ReflectionSection
                  question={weeklyDebriefData.question}
                  respondOpen={respondOpen}
                  setRespondOpen={setRespondOpen}
                  respondText={respondText}
                  setRespondText={setRespondText}
                  saveReflection={saveReflection}
                  recentReflections={recentReflections}
                />
              </section>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function MobileNavBar({ items }: { items: NavItemDef[] }) {
  return (
          <nav className="flex overflow-x-auto border-b lg:hidden" style={{ borderColor: colors.b0, backgroundColor: colors.d1 }}>
            {items.map(item => (
              <NavLink key={item.key} to={item.to} end={item.end} style={{ textDecoration: 'none', flexShrink: 0 }}>
                {({ isActive }) => (
                  <span
                    className="block px-4 py-3 text-[12px]"
                    style={{
                      borderBottom: `2px solid ${isActive ? colors.acc : 'transparent'}`,
                      color: isActive ? colors.acc : colors.t1,
                      fontWeight: isActive ? 650 : 500,
                    }}
                  >
                    {item.label}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
  );
}

function HeaderSection({ weekRange, timeframe, setTimeframe, weekOffset, setWeekOffset }: {
  weekRange: string;
  timeframe: TimeFrame;
  setTimeframe: Dispatch<SetStateAction<TimeFrame>>;
  weekOffset: number;
  setWeekOffset: Dispatch<SetStateAction<number>>;
}) {
  return (
            <section data-tour-id="flyxa-ai-header" className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: colors.t2, fontFamily: colors.mono }}>
                  Flyxa Intelligence · Weekly debrief
                </p>
                <h1 className="mt-2 text-[28px] font-bold tracking-[-0.02em] lg:text-[36px]" style={{ color: colors.t0, fontFamily: 'var(--font-display)' }}>
                  {weekRange}
                </h1>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex gap-1 rounded-[9px] border p-1" style={{ borderColor: colors.b0, backgroundColor: colors.d1 }}>
                  {(['1W', '1M', '3M', 'All'] as TimeFrame[]).map(tf => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => { setTimeframe(tf); setWeekOffset(0); }}
                      className="rounded-[6px] px-3 py-1.5 text-[11px] font-semibold transition-colors"
                      style={{
                        backgroundColor: timeframe === tf ? colors.acc : 'transparent',
                        color: timeframe === tf ? colors.d0 : colors.t1,
                      }}
                    >
                      {tf}
                    </button>
                  ))}
                </div>

                {(timeframe === '1W' || timeframe === '1M') && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setWeekOffset(w => w + 1)}
                      className="rounded-[7px] border px-2.5 py-1.5 text-[12px] transition-colors hover:bg-white/[0.05]"
                      style={{ color: colors.t1, borderColor: colors.b0, backgroundColor: colors.d1 }}
                      title={timeframe === '1W' ? 'Previous week' : 'Previous month'}
                    >
                      ←
                    </button>
                    {weekOffset > 0 && (
                      <button
                        type="button"
                        onClick={() => setWeekOffset(0)}
                        className="rounded-[7px] border px-2.5 py-1.5 text-[11px] font-semibold transition-colors hover:bg-white/[0.05]"
                        style={{ color: colors.acc, borderColor: colors.b0, backgroundColor: colors.d1 }}
                      >
                        Current
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setWeekOffset(w => Math.max(0, w - 1))}
                      disabled={weekOffset === 0}
                      className="rounded-[7px] border px-2.5 py-1.5 text-[12px] transition-colors"
                      style={{
                        color: weekOffset === 0 ? colors.t2 : colors.t1,
                        borderColor: colors.b0,
                        backgroundColor: colors.d1,
                        opacity: weekOffset === 0 ? 0.45 : 1,
                      }}
                      title={timeframe === '1W' ? 'Next week' : 'Next month'}
                    >
                      →
                    </button>
                  </div>
                )}
              </div>
            </section>
  );
}

function LockedEmptyState({ navigate }: { navigate: NavigateFunction }) {
  return (
              <section className="mt-6 rounded-[16px] border p-6 lg:p-8" style={{ borderColor: colors.b0, backgroundColor: colors.d1 }}>
                <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: colors.acc }}>Flyxa AI locked</p>
                <h2 className="mt-3 text-[24px] font-semibold tracking-[-0.03em]" style={{ color: colors.t0 }}>Log trades before asking for analysis</h2>
                <p className="mt-3 max-w-2xl text-[13px] leading-7" style={{ color: colors.t1 }}>
                  Flyxa needs real journal data before it can identify process leaks, setup quality, and coaching patterns.
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/scanner')}
                  className="mt-5 rounded-[9px] px-4 py-2.5 text-[13px] font-semibold"
                  style={{ backgroundColor: colors.acc, color: colors.d0 }}
                >
                  Log first trade
                </button>
              </section>
  );
}

function SummarySection({
  gradeSoftBackground, weekGrade, boundedScore, sessionCount, tradeCount, instruments,
  coachHeadline, coachSubcopy, actionItems, netRValue, netRNumeric, timeframe,
  previousWeekPnl, prevLabel, weeklyTradesCount, sparkline, completeness, navigate,
}: {
  gradeSoftBackground: string;
  weekGrade: string;
  boundedScore: number;
  sessionCount: number;
  tradeCount: number;
  instruments: string[];
  coachHeadline: string;
  coachSubcopy: string;
  actionItems: string[];
  netRValue: string;
  netRNumeric: number;
  timeframe: TimeFrame;
  previousWeekPnl: number;
  prevLabel: string;
  weeklyTradesCount: number;
  sparkline: SparklineData;
  completeness: { emotionPct: number; planPct: number } | null;
  navigate: NavigateFunction;
}) {
  const directives = actionItems.slice(1);
  const thinCoverage = completeness && (completeness.emotionPct < 80 || completeness.planPct < 80);
  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 p-5 lg:p-7">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: colors.acc, fontFamily: colors.mono }}>
            01 · Executive summary
          </p>
          <p className="text-[11px]" style={{ color: colors.t2, fontFamily: colors.mono }}>
            {sessionCount} sessions · {tradeCount} trades · {instruments[0] ?? 'All markets'}
          </p>
        </div>

        <h2 className="mt-4 max-w-3xl text-[23px] font-bold leading-[1.18] tracking-[-0.02em] lg:text-[29px]" style={{ color: colors.t0, fontFamily: 'var(--font-display)' }}>
          {coachHeadline}
        </h2>
        <p className="mt-4 max-w-3xl text-[13px] leading-7" style={{ color: colors.t1 }}>
          {coachSubcopy}
        </p>

        {directives.length > 0 && (
          <div className="mt-6 max-w-3xl">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: colors.t2 }}>
              Directives for next week
            </p>
            <div className="mt-3 space-y-3">
              {directives.map((item, index) => (
                <div key={item} className="flex gap-3">
                  <span className="mt-0.5 shrink-0 text-[11px] font-semibold" style={{ color: colors.acc, fontFamily: colors.mono }}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <p className="text-[12.5px] leading-6" style={{ color: colors.t1 }}>{item}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {thinCoverage && completeness && (
          <p className="mt-6 text-[11px] leading-relaxed" style={{ color: colors.t2 }}>
            Data coverage: emotion tagged {completeness.emotionPct}% · plan logged {completeness.planPct}% — thin coverage limits this report's accuracy.{' '}
            <button type="button" className="font-semibold" style={{ color: colors.acc }} onClick={() => navigate('/journal')}>
              Fill journal gaps →
            </button>
          </p>
        )}
      </div>

      {/* Figures column — ruled off, not boxed */}
      <div className="flex flex-col justify-between gap-5 border-t p-5 lg:border-l lg:border-t-0 lg:p-6" style={{ borderColor: colors.b0 }}>
        <div>
          <div className="flex items-start justify-between gap-3">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: colors.t2 }}>Net P&L</p>
            <span className="rounded-[8px] px-2.5 py-1.5 text-[18px] font-bold leading-none" style={{ color: gradeColor(weekGrade), backgroundColor: gradeSoftBackground, fontFamily: colors.mono }}>
              {weekGrade}
            </span>
          </div>
          <p className="mt-2 text-[34px] font-semibold leading-none tracking-[-0.04em]" style={{ color: netRNumeric >= 0 ? colors.grn : colors.red, fontFamily: colors.mono }}>
            {netRValue}
          </p>
          <p className="mt-2 text-[11px]" style={{ color: colors.t2, fontFamily: colors.mono }}>
            {timeframe !== 'All' ? `vs ${formatSignedCurrency(previousWeekPnl)} ${prevLabel}` : `${weeklyTradesCount} trades total`}
          </p>
        </div>

        <svg width="100%" height={72} viewBox={`0 0 ${sparkline.width} ${sparkline.height}`} preserveAspectRatio="none" className="block">
          <line x1={6} y1={sparkline.baselineY} x2={sparkline.width - 6} y2={sparkline.baselineY} stroke="rgba(255,255,255,0.06)" strokeWidth="0.5" />
          <path d={sparkline.areaPath} fill={netRNumeric >= 0 ? 'rgba(34,214,138,0.08)' : 'rgba(240,82,82,0.09)'} />
          <path d={sparkline.linePath} fill="none" stroke={netRNumeric >= 0 ? colors.grn : colors.red} strokeWidth="1.8" />
        </svg>

        <div className="flex items-center justify-between border-t pt-3" style={{ borderColor: colors.b0 }}>
          <span className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: colors.t2 }}>Process score</span>
          <span className="text-[13px] font-semibold" style={{ color: gradeColor(weekGrade), fontFamily: colors.mono }}>
            {boundedScore}/100
          </span>
        </div>
      </div>
    </div>
  );
}

function KeyMetricsSection({ metrics }: { metrics: WeeklyStat[] }) {
  return (
    <section data-tour-id="flyxa-ai-stats" className="grid grid-cols-2 border-t lg:grid-cols-4" style={{ borderColor: colors.b0 }}>
      {metrics.map((metric, index) => (
        <div
          key={metric.label}
          className="px-5 py-4 lg:px-7 lg:py-5"
          style={{
            borderColor: colors.b0,
            borderLeftWidth: index % 2 === 1 ? 1 : 0,
            borderLeftStyle: 'solid',
            borderTopWidth: index >= 2 ? 1 : 0,
            borderTopStyle: 'solid',
          }}
        >
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: colors.t2 }}>{metric.label}</p>
          <p className="mt-2 text-[21px] font-semibold leading-none tracking-[-0.03em]" style={{ color: statToneColor(metric.tone), fontFamily: colors.mono }}>
            {metric.value}
          </p>
          <p className="mt-2 text-[11px]" style={{ color: colors.t2 }}>{metric.subLabel}</p>
        </div>
      ))}
      <style>{`
        @media (min-width: 1024px) {
          [data-tour-id="flyxa-ai-stats"] > div { border-top-width: 0 !important; }
          [data-tour-id="flyxa-ai-stats"] > div:not(:first-child) { border-left-width: 1px !important; }
        }
      `}</style>
    </section>
  );
}

function InsightsListSection({ topInsights, navigate }: { topInsights: WeeklyInsight[]; navigate: NavigateFunction }) {
  return (
                  <section data-tour-id="flyxa-ai-insights" className="min-w-0 border-t" style={{ borderColor: colors.b0 }}>
                    <div className="px-5 pb-1 pt-5 lg:px-7 lg:pt-6">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: colors.acc, fontFamily: colors.mono }}>
                        02 · Findings
                      </p>
                      <h2 className="mt-2 text-[19px] font-bold tracking-[-0.01em]" style={{ color: colors.t0, fontFamily: 'var(--font-display)' }}>
                        What the data argues
                      </h2>
                    </div>

                    <div className="divide-y" style={{ borderColor: colors.b0 }}>
                      {topInsights.map((insight, index) => {
                        const style = insightTypeStyles[insight.type];
                        return (
                          <article key={insight.title} className="px-5 py-5 lg:px-7">
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 w-6 shrink-0 text-[11px] font-semibold" style={{ color: colors.t2, fontFamily: colors.mono }}>
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]" style={{ color: style.accent, backgroundColor: `color-mix(in srgb, ${style.accent} 11%, transparent)` }}>
                                    {insight.badge}
                                  </span>
                                  <span className="text-[11px]" style={{ color: colors.t2 }}>{insight.frequency}</span>
                                </div>
                                <h3 className="mt-2 text-[15px] font-semibold leading-snug" style={{ color: colors.t0 }}>{insight.title}</h3>
                                <p className="mt-2 text-[13px] leading-7" style={{ color: colors.t1 }}>
                                  {renderBodyWithHighlights(insight.body, insight.keyPhrases)}
                                </p>
                                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex flex-wrap gap-1.5">
                                    {insight.tags.slice(0, 3).map(tag => (
                                      <span key={tag.label} style={tagStyle(tag.tone)}>{tag.label}</span>
                                    ))}
                                  </div>
                                  <button
                                    type="button"
                                    className="text-[12px] font-semibold"
                                    style={{ color: colors.acc }}
                                    onClick={() => {
                                      const label = insight.actionLabel.toLowerCase();
                                      if (label.includes('pre-session')) navigate('/pre-session');
                                      else if (label.includes('pattern library') || label.includes('confluence')) navigate('/flyxa-ai/patterns');
                                      else if (label.includes('keep logging')) navigate('/scanner');
                                      else navigate('/journal');
                                    }}
                                  >
                                    {insight.actionLabel}
                                  </button>
                                </div>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
  );
}

function DebriefAsideSection({
  weakestProcess, boundedScore, weekGrade, processBreakdown,
  sessionBreakdownRows, bestTrade,
}: {
  weakestProcess: ProcessBreakdownItem | undefined;
  boundedScore: number;
  weekGrade: string;
  processBreakdown: ProcessBreakdownItem[];
  sessionBreakdownRows: SessionBreakdownRow[];
  bestTrade: BestTradeSummary | null;
}) {
  return (
    <aside className="border-t lg:border-l" style={{ borderColor: colors.b0 }}>
      <div className="px-5 pt-5 lg:px-6 lg:pt-6">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: colors.acc, fontFamily: colors.mono }}>
          03 · Appendix
        </p>
      </div>

      <div className="space-y-6 px-5 py-5 lg:px-6">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-[12px] font-semibold" style={{ color: colors.t0 }}>Process breakdown</p>
            <p className="text-[13px] font-semibold" style={{ color: gradeColor(weekGrade), fontFamily: colors.mono }}>{boundedScore}/100</p>
          </div>
          <p className="mt-1 text-[10.5px]" style={{ color: colors.t2 }}>
            Weakest: {weakestProcess?.label ?? 'Execution quality'}
          </p>
          <div className="mt-3 space-y-3">
            {processBreakdown.map(item => {
              const color = item.noData ? colors.t2 : breakdownColor(item.value);
              return (
                <div key={item.label}>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[11.5px]" style={{ color: colors.t1 }}>{item.label}</span>
                    <span className="text-[11.5px] font-semibold" style={{ color, fontFamily: colors.mono }}>{item.noData ? 'N/A' : `${item.value}%`}</span>
                  </div>
                  <div className="h-[3px] overflow-hidden rounded-full" style={{ backgroundColor: colors.d4 }}>
                    {!item.noData && <div className="h-full rounded-full" style={{ width: `${item.value}%`, backgroundColor: color }} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="border-t pt-5" style={{ borderColor: colors.b0 }}>
          <p className="text-[12px] font-semibold" style={{ color: colors.t0 }}>Session split</p>
          <div className="mt-3 space-y-3">
            {sessionBreakdownRows.map(row => (
              <div key={row.label}>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="text-[11.5px]" style={{ color: colors.t1 }}>{row.label}</span>
                  <span className="text-[11.5px] font-semibold" style={{ color: row.netPnl > 0 ? colors.grn : row.netPnl < 0 ? colors.red : colors.t2, fontFamily: colors.mono }}>
                    {row.trades ? formatSignedCompactCurrency(row.netPnl) : '--'}
                  </span>
                </div>
                <div className="h-[3px] overflow-hidden rounded-full" style={{ backgroundColor: colors.d4 }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${row.barWidth}%`, backgroundColor: row.netPnl > 0 ? colors.grn : row.netPnl < 0 ? colors.red : colors.t2 }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {bestTrade && (
          <div className="border-t pt-5" style={{ borderColor: colors.b0 }}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[12px] font-semibold" style={{ color: colors.t0 }}>Best execution</p>
              <span className="text-[10.5px]" style={{ color: colors.t2, fontFamily: colors.mono }}>{bestTrade.date}</span>
            </div>
            <div className="mt-3 flex items-end justify-between gap-3">
              <div>
                <p className="text-[15px] font-semibold" style={{ color: colors.t0, fontFamily: colors.mono }}>{bestTrade.symbol}</p>
                <p className="mt-1 text-[11px]" style={{ color: colors.t2 }}>{bestTrade.session} · {bestTrade.direction}</p>
              </div>
              <p className="text-[15px] font-semibold" style={{ color: colors.grn, fontFamily: colors.mono }}>{bestTrade.resultPnl}</p>
            </div>
            <p className="mt-3 text-[11.5px] leading-6" style={{ color: colors.t1 }}>{bestTrade.journal}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function ReflectionSection({
  question, respondOpen, setRespondOpen, respondText, setRespondText, saveReflection, recentReflections,
}: {
  question: string;
  respondOpen: boolean;
  setRespondOpen: Dispatch<SetStateAction<boolean>>;
  respondText: string;
  setRespondText: Dispatch<SetStateAction<string>>;
  saveReflection: () => void;
  recentReflections: AiReflection[];
}) {
  return (
    <section data-tour-id="flyxa-ai-reflection" className="border-t px-5 py-5 lg:px-7 lg:py-6" style={{ borderColor: colors.b0 }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: colors.acc, fontFamily: colors.mono }}>
            04 · Reflection
          </p>
          <p className="mt-2 text-[14px] font-semibold leading-relaxed" style={{ color: colors.t0 }}>{question}</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-[7px] border px-3.5 py-2 text-[12px] font-semibold"
          style={{ borderColor: colors.b0, color: respondOpen ? colors.t1 : colors.acc, backgroundColor: colors.d2 }}
          onClick={() => setRespondOpen(prev => !prev)}
        >
          {respondOpen ? 'Cancel' : 'Respond'}
        </button>
      </div>

      {respondOpen && (
        <div className="mt-4 max-w-2xl">
          <textarea
            className="w-full resize-none rounded-[10px] text-[13px] leading-relaxed"
            style={{
              backgroundColor: colors.d2,
              border: `1px solid ${colors.b1}`,
              color: colors.t0,
              padding: '12px 13px',
              fontFamily: 'var(--font-sans)',
              outline: 'none',
              minHeight: 92,
            }}
            placeholder="Write the one thing you need to remember before your next session..."
            value={respondText}
            onChange={e => setRespondText(e.target.value)}
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={!respondText.trim()}
              className="rounded-[8px] px-3.5 py-2 text-[12px] font-semibold disabled:opacity-40"
              style={{ backgroundColor: colors.acc, color: colors.d0 }}
              onClick={saveReflection}
            >
              Save reflection
            </button>
          </div>
        </div>
      )}

      {recentReflections.length > 0 && (
        <div className="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {recentReflections.slice(0, 2).map(reflection => (
            <div key={reflection.id} className="border-t pt-3" style={{ borderColor: colors.b0 }}>
              <p className="text-[10px]" style={{ color: colors.t2, fontFamily: colors.mono }}>{reflection.periodLabel}</p>
              <p className="mt-1.5 text-[12px] leading-6" style={{ color: colors.t1 }}>{reflection.answer}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
