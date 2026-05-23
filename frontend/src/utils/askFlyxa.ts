import { Trade } from '../types/index.js';

// ─── Public types ─────────────────────────────────────────────────────────────
export interface AskDataRow {
  label: string;
  winRate: number;
  netPnl: number;
  trades: number;
  avgPnl: number;
  tone: 'pos' | 'neg' | 'neu';
}

export interface AskResponse {
  question: string;
  answer: string;       // one-sentence headline
  detail: string;       // 2–3 sentences with numbers
  rows?: AskDataRow[];  // supporting breakdown table
  action?: string;      // actionable recommendation
  warning?: string;     // critical caution
  confidence: 'high' | 'medium' | 'low';
  sampleSize: number;
  noData?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

function wr(trades: Trade[]): number {
  if (!trades.length) return 0;
  return (trades.filter(t => (t.pnl ?? 0) > 0).length / trades.length) * 100;
}

function net(trades: Trade[]): number {
  return trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
}

function avgPnl(trades: Trade[]): number {
  return trades.length ? net(trades) / trades.length : 0;
}

function conf(n: number): 'high' | 'medium' | 'low' {
  return n >= 20 ? 'high' : n >= 8 ? 'medium' : 'low';
}

function fmtPnl(v: number): string {
  const abs = Math.abs(v);
  const s = abs >= 1000 ? `$${(abs / 1000).toFixed(1)}k` : `$${abs.toFixed(0)}`;
  return v >= 0 ? `+${s}` : `-${s}`;
}

function fmtPct(v: number): string {
  return `${Math.round(v)}%`;
}

function matchesAny(q: string, patterns: string[]): boolean {
  return patterns.some(p => q.includes(p));
}

function buildRows(groups: Record<string, Trade[]>): AskDataRow[] {
  return Object.entries(groups)
    .filter(([, ts]) => ts.length >= 2)
    .map(([label, ts]) => ({
      label,
      winRate: wr(ts),
      netPnl: net(ts),
      trades: ts.length,
      avgPnl: avgPnl(ts),
      tone: (net(ts) > 0 ? 'pos' : net(ts) < 0 ? 'neg' : 'neu') as AskDataRow['tone'],
    }))
    .sort((a, b) => b.netPnl - a.netPnl);
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Analyzers ────────────────────────────────────────────────────────────────

function analyzeBySession(trades: Trade[]): Omit<AskResponse, 'question'> {
  const groups = groupBy(trades, t => t.session ?? 'Other');
  const rows = buildRows(groups);
  if (rows.length < 2) return {
    answer: 'Not enough session data yet.',
    detail: `Log trades across multiple sessions to compare. Currently only ${rows.length} session${rows.length === 1 ? '' : 's'} with enough data.`,
    confidence: 'low', sampleSize: trades.length, noData: true,
  };
  const best = rows[0];
  const worst = rows[rows.length - 1];
  const overall = wr(trades);
  return {
    answer: `Your best session is ${best.label} (${fmtPct(best.winRate)} WR, ${fmtPnl(best.netPnl)} net).`,
    detail: `Across ${trades.length} trades, ${best.label} leads at ${fmtPct(best.winRate)} WR vs your ${fmtPct(overall)} overall. ${worst.label} is your weakest at ${fmtPct(worst.winRate)} WR and ${fmtPnl(worst.netPnl)} net across ${worst.trades} trades.`,
    rows,
    action: worst.netPnl < 0
      ? `Consider cutting or reducing size in the ${worst.label} session — it's cost you ${fmtPnl(Math.abs(worst.netPnl))}.`
      : `Keep concentrating A+ setups in ${best.label} session.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

function analyzeByDayOfWeek(trades: Trade[], q: string): Omit<AskResponse, 'question'> {
  const groups = groupBy(trades, t => {
    const d = t.trade_date ? new Date(`${t.trade_date}T00:00:00`) : null;
    return d && !isNaN(d.getTime()) ? DOW[d.getDay()] : 'Unknown';
  });
  const rows = buildRows(groups).filter(r => r.label !== 'Unknown');

  const specificDay = DOW.find(d => q.includes(d.toLowerCase()));
  if (specificDay && groups[specificDay]) {
    const dt = groups[specificDay];
    const diff = wr(dt) - wr(trades);
    return {
      answer: `On ${specificDay}s: ${fmtPct(wr(dt))} WR across ${dt.length} trades (${fmtPnl(net(dt))} net).`,
      detail: `Your overall WR is ${fmtPct(wr(trades))}. ${specificDay} is ${Math.abs(diff) < 5 ? 'roughly in line with' : diff > 0 ? `${fmtPct(diff)} above` : `${fmtPct(Math.abs(diff))} below`} that average. Avg P&L per trade: ${fmtPnl(avgPnl(dt))}.`,
      rows, confidence: conf(dt.length), sampleSize: dt.length,
    };
  }
  if (!rows.length) return { answer: 'Not enough day-of-week data.', detail: 'Log more trades to see daily patterns.', confidence: 'low', sampleSize: trades.length, noData: true };
  const best = rows[0];
  const worst = rows[rows.length - 1];
  return {
    answer: `${best.label} is your best day (${fmtPct(best.winRate)} WR, ${fmtPnl(best.netPnl)}). ${worst.label} is your worst (${fmtPct(worst.winRate)} WR, ${fmtPnl(worst.netPnl)}).`,
    detail: `Your overall WR is ${fmtPct(wr(trades))}. ${best.label} beats it by ${fmtPct(best.winRate - wr(trades))}. ${worst.label} lags by ${fmtPct(wr(trades) - worst.winRate)}.`,
    rows,
    action: worst.netPnl < -100 ? `Consider sitting out ${worst.label}s — they've cost you ${fmtPnl(Math.abs(worst.netPnl))}.` : `${best.label} is your edge day. Concentrate your best setups then.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

function analyzeBySymbol(trades: Trade[], q: string): Omit<AskResponse, 'question'> {
  const groups = groupBy(trades, t => (t.symbol ?? 'Unknown').replace(/\s+\d{2}-\d{2}$/, '').toUpperCase());
  const rows = buildRows(groups);
  const symbols = Object.keys(groups);
  const specific = symbols.find(s => q.toUpperCase().includes(s));
  if (specific && groups[specific]) {
    const st = groups[specific];
    const diff = wr(st) - wr(trades);
    return {
      answer: `${specific}: ${fmtPct(wr(st))} WR across ${st.length} trades, ${fmtPnl(net(st))} net P&L.`,
      detail: `That's ${Math.abs(diff) < 5 ? 'in line with' : diff > 0 ? `${fmtPct(diff)} above` : `${fmtPct(Math.abs(diff))} below`} your ${fmtPct(wr(trades))} overall WR. Avg P&L per trade: ${fmtPnl(avgPnl(st))}.`,
      rows: rows.length > 1 ? rows : undefined,
      confidence: conf(st.length), sampleSize: st.length,
    };
  }
  if (rows.length < 2) return { answer: 'Only one instrument in your data.', detail: rows[0] ? `You've only traded ${rows[0].label}. Add more instruments to compare.` : 'No instrument data found.', rows, confidence: conf(trades.length), sampleSize: trades.length };
  const best = rows[0];
  const worst = rows[rows.length - 1];
  return {
    answer: `${best.label} is your strongest instrument (${fmtPct(best.winRate)} WR, ${fmtPnl(best.netPnl)} net).`,
    detail: `Across ${symbols.length} instruments. ${best.label} averages ${fmtPnl(best.avgPnl)}/trade. ${worst.label} is your weakest at ${fmtPct(worst.winRate)} WR and ${fmtPnl(worst.netPnl)} net.`,
    rows,
    action: worst.netPnl < -200 ? `Reconsider whether ${worst.label} fits your edge — it's dragging overall P&L.` : `Your instrument mix looks balanced.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

function analyzePlanAdherence(trades: Trade[]): Omit<AskResponse, 'question'> {
  const logged = trades.filter(t => typeof t.followed_plan === 'boolean');
  if (logged.length < 6) return {
    answer: 'Not enough plan adherence data.',
    detail: `Only ${logged.length} trades have followed_plan logged. Tag this field consistently to get real insights.`,
    confidence: 'low', sampleSize: logged.length, noData: logged.length < 3,
  };
  const onPlan = logged.filter(t => t.followed_plan === true);
  const offPlan = logged.filter(t => t.followed_plan === false);
  const onWr = wr(onPlan), offWr = wr(offPlan);
  const onNet = net(onPlan), offNet = net(offPlan);
  const rows: AskDataRow[] = [
    { label: 'On-plan trades', winRate: onWr, netPnl: onNet, trades: onPlan.length, avgPnl: avgPnl(onPlan), tone: onNet >= 0 ? 'pos' : 'neg' },
    { label: 'Off-plan trades', winRate: offWr, netPnl: offNet, trades: offPlan.length, avgPnl: avgPnl(offPlan), tone: offNet >= 0 ? 'pos' : 'neg' },
  ];
  const edgeExists = onWr > offWr + 10;
  const planWorks = onNet > offNet;
  return {
    answer: edgeExists
      ? `Your plan is working — on-plan ${fmtPct(onWr)} WR vs off-plan ${fmtPct(offWr)} WR.`
      : offWr > onWr + 10
        ? `Interestingly, off-plan trades (${fmtPct(offWr)} WR) outperform on-plan (${fmtPct(onWr)} WR).`
        : `On-plan (${fmtPct(onWr)}) and off-plan (${fmtPct(offWr)}) WRs are similar across ${logged.length} logged trades.`,
    detail: `On-plan: ${onPlan.length} trades, ${fmtPct(onWr)} WR, ${fmtPnl(onNet)} net. Off-plan: ${offPlan.length} trades, ${fmtPct(offWr)} WR, ${fmtPnl(offNet)} net.${offNet < 0 ? ` Off-plan trading has cost you ${fmtPnl(Math.abs(offNet))}.` : ''}`,
    rows,
    action: edgeExists && planWorks
      ? `Eliminate off-plan trades entirely. Your data shows they destroy edge.`
      : offWr > onWr + 10
        ? `Your off-plan trades outperform — consider reviewing your plan rules.`
        : `Keep logging. With ${logged.length} data points, signal will sharpen with more trades.`,
    confidence: conf(logged.length), sampleSize: logged.length,
  };
}

function analyzeByEmotion(trades: Trade[], q: string): Omit<AskResponse, 'question'> {
  const withEmotion = trades.filter(t => t.emotional_state?.trim());
  if (withEmotion.length < 8) return {
    answer: 'Not enough emotion data.',
    detail: `Only ${withEmotion.length} trades have emotion logged. Tag your state consistently to unlock this insight.`,
    confidence: 'low', sampleSize: withEmotion.length, noData: withEmotion.length < 3,
  };
  const groups = groupBy(withEmotion, t => (t.emotional_state ?? 'Unknown').trim());
  const rows = buildRows(groups).filter(r => (groups[r.label]?.length ?? 0) >= 2);
  const emotions = Object.keys(groups);
  const specific = emotions.find(e => q.includes(e.toLowerCase()));
  if (specific) {
    const et = groups[specific];
    return {
      answer: `When ${specific}: ${fmtPct(wr(et))} WR across ${et.length} trades (${fmtPnl(net(et))} net).`,
      detail: `Overall logged WR: ${fmtPct(wr(withEmotion))}. In "${specific}" state: ${fmtPct(wr(et))} — ${wr(et) > wr(withEmotion) ? 'above' : 'below'} average by ${fmtPct(Math.abs(wr(et) - wr(withEmotion)))}.`,
      rows, confidence: conf(et.length), sampleSize: et.length,
    };
  }
  if (!rows.length) return { answer: 'Not enough data per emotion state.', detail: 'Need 2+ trades per emotion state.', confidence: 'low', sampleSize: withEmotion.length, noData: true };
  const best = rows[0];
  const worst = rows[rows.length - 1];
  const overall = wr(withEmotion);
  return {
    answer: `Best state: ${best.label} (${fmtPct(best.winRate)} WR). Worst: ${worst.label} (${fmtPct(worst.winRate)} WR).`,
    detail: `Across ${withEmotion.length} tagged trades (overall ${fmtPct(overall)} WR). ${best.label} exceeds baseline by ${fmtPct(best.winRate - overall)}. ${worst.label} lags by ${fmtPct(overall - worst.winRate)}.`,
    rows,
    action: worst.winRate < overall - 15
      ? `When you feel ${worst.label}, reduce size or sit out — that state is costing you ${fmtPnl(Math.abs(worst.netPnl))}.`
      : `Emotional variance is modest. Keep logging to sharpen the signal.`,
    confidence: conf(withEmotion.length), sampleSize: withEmotion.length,
  };
}

function analyzeOvertrading(trades: Trade[]): Omit<AskResponse, 'question'> {
  const byDate = groupBy(trades, t => t.trade_date ?? 'unknown');
  const days = Object.entries(byDate).filter(([k]) => k !== 'unknown');
  const dayStats = days.map(([, ts]) => ({ count: ts.length, wr: wr(ts), net: net(ts) }));
  const high = dayStats.filter(d => d.count >= 4);
  const low = dayStats.filter(d => d.count <= 2);
  if (high.length < 3 || low.length < 3) return {
    answer: 'Not enough data to assess overtrading.',
    detail: `Need at least 3 days with 4+ trades and 3 days with 1–2 trades to compare. Currently: ${high.length} high-volume days, ${low.length} low-volume days.`,
    confidence: 'low', sampleSize: dayStats.length,
  };
  const highWr = high.reduce((s, d) => s + d.wr, 0) / high.length;
  const lowWr = low.reduce((s, d) => s + d.wr, 0) / low.length;
  const highPpd = high.reduce((s, d) => s + d.net, 0) / high.length;
  const lowPpd = low.reduce((s, d) => s + d.net, 0) / low.length;
  const isIssue = highWr < lowWr - 10 && lowPpd > highPpd;
  const rows: AskDataRow[] = [
    { label: '1–2 trades/day', winRate: lowWr, netPnl: low.reduce((s,d)=>s+d.net,0), trades: low.length, avgPnl: lowPpd, tone: lowPpd >= 0 ? 'pos' : 'neg' },
    { label: '4+ trades/day', winRate: highWr, netPnl: high.reduce((s,d)=>s+d.net,0), trades: high.length, avgPnl: highPpd, tone: highPpd >= 0 ? 'pos' : 'neg' },
  ];
  return {
    answer: isIssue
      ? `Yes — high-volume days hurt you. 1–2 trade days: ${fmtPct(lowWr)} WR vs ${fmtPct(highWr)} on 4+ trade days.`
      : `Overtrading doesn't appear to be a significant drag on your performance.`,
    detail: `1–2 trade days (${low.length} days): ${fmtPct(lowWr)} WR, avg ${fmtPnl(lowPpd)}/day. 4+ trade days (${high.length} days): ${fmtPct(highWr)} WR, avg ${fmtPnl(highPpd)}/day.`,
    rows,
    action: isIssue
      ? `Set a max 2–3 trades/day rule. Your selective days clearly outperform your busy days.`
      : `Trade frequency isn't hurting your edge. Keep monitoring.`,
    warning: isIssue ? `This is a structural edge-killer. Each extra trade on a busy day dilutes your edge.` : undefined,
    confidence: conf(dayStats.length), sampleSize: dayStats.length,
  };
}

function analyzePostLoss(trades: Trade[]): Omit<AskResponse, 'question'> {
  const byDate = groupBy(trades, t => t.trade_date ?? 'unknown');
  const postLoss: Trade[] = [];
  for (const ts of Object.values(byDate)) {
    const sorted = [...ts].sort((a, b) => (a.trade_time ?? '').localeCompare(b.trade_time ?? ''));
    for (let i = 1; i < sorted.length; i++) {
      if ((sorted[i - 1].pnl ?? 0) < 0) postLoss.push(sorted[i]);
    }
  }
  if (postLoss.length < 4) return {
    answer: 'Not enough post-loss trade data.',
    detail: `Only ${postLoss.length} trades follow a same-day loss. Need at least 4 to analyze this pattern.`,
    confidence: 'low', sampleSize: postLoss.length,
  };
  const overall = wr(trades);
  const plWr = wr(postLoss);
  const plNet = net(postLoss);
  const drop = overall - plWr;
  const isIssue = plWr < overall - 12 && plNet < 0;
  const rows: AskDataRow[] = [
    { label: 'All trades', winRate: overall, netPnl: net(trades), trades: trades.length, avgPnl: avgPnl(trades), tone: 'neu' },
    { label: 'After a loss (same day)', winRate: plWr, netPnl: plNet, trades: postLoss.length, avgPnl: avgPnl(postLoss), tone: plNet >= 0 ? 'pos' : 'neg' },
  ];
  return {
    answer: isIssue
      ? `Post-loss revenge trading is confirmed — WR drops from ${fmtPct(overall)} to ${fmtPct(plWr)} after a loss.`
      : `You handle losses well — post-loss WR (${fmtPct(plWr)}) is close to your overall (${fmtPct(overall)}).`,
    detail: `${postLoss.length} trades followed a same-day loss. Post-loss WR: ${fmtPct(plWr)} vs ${fmtPct(overall)} overall — a ${fmtPct(Math.abs(drop))} ${drop > 0 ? 'drop' : 'improvement'}. Net P&L on post-loss trades: ${fmtPnl(plNet)}.`,
    rows,
    action: isIssue
      ? `Mandatory 15-minute pause after any loss before re-entering. Your data proves this pattern is real.`
      : `Post-loss composure is solid. Keep maintaining this discipline.`,
    warning: isIssue ? `This is one of the most destructive trading patterns. Address it before scaling up.` : undefined,
    confidence: conf(postLoss.length), sampleSize: postLoss.length,
  };
}

function analyzeTrend(trades: Trade[]): Omit<AskResponse, 'question'> {
  if (trades.length < 10) return {
    answer: 'Not enough trade history to assess trend.',
    detail: 'Need at least 10 trades. Keep logging.',
    confidence: 'low', sampleSize: trades.length, noData: true,
  };
  const sorted = [...trades].sort((a, b) => (a.trade_date ?? '').localeCompare(b.trade_date ?? ''));
  const half = Math.floor(sorted.length / 2);
  const first = sorted.slice(0, half);
  const second = sorted.slice(half);
  const f = { wr: wr(first), net: net(first), avg: avgPnl(first) };
  const s = { wr: wr(second), net: net(second), avg: avgPnl(second) };
  const improving = s.wr > f.wr + 5 || (s.net > f.net && s.wr >= f.wr - 5);
  const declining = s.wr < f.wr - 5;
  const rows: AskDataRow[] = [
    { label: `Earlier ${first.length} trades`, winRate: f.wr, netPnl: f.net, trades: first.length, avgPnl: f.avg, tone: f.net >= 0 ? 'pos' : 'neg' },
    { label: `Recent ${second.length} trades`, winRate: s.wr, netPnl: s.net, trades: second.length, avgPnl: s.avg, tone: s.net >= 0 ? 'pos' : 'neg' },
  ];
  return {
    answer: improving
      ? `Yes — you're improving. Recent WR ${fmtPct(s.wr)} vs earlier ${fmtPct(f.wr)}.`
      : declining
        ? `Performance has declined. WR dropped from ${fmtPct(f.wr)} to ${fmtPct(s.wr)} recently.`
        : `Performance is roughly flat — WR moved from ${fmtPct(f.wr)} to ${fmtPct(s.wr)}.`,
    detail: `Earlier ${first.length} trades: ${fmtPct(f.wr)} WR, ${fmtPnl(f.net)} net, avg ${fmtPnl(f.avg)}/trade. Recent ${second.length} trades: ${fmtPct(s.wr)} WR, ${fmtPnl(s.net)} net, avg ${fmtPnl(s.avg)}/trade.`,
    rows,
    action: improving
      ? `Trend is positive — document what changed and double down on it.`
      : declining
        ? `Review what changed recently. Compare your current setups against your earlier winning trades.`
        : `Work on reducing losing days. Consistency compounds faster than chasing bigger wins.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

function analyzeWinRate(trades: Trade[]): Omit<AskResponse, 'question'> {
  if (!trades.length) return { answer: 'No trades logged yet.', detail: 'Import or log trades first.', confidence: 'low', sampleSize: 0, noData: true };
  const wins = trades.filter(t => (t.pnl ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl ?? 0) < 0);
  const bes = trades.filter(t => (t.pnl ?? 0) === 0);
  const totalWr = wr(trades);
  const totalNet = net(trades);
  const avgWin = wins.length ? avgPnl(wins) : 0;
  const avgLoss = losses.length ? avgPnl(losses) : 0;
  const pf = losses.length && net(losses) !== 0 ? Math.abs(net(wins) / net(losses)) : null;
  const rows: AskDataRow[] = [
    { label: `Wins (${wins.length})`, winRate: 100, netPnl: net(wins), trades: wins.length, avgPnl: avgWin, tone: 'pos' },
    { label: `Losses (${losses.length})`, winRate: 0, netPnl: net(losses), trades: losses.length, avgPnl: avgLoss, tone: 'neg' },
    ...(bes.length > 0 ? [{ label: `Breakeven (${bes.length})`, winRate: 0, netPnl: 0, trades: bes.length, avgPnl: 0, tone: 'neu' as const }] : []),
  ];
  return {
    answer: `${fmtPct(totalWr)} WR across ${trades.length} trades. Net P&L: ${fmtPnl(totalNet)}.${pf !== null ? ` Profit factor: ${pf.toFixed(2)}x.` : ''}`,
    detail: `${wins.length}W / ${losses.length}L / ${bes.length} BE. Avg winner: ${fmtPnl(avgWin)}. Avg loser: ${fmtPnl(Math.abs(avgLoss))}. R ratio: ${losses.length && avgLoss !== 0 ? (Math.abs(avgWin / avgLoss)).toFixed(2) : 'N/A'}.`,
    rows,
    action: totalNet < 0
      ? 'Net P&L is negative. Focus on reducing loss size before increasing trade frequency.'
      : totalWr < 50
        ? `Below 50% WR but profitable — your winners outsized losers. Protect that R ratio.`
        : `Solid edge. Focus on process consistency to compound it.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

function analyzeConfluences(trades: Trade[]): Omit<AskResponse, 'question'> {
  const withConf = trades.filter(t => Array.isArray(t.confluences) && t.confluences.length > 0);
  if (withConf.length < 6) return {
    answer: 'Not enough confluence data.',
    detail: `Only ${withConf.length} trades have confluences tagged. Tag your setups consistently to identify your real edge.`,
    confidence: 'low', sampleSize: withConf.length, noData: withConf.length < 3,
  };
  const confMap: Record<string, Trade[]> = {};
  for (const t of withConf) {
    for (const c of (t.confluences ?? [])) {
      (confMap[c] ??= []).push(t);
    }
  }
  const rows = buildRows(confMap).filter(r => (confMap[r.label]?.length ?? 0) >= 3);
  if (!rows.length) return { answer: 'Not enough data per confluence tag.', detail: 'Need 3+ trades per tag to draw conclusions.', confidence: 'low', sampleSize: withConf.length };
  const best = rows[0];
  const worst = rows[rows.length - 1];
  return {
    answer: `Best confluence: "${best.label}" (${fmtPct(best.winRate)} WR, ${fmtPnl(best.netPnl)} net across ${best.trades} trades).`,
    detail: `Analysed ${rows.length} confluence tags across ${withConf.length} trades. "${worst.label}" is your weakest tag at ${fmtPct(worst.winRate)} WR and ${fmtPnl(worst.netPnl)} net.`,
    rows,
    action: `Focus on setups stacking "${best.label}". Consider removing "${worst.label}" as a standalone entry trigger.`,
    confidence: conf(withConf.length), sampleSize: withConf.length,
  };
}

function analyzeDuration(trades: Trade[]): Omit<AskResponse, 'question'> {
  const withDur = trades.filter(t => typeof t.trade_length_seconds === 'number' && (t.trade_length_seconds ?? 0) > 0);
  if (withDur.length < 6) return {
    answer: 'Not enough duration data.',
    detail: 'Log entry and exit times consistently to analyze trade duration.',
    confidence: 'low', sampleSize: withDur.length,
  };
  const wins = withDur.filter(t => (t.pnl ?? 0) > 0);
  const losses = withDur.filter(t => (t.pnl ?? 0) < 0);
  const avgMin = (ts: Trade[]) => ts.length ? ts.reduce((s, t) => s + (t.trade_length_seconds ?? 0), 0) / ts.length / 60 : 0;
  const fmtMin = (m: number) => m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`;
  const allAvg = avgMin(withDur);
  const winAvg = avgMin(wins);
  const lossAvg = avgMin(losses);
  const holdingLosses = losses.length > 0 && lossAvg > winAvg * 1.3;
  const rows: AskDataRow[] = [
    { label: `Wins (avg ${fmtMin(winAvg)})`, winRate: wr(wins), netPnl: net(wins), trades: wins.length, avgPnl: winAvg, tone: 'pos' },
    { label: `Losses (avg ${fmtMin(lossAvg)})`, winRate: wr(losses), netPnl: net(losses), trades: losses.length, avgPnl: lossAvg, tone: 'neg' },
  ];
  return {
    answer: `Average trade duration: ${fmtMin(allAvg)}. Winners: ${fmtMin(winAvg)}, losers: ${fmtMin(lossAvg)}.`,
    detail: `Based on ${withDur.length} trades with time data. ${holdingLosses ? `You hold losers ${fmtMin(lossAvg - winAvg)} longer than winners — a sign of letting losses run.` : `Winner/loser duration ratio looks healthy.`}`,
    rows,
    action: holdingLosses
      ? `Time-based rule: if a trade hasn't worked within ${fmtMin(winAvg)}, cut it.`
      : `Trade duration is healthy. Keep managing exits consistently.`,
    confidence: conf(withDur.length), sampleSize: withDur.length,
  };
}

function analyzeStreaks(trades: Trade[]): Omit<AskResponse, 'question'> {
  if (trades.length < 5) return { answer: 'Not enough trades to analyze streaks.', detail: 'Log more trades first.', confidence: 'low', sampleSize: trades.length };
  const sorted = [...trades].sort((a, b) => {
    const d = (a.trade_date ?? '').localeCompare(b.trade_date ?? '');
    return d !== 0 ? d : (a.trade_time ?? '').localeCompare(b.trade_time ?? '');
  });
  let maxW = 0, maxL = 0, curW = 0, curL = 0;
  for (const t of sorted) {
    if ((t.pnl ?? 0) > 0) { curW++; curL = 0; maxW = Math.max(maxW, curW); }
    else if ((t.pnl ?? 0) < 0) { curL++; curW = 0; maxL = Math.max(maxL, curL); }
    else { curW = 0; curL = 0; }
  }
  let curStreak = 0;
  let streakType: 'win' | 'loss' | 'none' = 'none';
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i].pnl ?? 0;
    if (streakType === 'none') {
      if (p > 0) { streakType = 'win'; curStreak = 1; }
      else if (p < 0) { streakType = 'loss'; curStreak = 1; }
      else break;
    } else if ((streakType === 'win' && p > 0) || (streakType === 'loss' && p < 0)) {
      curStreak++;
    } else break;
  }
  return {
    answer: `Longest win streak: ${maxW}. Longest loss streak: ${maxL}.${curStreak > 1 ? ` Currently on a ${curStreak}-trade ${streakType} streak.` : ''}`,
    detail: `Based on ${sorted.length} trades. ${maxL >= 4 ? `A ${maxL}-trade losing streak has occurred — identify what triggered it and whether overtrading or revenge trading was involved.` : 'Losing streaks are contained, which suggests good stopping discipline.'}`,
    action: maxL >= 3
      ? `After 2 consecutive losses, stop trading for the day. Your data shows ${maxL}-loss streaks happen.`
      : `Streaks are short — your stopping rules appear to be working.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

function analyzeByDirection(trades: Trade[]): Omit<AskResponse, 'question'> {
  const groups = groupBy(trades, t => t.direction ?? 'Unknown');
  const rows = buildRows(groups).filter(r => r.label !== 'Unknown');
  if (rows.length < 2) return {
    answer: 'Not enough directional data.',
    detail: 'Need both Long and Short trades to compare.',
    confidence: 'low', sampleSize: trades.length,
  };
  const best = rows[0];
  const worst = rows[rows.length - 1];
  return {
    answer: `You perform better ${best.label === 'Long' ? 'Long' : 'Short'} (${fmtPct(best.winRate)} WR, ${fmtPnl(best.netPnl)}) vs ${worst.label} (${fmtPct(worst.winRate)} WR, ${fmtPnl(worst.netPnl)}).`,
    detail: `${best.label}: ${best.trades} trades, ${fmtPct(best.winRate)} WR, avg ${fmtPnl(best.avgPnl)}/trade. ${worst.label}: ${worst.trades} trades, ${fmtPct(worst.winRate)} WR, avg ${fmtPnl(worst.avgPnl)}/trade.`,
    rows,
    action: worst.netPnl < -300 ? `Reduce size or screen more carefully on ${worst.label} trades — the data suggests a directional bias.` : `Both directions are competitive. Keep trading the setup, not the bias.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

function analyzeSummary(trades: Trade[]): Omit<AskResponse, 'question'> {
  if (!trades.length) return { answer: 'No trades logged yet.', detail: 'Import or log trades to get a summary.', confidence: 'low', sampleSize: 0, noData: true };
  const wins = trades.filter(t => (t.pnl ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl ?? 0) < 0);
  const totalWr = wr(trades);
  const totalNet = net(trades);
  const pf = losses.length && net(losses) !== 0 ? Math.abs(net(wins) / net(losses)) : null;
  const bySession = groupBy(trades, t => t.session ?? 'Other');
  const sessionRows = buildRows(bySession);
  const bestSession = sessionRows[0];
  const byDow = groupBy(trades, t => {
    const d = t.trade_date ? new Date(`${t.trade_date}T00:00:00`) : null;
    return d && !isNaN(d.getTime()) ? DOW[d.getDay()] : 'Unknown';
  });
  const dowRows = buildRows(byDow).filter(r => r.label !== 'Unknown');
  const bestDay = dowRows[0];
  const rows: AskDataRow[] = [
    { label: 'Win rate', winRate: totalWr, netPnl: totalNet, trades: trades.length, avgPnl: avgPnl(trades), tone: totalWr >= 50 ? 'pos' : 'neg' },
    ...(bestSession ? [{ ...bestSession, label: `Best session: ${bestSession.label}` }] : []),
    ...(bestDay ? [{ ...bestDay, label: `Best day: ${bestDay.label}` }] : []),
  ];
  return {
    answer: `${trades.length} trades. ${fmtPct(totalWr)} WR, ${fmtPnl(totalNet)} net P&L.${pf !== null ? ` Profit factor: ${pf.toFixed(2)}x.` : ''}`,
    detail: `${wins.length}W / ${losses.length}L. Avg winner: ${fmtPnl(wins.length ? avgPnl(wins) : 0)}, avg loser: ${fmtPnl(losses.length ? Math.abs(avgPnl(losses)) : 0)}.${bestSession ? ` Best session: ${bestSession.label} (${fmtPct(bestSession.winRate)} WR).` : ''}${bestDay ? ` Best day: ${bestDay.label}.` : ''}`,
    rows,
    action: totalNet > 0 && totalWr >= 50
      ? `You have a positive edge. Scale it — but only on your best sessions/days.`
      : totalNet < 0
        ? `Net P&L is negative. Prioritise reducing loss days before chasing more trades.`
        : `Edge is developing. Keep logging every session to get sharper AI feedback.`,
    confidence: conf(trades.length), sampleSize: trades.length,
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────
export function parseAndRespond(question: string, trades: Trade[]): AskResponse {
  const q = question.toLowerCase().trim();

  if (!trades.length) {
    return { question, answer: 'No trade data found.', detail: 'Import or log trades first to use Ask Flyxa.', confidence: 'low', sampleSize: 0, noData: true };
  }

  const wrap = (r: Omit<AskResponse, 'question'>): AskResponse => ({ ...r, question });

  if (matchesAny(q, ['session', 'london', 'new york', 'asia', 'pre market', 'premarket', 'ny session', 'when do i trade best', 'best time to trade', 'when should i trade', 'best session', 'worst session']))
    return wrap(analyzeBySession(trades));

  if (matchesAny(q, ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'day of week', 'best day', 'worst day', 'which day', 'what day', 'daily']))
    return wrap(analyzeByDayOfWeek(trades, q));

  if (matchesAny(q, ['long', 'short', 'direction', 'buying', 'selling', 'bias']))
    return wrap(analyzeByDirection(trades));

  if (matchesAny(q, ['nq', 'es ', ' cl ', 'ym ', 'gc ', 'eurusd', 'gbpusd', 'instrument', 'symbol', 'best symbol', 'which market', 'what to trade', 'what market', 'best instrument']))
    return wrap(analyzeBySymbol(trades, q));

  if (matchesAny(q, ['plan', 'rule', 'discipline', 'follow', 'off-plan', 'off plan', 'break my', 'stick to', 'adherence']))
    return wrap(analyzePlanAdherence(trades));

  if (matchesAny(q, ['emotion', 'mood', 'feel', 'calm', 'anxious', 'confident', 'frustrat', 'anger', 'fear', 'state of mind', 'mental', 'psychology']))
    return wrap(analyzeByEmotion(trades, q));

  if (matchesAny(q, ['overtrad', 'too many trade', 'trade too much', 'trade count', 'how many trades', 'number of trades', 'churn']))
    return wrap(analyzeOvertrading(trades));

  if (matchesAny(q, ['after a loss', 'after loss', 'losing trade', 'revenge', 'post-loss', 'post loss', 'when i lose', 'after i lose', 'recover']))
    return wrap(analyzePostLoss(trades));

  if (matchesAny(q, ['improv', 'getting better', 'progress', 'trend', 'better over time', 'worse over time', 'decline', 'recent', 'lately', 'am i getting']))
    return wrap(analyzeTrend(trades));

  if (matchesAny(q, ['confluence', 'setup', 'what setup', 'best setup', 'what signal', 'edge', 'catalyst']))
    return wrap(analyzeConfluences(trades));

  if (matchesAny(q, ['how long', 'duration', 'hold', 'time in trade', 'trade length', 'holding time', 'how quickly', 'how fast']))
    return wrap(analyzeDuration(trades));

  if (matchesAny(q, ['streak', 'consecutive', 'in a row', 'run of']))
    return wrap(analyzeStreaks(trades));

  if (matchesAny(q, ['win rate', 'winrate', 'winning percentage', 'how often', 'win percentage', 'profit factor', 'r multiple', 'r:r', 'reward']))
    return wrap(analyzeWinRate(trades));

  if (matchesAny(q, ['summary', 'overview', 'how am i doing', 'how have i done', 'overall', 'give me', 'tell me', 'my performance', 'my stats', 'my data', 'all time']))
    return wrap(analyzeSummary(trades));

  return {
    question,
    answer: "I couldn't parse that question.",
    detail: "Try asking: 'When do I trade best?', 'Do I follow my plan?', 'How does my emotion affect trading?', 'Am I overtrading?', 'Am I getting better?', 'What's my best setup?', or 'Give me a summary'.",
    confidence: 'low',
    sampleSize: trades.length,
    noData: true,
  };
}

export const QUICK_QUESTIONS = [
  'When do I trade best?',
  'Do I follow my plan?',
  'How does my emotion affect trading?',
  'Am I overtrading?',
  'Am I getting better?',
  'How do I trade after a loss?',
  'What\'s my best setup?',
  'What\'s my best instrument?',
  'Give me a summary',
  'What\'s my win rate?',
  'What\'s my best day of week?',
  'How long do I hold trades?',
];
