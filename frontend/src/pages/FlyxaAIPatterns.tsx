import { CSSProperties, useMemo, useState } from 'react';
import FlyxaNav from '../components/flyxa/FlyxaNav.js';
import { useTrades } from '../hooks/useTrades.js';
import { useAppSettings } from '../contexts/AppSettingsContext.js';
import { Trade } from '../types/index.js';

export type PatternType = 'Risk' | 'Edge' | 'Psychology' | 'Behaviour';
export type PatternStatus = 'Active' | 'Improving' | 'Confirmed' | 'Resolved';
export type SessionBucket = 'RTH open' | 'Overlap' | 'Midday';
export type TagSentiment = 'positive' | 'negative' | 'neutral';
type SortOption = 'impact' | 'recent' | 'frequency';

export type PatternSession = {
  date: string;
  pnl: number;
};

export type PatternItem = {
  id: string;
  type: PatternType;
  status: PatternStatus;
  resolvedFrom?: Exclude<PatternStatus, 'Resolved'>;
  title: string;
  description: string;
  firstSeen: string;
  sessionCount: number;
  totalPnl: number;
  tags: Array<{ label: string; sentiment: TagSentiment }>;
  confidence: number;
  instrument: string;
  session: SessionBucket;
  sessions: PatternSession[];
};

const colors = {
  d0: '#0e0d0d', d1: '#141312', d2: '#1a1917', d3: '#201f1d', d4: '#27251f',
  b0: 'rgba(255,255,255,0.07)', b1: 'rgba(255,255,255,0.12)',
  t0: '#e8e3dc', t1: '#8a8178', t2: '#5c5751',
  acc: '#f59e0b', grn: '#22d68a', red: '#f05252',
};

const tinyMetaLabelStyle: CSSProperties = {
  fontSize: 9.5, fontWeight: 500, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: colors.t2,
};

const cardBorder = `1px solid ${colors.b0}`;


function patternAccent(type: PatternType) {
  if (type === 'Risk') return '#ef4444';
  if (type === 'Edge') return '#22c55e';
  if (type === 'Psychology') return '#f59e0b';
  return '#4a9eff';
}

function statusStyles(status: PatternStatus): CSSProperties {
  if (status === 'Active') return { color: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)' };
  if (status === 'Improving') return { color: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)' };
  if (status === 'Confirmed') return { color: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.25)' };
  return { color: '#94a3b8', backgroundColor: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.25)' };
}

function tagStyles(sentiment: TagSentiment): CSSProperties {
  if (sentiment === 'negative') return { color: '#f87171', backgroundColor: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)' };
  if (sentiment === 'positive') return { color: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)' };
  return { color: '#94a3b8', backgroundColor: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)' };
}

function confidenceColor(confidence: number) {
  if (confidence >= 75) return '#22c55e';
  if (confidence >= 50) return '#f59e0b';
  return '#ef4444';
}

function filterPillClass(active: boolean) {
  if (active) return 'border-[#f59e0b] bg-[rgba(245,158,11,0.10)] text-[#f59e0b]';
  return 'border-white/[0.07] bg-[#1a1917] text-[#8a8178] hover:text-[#e8e3dc]';
}

type DetectedTimeFrame = '1M' | '3M' | '6M' | 'All';

function getDetectedPeriodStart(tf: DetectedTimeFrame): Date {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (tf === '1M') return new Date(today.getFullYear(), today.getMonth(), 1);
  if (tf === '3M') return new Date(today.getFullYear(), today.getMonth() - 2, 1);
  if (tf === '6M') return new Date(today.getFullYear(), today.getMonth() - 5, 1);
  return new Date(0); // All
}

function formatSignedCurrency(value: number): string {
  const formatted = Math.abs(value).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `-${formatted}`;
  return formatted;
}

function getSuggestion(pattern: PatternItem): string {
  const { id, type, status, sessionCount, totalPnl, instrument, title, sessions, tags } = pattern;

  // Extract win rate from tags (most reliable source — covers full sample)
  const wrTag = tags.find(t => t.label.includes('win rate'));
  const wr = wrTag ? parseInt(wrTag.label) : (sessions.length ? Math.round((sessions.filter(s => s.pnl > 0).length / sessions.length) * 100) : 0);

  // Compute avg win / avg loss / R:R from the sessions sample
  const sessWins = sessions.filter(s => s.pnl > 0);
  const sessLosses = sessions.filter(s => s.pnl < 0);
  const avgWin = sessWins.length ? sessWins.reduce((sum, s) => sum + s.pnl, 0) / sessWins.length : 0;
  const avgLoss = sessLosses.length ? Math.abs(sessLosses.reduce((sum, s) => sum + s.pnl, 0) / sessLosses.length) : 0;
  const rr = avgLoss > 0 && avgWin > 0 ? avgWin / avgLoss : null;

  // Trend: sessions sorted most-recent-first, compare last 3 vs older
  const recent = sessions.slice(0, Math.min(3, sessions.length));
  const older = sessions.slice(3);
  const recentAvg = recent.length ? recent.reduce((sum, s) => sum + s.pnl, 0) / recent.length : null;
  const olderAvg = older.length >= 2 ? older.reduce((sum, s) => sum + s.pnl, 0) / older.length : null;
  const trendWorsening = recentAvg !== null && olderAvg !== null && recentAvg < olderAvg;
  const trendImproving = recentAvg !== null && olderAvg !== null && recentAvg > olderAvg;

  const fmt = (v: number) => formatSignedCurrency(Math.abs(v));
  const stateMatch = title.match(/"([^"]+)"/);
  const state = stateMatch ? stateMatch[1] : null;

  // ── Symbol risk — single instrument audit ───────────────
  if (id.startsWith('auto-sym-risk-') && title.includes('entry quality')) {
    if (rr !== null && rr < 1.2 && sessLosses.length >= 2) {
      const breakevenWr = avgLoss > 0 ? Math.round((avgLoss / (avgWin + avgLoss)) * 100) : 0;
      return `${sessionCount} ${instrument} trades at ${wr}% win rate — but the deeper problem is the reward-to-risk. Your average winner from this sample is ${fmt(avgWin)} and your average loser is ${fmt(avgLoss)}, giving you roughly a ${rr.toFixed(1)}:1 ratio. At that ratio you'd need to win around ${breakevenWr}% of trades just to break even, which means you're fighting two problems simultaneously: a low win rate and undersized winners. Look at your winning trades specifically and ask whether you're exiting too early or whether the entry was structurally cleaner — that distinction tells you whether this is a management problem or a selection problem.`;
    }
    if (sessLosses.length > 0 && sessWins.length <= 1) {
      return `${sessionCount} ${instrument} trades with only ${sessWins.length} winner in this sample. That's not a bad run — at this ratio the entry approach isn't producing an edge. Go through each losing trade and write down one thing that was present at entry that you'd now flag as a warning sign. You're looking for the variable that appears on losers but not on your winners. Once you find it, that becomes your first filter before any ${instrument} entry.`;
    }
    return `${sessionCount} trades on ${instrument} at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}. Since ${instrument} is your primary instrument, the data can't tell you it's the wrong market — it can only tell you something in the approach isn't working. Compare your ${sessWins.length} winning trade${sessWins.length !== 1 ? 's' : ''} to your ${sessLosses.length} losing trade${sessLosses.length !== 1 ? 's' : ''}: entry timing, confluence quality, emotional state, and whether price was at a key level or in the middle of range. The edge is in what separates those two groups.`;
  }

  // ── Symbol risk — multi-instrument (underperformer) ─────────────
  if (id.startsWith('auto-sym-risk-')) {
    const trendNote = trendWorsening
      ? ` Your most recent ${recent.length} ${instrument} trades are also your worst (avg ${formatSignedCurrency(recentAvg!)} each), so this isn't stabilising.`
      : trendImproving
        ? ` Your last ${recent.length} trades show slight improvement (avg ${formatSignedCurrency(recentAvg!)}), but not enough to offset the overall picture.`
        : '';
    const rrNote = rr !== null ? ` Average winner ${fmt(avgWin)}, average loser ${fmt(avgLoss)} — a ${rr.toFixed(1)}:1 R:R ratio.` : '';
    return `${sessionCount} ${instrument} trades at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}.${rrNote}${trendNote} The useful question isn't whether to cut ${instrument}, it's whether you're applying the same entry conditions to ${instrument} that work on your other instruments or whether you've drifted. Take the last 3 ${instrument} losers and compare them to 3 winners on your better-performing instruments — look at where in structure you entered, how wide the stop was, and what your state was. That comparison is more useful than any general rule change.`;
  }

  // ── Symbol edge ─────────────────────────────────────────────────
  if (id.startsWith('auto-sym-edge-')) {
    const rrNote = rr !== null ? ` Average winner ${fmt(avgWin)} against average loser ${fmt(avgLoss)} — ${rr.toFixed(1)}:1 ratio, which compounds the win rate advantage.` : '';
    const trendNote = trendImproving
      ? ` Your most recent sessions are tracking above your earlier average (${formatSignedCurrency(recentAvg!)} vs ${formatSignedCurrency(olderAvg!)}), so the edge is building.`
      : trendWorsening
        ? ` One thing to watch: your most recent ${recent.length} sessions are averaging ${formatSignedCurrency(recentAvg!)} — lower than earlier. Edges can drift; keep monitoring whether conditions are changing.`
        : '';
    return `${sessionCount} ${instrument} trades at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}.${rrNote}${trendNote} The edge is statistically real at this sample size — the risk now is diluting it by entering lower-conviction versions of the same trade to stay active. Write down the specific conditions that were present in your clearest winners — not just "structure looked good" but the actual criteria. Anything that doesn't match those exactly is a different trade with a different (lower) expectation.`;
  }

  // ── Session risk ─────────────────────────────────────────────────
  if (id.startsWith('auto-sess-risk-')) {
    const sessName = id.replace('auto-sess-risk-', '');
    const estLosses = Math.round(sessionCount * (1 - wr / 100));
    const trendNote = trendWorsening ? ` Your most recent ${sessName} sessions are averaging ${formatSignedCurrency(recentAvg!)} — it's trending in the wrong direction.` : '';
    return `${sessionCount} trades during ${sessName}, ${wr}% win rate, ${formatSignedCurrency(totalPnl)}.${trendNote} Roughly ${estLosses} of your ${sessionCount} entries here are losing. Before you reduce activity, check whether the losses cluster in a specific part of the session — first 15 minutes, around news events, or later when liquidity drops. If they do cluster, the fix is a time-based filter, not a blanket reduction. If they're spread evenly, the issue is likely the trade plan being applied in conditions that don't support it.`;
  }

  // ── Session edge ─────────────────────────────────────────────────
  if (id.startsWith('auto-sess-edge-')) {
    const sessName = id.replace('auto-sess-edge-', '');
    const rrNote = rr !== null ? ` Your sample shows ${fmt(avgWin)} average winners against ${fmt(avgLoss)} average losers — a ${rr.toFixed(1)}:1 ratio.` : '';
    return `${sessionCount} ${sessName} trades at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}.${rrNote} The edge is there — now look at whether your ${sessLosses.length} losers in this session share anything in common: entry time within the session, whether you were already up or down on the day, or specific market conditions. Knowing what turns a ${sessName} trade from a winner to a loser is what takes this edge from ${wr}% to something more consistent.`;
  }

  // ── Psychology risk ─────────────────────────────────────────────
  if (id.startsWith('auto-psych-risk-') && state) {
    const perTrade = sessionCount > 0 ? Math.abs(totalPnl / sessionCount) : 0;
    const rrNote = rr !== null ? ` Your average loss in this state (${fmt(avgLoss)}) is ${avgWin > 0 ? `larger than your average winner (${fmt(avgWin)})` : 'not being offset by meaningful winners'}.` : '';
    return `${sessionCount} trades while "${state}" at ${wr}% win rate and ${formatSignedCurrency(totalPnl)} — averaging ${formatSignedCurrency(perTrade)} lost per trade in this state.${rrNote} This is not something you can trade through with more discipline at entry — the state itself is already degrading your decision-making before you place the order. The rule needs to be pre-entry: name your emotional state before each session. If it's "${state}", your only trade is to wait 15 minutes and reassess. If it's still there, the session is closed. ${sessionCount} trades is enough data to make this a hard rule, not a guideline.`;
  }

  // ── Psychology edge ─────────────────────────────────────────────
  if (id.startsWith('auto-psych-edge-') && state) {
    return `${sessionCount} trades while "${state}" at ${wr}% win rate and ${formatSignedCurrency(totalPnl)} — your best-performing emotional context by a meaningful margin. The practical question is what produces this state reliably. Think back to the sessions where you felt "${state}": what did you do the night before, how much preparation had you done, did you exercise, what time did you start? Even identifying one or two consistent inputs gives you something to engineer rather than just hope for.`;
  }

  // ── Day-of-week ──────────────────────────────────────────────────
  if (id.startsWith('auto-dow-risk-')) {
    const day = id.replace('auto-dow-risk-', '');
    return `${sessionCount} ${day} trades at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}. Something about how you approach ${day}s is producing worse outcomes than your other days. This doesn't mean ${day} has less edge — it usually means your preparation or mental state is different. Think back to the last 3 ${day} sessions: were you more rushed, trading out of sequence, or carrying something from the weekend or end-of-week into the open? One practical test: start your next ${day} with a smaller position, treat the first trade as diagnostic, and see if the pattern holds at half size.`;
  }
  if (id.startsWith('auto-dow-edge-')) {
    const day = id.replace('auto-dow-edge-', '');
    return `${sessionCount} ${day} trades at ${wr}% win rate and ${formatSignedCurrency(totalPnl)} — your best performing day of the week. Think about what's structurally different about your ${day} sessions: are you better rested, have fewer distractions, or is the market character itself better suited to your style? Whatever's producing this, don't take it for granted. Document specifically what you do on a typical ${day} morning and treat it as a repeatable template.`;
  }

  // ── Time-of-day ──────────────────────────────────────────────────
  if (id.startsWith('auto-hour-risk-')) {
    const hour = id.replace('auto-hour-risk-', '');
    return `${sessionCount} trades entered around ${hour} at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}. This time window is a consistent execution problem. The most common reason for a specific hour underperforming is that the trader is either chasing entries after a slow period or forcing activity before a natural close. Look at the specific entry context — were these trades planned, or were they taken because something moved and you felt you had to act? If most are reactive, a simple rule (no new entries between ${hour} and 30 minutes later) is worth testing.`;
  }

  // ── Overtrading ──────────────────────────────────────────────────
  if (id === 'auto-behav-overtrade') {
    const wrTagLow = tags.find(t => t.label.startsWith('1-2 trades'));
    const wrTagHigh = tags.find(t => t.label.startsWith('4+ trades'));
    const lowWrStr = wrTagLow ? wrTagLow.label : '';
    const highWrStr = wrTagHigh ? wrTagHigh.label : '';
    return `${lowWrStr} vs ${highWrStr}. The data says your edge is narrow, not broad — it lives in your best 1 or 2 trades per session, not in trading volume. Most traders overtrade because they feel uncomfortable watching the market move without a position. That discomfort is a cost you're currently paying in win rate. The fix is not "trade fewer" as a guideline — it's a hard cap: after your second trade each day, require the next entry to score meaningfully higher on your pre-trade checklist than a normal entry. That filter will kill 70% of the bad fourth and fifth trades automatically.`;
  }

  // ── Off-plan trades ──────────────────────────────────────────────
  if (id === 'auto-behav-offplan') {
    const onTag = tags.find(t => t.label.startsWith('On-plan'));
    const offTag = tags.find(t => t.label.startsWith('Off-plan'));
    return `${onTag?.label ?? ''} vs ${offTag?.label ?? ''}. Your on-plan and off-plan trades are two different strategies with meaningfully different edge. The off-plan group isn't just "slightly worse" — it's a net negative that is directly reducing what your on-plan trades earn. Off-plan entries almost always come from one of three triggers: boredom after a winner, recovery attempt after a loser, or a live move you weren't positioned for. Identify which one accounts for most of your off-plan trades — that's the specific situation to build a rule around, not a general "stay in your plan" commitment.`;
  }

  // ── Post-loss behavior ───────────────────────────────────────────
  if (id === 'auto-behav-postloss') {
    const overallTag = tags.find(t => t.label.startsWith('Overall'));
    const postTag = tags.find(t => t.label.startsWith('Post-loss'));
    return `${overallTag?.label ?? ''} overall, but ${postTag?.label ?? ''} on the trade immediately following a losing trade. Your decision-making is reliably degraded in the 5-15 minutes after a loss — this is extremely common and the data proves it's happening to you specifically. The rule this suggests is not complicated: after any losing trade, do not take the next entry for at least 10 minutes regardless of how clean it looks. Use that time to restate your session plan. If the next entry still meets your criteria after the pause, take it. Roughly half the time, you'll decide not to — and based on this data, that's the right call.`;
  }

  // ── Generic fallback ────────────────────────────────────────────
  const rrNote = rr !== null ? ` Average winner ${fmt(avgWin)}, average loser ${fmt(avgLoss)} (${rr.toFixed(1)}:1 ratio).` : '';
  if (type === 'Risk' || status === 'Active') {
    return `${sessionCount} occurrences at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}.${rrNote} The pattern is repeating — identify the one variable present in all instances and define a specific rule around it before the next occurrence.`;
  }
  return `${sessionCount} occurrences at ${wr}% win rate and ${formatSignedCurrency(totalPnl)}.${rrNote} Document the exact conditions that produce this outcome so you can distinguish when it's valid from when it's noise.`;
}

function detectPatternsFromTrades(trades: Trade[], tf: DetectedTimeFrame): PatternItem[] {
  if (!trades.length) return [];
  const cutoff = getDetectedPeriodStart(tf);
  const filtered = trades.filter(t => {
    const d = t.trade_date ? new Date(`${t.trade_date}T00:00:00`) : (t.created_at ? new Date(t.created_at) : null);
    return d && d >= cutoff;
  });
  if (!filtered.length) return [];

  const patterns: PatternItem[] = [];
  const now = new Date().toISOString().slice(0, 10);

  const groupBy = <K extends string>(arr: Trade[], key: (t: Trade) => K) => {
    const map = new Map<K, Trade[]>();
    arr.forEach(t => { const k = key(t); map.set(k, [...(map.get(k) ?? []), t]); });
    return map;
  };

  const summariseGroup = (group: Trade[]) => {
    const winners = group.filter(t => Number(t.pnl) > 0);
    const netPnl = group.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
    return {
      count: group.length,
      netPnl,
      winRate: group.length ? (winners.length / group.length) * 100 : 0,
      sessions: group
        .map(t => ({ date: t.trade_date ?? now, pnl: Number(t.pnl ?? 0) }))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 8),
      firstSeen: group.map(t => t.trade_date ?? now).sort()[0] ?? now,
    };
  };

  // ── Symbol patterns ──────────────────────────────────────────────
  const symbolGroups = groupBy(filtered, t => (t.symbol?.trim() || 'Unknown'));
  // Count symbols that have enough trades to be meaningful
  const meaningfulSymbolCount = Array.from(symbolGroups.entries())
    .filter(([sym, g]) => sym !== 'Unknown' && g.length >= 4).length;

  symbolGroups.forEach((group, symbol) => {
    if (group.length < 4 || symbol === 'Unknown') return;
    const s = summariseGroup(group);
    const wr = Math.round(s.winRate);
    const confidence = Math.min(95, Math.round(30 + (group.length / 2) * 10 + Math.abs(s.winRate - 50)));

    if (meaningfulSymbolCount <= 1) {
      // Single-instrument trader: comparison is impossible — "X is unprofitable" just
      // restates the P&L the user can already see. Instead surface WHAT to fix.
      if (wr < 35 && s.netPnl < 0) {
        patterns.push({
          id: `auto-sym-risk-${symbol}`,
          type: 'Risk',
          status: 'Active',
          title: `${symbol} entry quality needs a full audit`,
          description: `${symbol} is your primary instrument, so a ${wr}% win rate and ${formatSignedCurrency(s.netPnl)} P&L points to an entry or execution problem — not the instrument itself. Dig into which specific confluences, times of entry, or emotional states are present on your losing trades vs winners. The answer is in the variables, not the ticker.`,
          firstSeen: s.firstSeen,
          sessionCount: group.length,
          totalPnl: s.netPnl,
          tags: [{ label: `${group.length} trades`, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'negative' }, { label: 'Review entries', sentiment: 'neutral' }],
          confidence,
          instrument: symbol,
          session: 'RTH open',
          sessions: s.sessions,
        });
      } else if (wr >= 60 && s.netPnl > 0 && group.length >= 5) {
        patterns.push({
          id: `auto-sym-edge-${symbol}`,
          type: 'Edge',
          status: 'Confirmed',
          title: `${symbol} edge is confirmed — protect your conditions`,
          description: `${group.length} trades on ${symbol} returned ${formatSignedCurrency(s.netPnl)} at ${wr}% win rate. Your edge on this instrument is holding. The priority now is keeping entry conditions tight — avoid adding new patterns or expanding into unfamiliar conditions while the edge is working.`,
          firstSeen: s.firstSeen,
          sessionCount: group.length,
          totalPnl: s.netPnl,
          tags: [{ label: `${group.length} trades`, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'positive' }],
          confidence,
          instrument: symbol,
          session: 'RTH open',
          sessions: s.sessions,
        });
      }
      return;
    }

    // Multiple instruments — comparison is meaningful
    if (wr < 35 && s.netPnl < 0) {
      patterns.push({
        id: `auto-sym-risk-${symbol}`,
        type: 'Risk',
        status: 'Active',
        title: `${symbol} is underperforming your other instruments`,
        description: `Across ${group.length} trades, ${symbol} returned ${formatSignedCurrency(s.netPnl)} (${wr}% win rate) — the weakest performer in your instrument mix. Consider pausing ${symbol} trades until you can isolate what's breaking down.`,
        firstSeen: s.firstSeen,
        sessionCount: group.length,
        totalPnl: s.netPnl,
        tags: [{ label: `${group.length} trades`, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'negative' }],
        confidence,
        instrument: symbol,
        session: 'RTH open',
        sessions: s.sessions,
      });
    } else if (wr >= 60 && s.netPnl > 0 && group.length >= 5) {
      patterns.push({
        id: `auto-sym-edge-${symbol}`,
        type: 'Edge',
        status: 'Confirmed',
        title: `${symbol} is your strongest instrument`,
        description: `${group.length} trades on ${symbol} yielded ${formatSignedCurrency(s.netPnl)} at ${wr}% win rate — your top-performing instrument over this period. Keep conditions tight and prioritise ${symbol} entries.`,
        firstSeen: s.firstSeen,
        sessionCount: group.length,
        totalPnl: s.netPnl,
        tags: [{ label: `${group.length} trades`, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'positive' }],
        confidence,
        instrument: symbol,
        session: 'RTH open',
        sessions: s.sessions,
      });
    }
  });

  // ── Session patterns ─────────────────────────────────────────────
  const sessionGroups = groupBy(filtered, t => (t.session ?? 'Other') as string);
  // Count meaningful sessions (enough trades, not Other)
  const meaningfulSessionCount = Array.from(sessionGroups.entries())
    .filter(([sess, g]) => sess !== 'Other' && g.length >= 5).length;

  sessionGroups.forEach((group, session) => {
    if (group.length < 5 || session === 'Other') return;
    const s = summariseGroup(group);
    const wr = Math.round(s.winRate);
    const confidence = Math.min(92, Math.round(25 + (group.length / 3) * 10 + Math.abs(s.winRate - 50)));

    // Single-session trader: "X is weakest window" when X is the only window is
    // a tautology — it tells the trader nothing they can act on.
    // Suppress session comparison entirely; other pattern types (emotional state,
    // day-of-week, confluence) will surface the real variables.
    if (meaningfulSessionCount <= 1) return;

    if (wr < 40 && s.netPnl < 0) {
      patterns.push({
        id: `auto-sess-risk-${session}`,
        type: 'Risk',
        status: 'Active',
        title: `${session} is dragging your overall performance`,
        description: `Your ${session} trades returned ${formatSignedCurrency(s.netPnl)} across ${group.length} trades (${wr}% win rate) — the weakest session in your mix. Consider reducing size or skipping entries during ${session} until execution improves.`,
        firstSeen: s.firstSeen,
        sessionCount: group.length,
        totalPnl: s.netPnl,
        tags: [{ label: session, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'negative' }],
        confidence,
        instrument: 'All',
        session: 'RTH open',
        sessions: s.sessions,
      });
    } else if (wr >= 58 && s.netPnl > 0 && group.length >= 6) {
      patterns.push({
        id: `auto-sess-edge-${session}`,
        type: 'Edge',
        status: 'Confirmed',
        title: `${session} is your strongest session`,
        description: `${group.length} trades during ${session} returned ${formatSignedCurrency(s.netPnl)} at ${wr}% win rate — your top-performing session. Protect this edge with consistent sizing and avoid diluting it with lower-conviction entries.`,
        firstSeen: s.firstSeen,
        sessionCount: group.length,
        totalPnl: s.netPnl,
        tags: [{ label: session, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'positive' }],
        confidence,
        instrument: 'All',
        session: 'RTH open',
        sessions: s.sessions,
      });
    }
  });

  // ── Emotional state patterns ─────────────────────────────────────
  const stateGroups = groupBy(filtered, t => t.emotional_state || 'Unspecified');
  stateGroups.forEach((group, state) => {
    if (group.length < 3 || state === 'Unspecified') return;
    const s = summariseGroup(group);
    const confidence = Math.min(90, Math.round(20 + (group.length / 2) * 10 + Math.abs(s.winRate - 50)));
    if (s.winRate < 38 && s.netPnl < 0) {
      patterns.push({
        id: `auto-psych-risk-${state}`,
        type: 'Psychology',
        status: 'Active',
        title: `Trading when "${state}" is costing you money`,
        description: `${group.length} trades logged while feeling "${state}" returned ${formatSignedCurrency(s.netPnl)} at ${Math.round(s.winRate)}% win rate. This emotional state correlates with underperformance — consider a no-trade rule when you feel this way.`,
        firstSeen: s.firstSeen,
        sessionCount: group.length,
        totalPnl: s.netPnl,
        tags: [{ label: `"${state}"`, sentiment: 'negative' }, { label: `${group.length} trades`, sentiment: 'neutral' }],
        confidence,
        instrument: 'All',
        session: 'RTH open',
        sessions: s.sessions,
      });
    } else if (s.winRate >= 60 && s.netPnl > 0 && group.length >= 4) {
      patterns.push({
        id: `auto-psych-edge-${state}`,
        type: 'Psychology',
        status: 'Confirmed',
        title: `"${state}" is your optimal trading state`,
        description: `${group.length} trades when feeling "${state}" returned ${formatSignedCurrency(s.netPnl)} at ${Math.round(s.winRate)}% win rate. This emotional state correlates with your best execution — note the conditions that produce it.`,
        firstSeen: s.firstSeen,
        sessionCount: group.length,
        totalPnl: s.netPnl,
        tags: [{ label: `"${state}"`, sentiment: 'positive' }, { label: `${group.length} trades`, sentiment: 'neutral' }],
        confidence,
        instrument: 'All',
        session: 'RTH open',
        sessions: s.sessions,
      });
    }
  });

  // ── Day-of-week patterns ─────────────────────────────────────────
  const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dowGroups = groupBy(filtered, t => {
    const d = t.trade_date ? new Date(`${t.trade_date}T00:00:00`) : null;
    return d ? (DOW_NAMES[d.getDay()] ?? 'Unknown') : 'Unknown';
  });
  const meaningfulDowCount = Array.from(dowGroups.entries())
    .filter(([day, g]) => day !== 'Unknown' && g.length >= 4).length;
  if (meaningfulDowCount >= 3) {
    dowGroups.forEach((group, day) => {
      if (group.length < 4 || day === 'Unknown') return;
      const s = summariseGroup(group);
      const wr = Math.round(s.winRate);
      const confidence = Math.min(88, Math.round(20 + group.length * 4 + Math.abs(s.winRate - 50)));
      if (wr < 35 && s.netPnl < 0 && group.length >= 5) {
        patterns.push({
          id: `auto-dow-risk-${day}`,
          type: 'Behaviour',
          status: 'Active',
          title: `${day}s are your worst trading day`,
          description: `${group.length} ${day} trades returned ${formatSignedCurrency(s.netPnl)} at ${wr}% win rate — significantly below your other days. Consider reducing size or standing aside on ${day}s until you understand what's breaking down.`,
          firstSeen: s.firstSeen, sessionCount: group.length, totalPnl: s.netPnl,
          tags: [{ label: day, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'negative' }, { label: `${group.length} trades`, sentiment: 'neutral' }],
          confidence, instrument: 'All', session: 'RTH open', sessions: s.sessions,
        });
      } else if (wr >= 65 && s.netPnl > 0 && group.length >= 4) {
        patterns.push({
          id: `auto-dow-edge-${day}`,
          type: 'Behaviour',
          status: 'Confirmed',
          title: `${day}s are your strongest trading day`,
          description: `${group.length} ${day} trades returned ${formatSignedCurrency(s.netPnl)} at ${wr}% win rate — your best day of the week. Document what makes your ${day} sessions different and protect this edge.`,
          firstSeen: s.firstSeen, sessionCount: group.length, totalPnl: s.netPnl,
          tags: [{ label: day, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'positive' }, { label: `${group.length} trades`, sentiment: 'neutral' }],
          confidence, instrument: 'All', session: 'RTH open', sessions: s.sessions,
        });
      }
    });
  }

  // ── Time-of-day patterns ─────────────────────────────────────────
  const hourGroups = groupBy(filtered, t => {
    if (!t.trade_time) return 'Unknown';
    const h = parseInt(t.trade_time.split(':')[0], 10);
    if (!Number.isFinite(h)) return 'Unknown';
    return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  });
  const meaningfulHourCount = Array.from(hourGroups.entries())
    .filter(([h, g]) => h !== 'Unknown' && g.length >= 4).length;
  if (meaningfulHourCount >= 3) {
    hourGroups.forEach((group, hour) => {
      if (group.length < 4 || hour === 'Unknown') return;
      const s = summariseGroup(group);
      const wr = Math.round(s.winRate);
      const confidence = Math.min(85, Math.round(15 + group.length * 5 + Math.abs(s.winRate - 50)));
      if (wr < 33 && s.netPnl < 0 && group.length >= 5) {
        patterns.push({
          id: `auto-hour-risk-${hour}`,
          type: 'Behaviour',
          status: 'Active',
          title: `${hour} entries are a consistent leak`,
          description: `${group.length} trades entered around ${hour} at ${wr}% win rate and ${formatSignedCurrency(s.netPnl)}. This hour is underperforming your overall average — a time-based filter here is worth testing.`,
          firstSeen: s.firstSeen, sessionCount: group.length, totalPnl: s.netPnl,
          tags: [{ label: hour, sentiment: 'neutral' }, { label: `${wr}% win rate`, sentiment: 'negative' }, { label: `${group.length} trades`, sentiment: 'neutral' }],
          confidence, instrument: 'All', session: 'RTH open', sessions: s.sessions,
        });
      }
    });
  }

  // ── Overtrading detection ─────────────────────────────────────────
  const tradesByDate = groupBy(filtered, t => t.trade_date ?? now);
  const dayStats = Array.from(tradesByDate.entries()).map(([date, ts]) => ({
    date,
    count: ts.length,
    winRate: ts.filter(t => Number(t.pnl) > 0).length / ts.length * 100,
    pnl: ts.reduce((s, t) => s + Number(t.pnl ?? 0), 0),
  }));
  if (dayStats.length >= 8) {
    const highVolDays = dayStats.filter(d => d.count >= 4);
    const lowVolDays = dayStats.filter(d => d.count <= 2);
    if (highVolDays.length >= 3 && lowVolDays.length >= 3) {
      const highWr = highVolDays.reduce((s, d) => s + d.winRate, 0) / highVolDays.length;
      const lowWr = lowVolDays.reduce((s, d) => s + d.winRate, 0) / lowVolDays.length;
      const highPnlPerDay = highVolDays.reduce((s, d) => s + d.pnl, 0) / highVolDays.length;
      const lowPnlPerDay = lowVolDays.reduce((s, d) => s + d.pnl, 0) / lowVolDays.length;
      if (lowWr > highWr + 15 && lowPnlPerDay > highPnlPerDay) {
        patterns.push({
          id: 'auto-behav-overtrade',
          type: 'Behaviour',
          status: 'Active',
          title: 'Win rate drops sharply on high-volume days',
          description: `Days with 1-2 trades: ${Math.round(lowWr)}% win rate. Days with 4+ trades: ${Math.round(highWr)}% win rate. Your edge is concentrated in selective entries — adding more trades per session actively reduces it.`,
          firstSeen: dayStats[dayStats.length - 1].date,
          sessionCount: highVolDays.length,
          totalPnl: highVolDays.reduce((s, d) => s + d.pnl, 0) - lowVolDays.reduce((s, d) => s + d.pnl, 0),
          tags: [
            { label: `1-2 trades: ${Math.round(lowWr)}% WR`, sentiment: 'positive' },
            { label: `4+ trades: ${Math.round(highWr)}% WR`, sentiment: 'negative' },
          ],
          confidence: Math.min(90, Math.round(40 + highVolDays.length * 5)),
          instrument: 'All', session: 'RTH open',
          sessions: highVolDays.slice(-6).map(d => ({ date: d.date, pnl: d.pnl })),
        });
      }
    }
  }

  // ── Plan adherence delta ──────────────────────────────────────────
  const planLogged = filtered.filter(t => typeof t.followed_plan === 'boolean');
  if (planLogged.length >= 6) {
    const onPlan = planLogged.filter(t => t.followed_plan === true);
    const offPlan = planLogged.filter(t => t.followed_plan === false);
    if (onPlan.length >= 3 && offPlan.length >= 3) {
      const onWr = (onPlan.filter(t => Number(t.pnl) > 0).length / onPlan.length) * 100;
      const offWr = (offPlan.filter(t => Number(t.pnl) > 0).length / offPlan.length) * 100;
      const offPnl = offPlan.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      const onPnl = onPlan.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      if (onWr > offWr + 15 && offPnl < 0) {
        patterns.push({
          id: 'auto-behav-offplan',
          type: 'Behaviour',
          status: 'Active',
          title: 'Off-plan trades are a quantified drag',
          description: `${onPlan.length} on-plan trades: ${Math.round(onWr)}% win rate, ${formatSignedCurrency(onPnl)}. ${offPlan.length} off-plan trades: ${Math.round(offWr)}% win rate, ${formatSignedCurrency(offPnl)}. Removing off-plan entries entirely would improve your result by ${formatSignedCurrency(Math.abs(offPnl))}.`,
          firstSeen: planLogged.map(t => t.trade_date ?? now).sort()[0] ?? now,
          sessionCount: offPlan.length,
          totalPnl: offPnl,
          tags: [
            { label: `On-plan: ${Math.round(onWr)}% WR`, sentiment: 'positive' },
            { label: `Off-plan: ${Math.round(offWr)}% WR`, sentiment: 'negative' },
            { label: formatSignedCurrency(offPnl), sentiment: 'negative' },
          ],
          confidence: Math.min(92, Math.round(30 + planLogged.length * 3)),
          instrument: 'All', session: 'RTH open',
          sessions: offPlan.slice(-6).map(t => ({ date: t.trade_date ?? now, pnl: Number(t.pnl ?? 0) })),
        });
      }
    }
  }

  // ── Post-loss behavior ────────────────────────────────────────────
  const sortedByTime = [...filtered].sort((a, b) => {
    const ak = `${a.trade_date ?? ''}${a.trade_time ?? ''}`;
    const bk = `${b.trade_date ?? ''}${b.trade_time ?? ''}`;
    return ak.localeCompare(bk);
  });
  if (sortedByTime.length >= 8) {
    const afterLoss: Trade[] = [];
    for (let i = 1; i < sortedByTime.length; i++) {
      const prev = sortedByTime[i - 1];
      const curr = sortedByTime[i];
      if (prev.trade_date !== curr.trade_date) continue;
      if (Number(prev.pnl) < 0) afterLoss.push(curr);
    }
    if (afterLoss.length >= 4) {
      const postLossWr = (afterLoss.filter(t => Number(t.pnl) > 0).length / afterLoss.length) * 100;
      const postLossPnl = afterLoss.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
      const overallWr = (filtered.filter(t => Number(t.pnl) > 0).length / filtered.length) * 100;
      if (postLossWr < overallWr - 15 && postLossPnl < 0) {
        patterns.push({
          id: 'auto-behav-postloss',
          type: 'Behaviour',
          status: 'Active',
          title: 'First trade after a loss underperforms',
          description: `Your overall win rate is ${Math.round(overallWr)}%, but the trade immediately following a losing trade wins only ${Math.round(postLossWr)}% of the time across ${afterLoss.length} occurrences (${formatSignedCurrency(postLossPnl)}). A mandatory pause after any loss would remove this leak.`,
          firstSeen: sortedByTime[0].trade_date ?? now,
          sessionCount: afterLoss.length,
          totalPnl: postLossPnl,
          tags: [
            { label: `Overall: ${Math.round(overallWr)}% WR`, sentiment: 'neutral' },
            { label: `Post-loss: ${Math.round(postLossWr)}% WR`, sentiment: 'negative' },
            { label: `${afterLoss.length} occurrences`, sentiment: 'neutral' },
          ],
          confidence: Math.min(88, Math.round(25 + afterLoss.length * 5)),
          instrument: 'All', session: 'RTH open',
          sessions: afterLoss.slice(-6).map(t => ({ date: t.trade_date ?? now, pnl: Number(t.pnl ?? 0) })),
        });
      }
    }
  }

  return patterns.sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
}

export default function FlyxaAIPatterns() {
  const { trades } = useTrades();
  const { filterTradesBySelectedAccount } = useAppSettings();
  const accountTrades = useMemo(
    () => (filterTradesBySelectedAccount(trades) as Trade[]).filter(Boolean),
    [filterTradesBySelectedAccount, trades]
  );

  const [patterns, setPatterns] = useState<PatternItem[]>([]);
  const [expandedPatternId, setExpandedPatternId] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [selectedType, setSelectedType] = useState<'All' | PatternType>('All');
  const [selectedSession, setSelectedSession] = useState<'All' | SessionBucket>('All');
  const [sortBy, setSortBy] = useState<SortOption>('impact');
  const [detectedTf, setDetectedTf] = useState<DetectedTimeFrame>('3M');

  const detectedPatterns = useMemo(
    () => detectPatternsFromTrades(accountTrades, detectedTf),
    [accountTrades, detectedTf]
  );

  const filteredPatterns = useMemo(() => {
    const base = patterns.filter(pattern => pattern.status !== 'Resolved');
    const byType = selectedType === 'All' ? base : base.filter(pattern => pattern.type === selectedType);
    const bySession = selectedSession === 'All' ? byType : byType.filter(pattern => pattern.session === selectedSession);
    return [...bySession].sort((a, b) => {
      if (sortBy === 'impact') return Math.abs(b.totalPnl) - Math.abs(a.totalPnl);
      if (sortBy === 'frequency') return b.sessionCount - a.sessionCount;
      return new Date(b.firstSeen).getTime() - new Date(a.firstSeen).getTime();
    });
  }, [patterns, selectedType, selectedSession, sortBy]);

  const costingPatterns = filteredPatterns.filter(pattern => pattern.totalPnl < 0);
  const earningPatterns = filteredPatterns.filter(pattern => pattern.totalPnl >= 0);
  const resolvedPatterns = patterns.filter(pattern => pattern.status === 'Resolved');

  const summary = useMemo(() => {
    const activePatterns = filteredPatterns;
    const totalLost = activePatterns.filter(p => p.totalPnl < 0).reduce((sum, p) => sum + p.totalPnl, 0);
    const totalGained = activePatterns.filter(p => p.totalPnl > 0).reduce((sum, p) => sum + p.totalPnl, 0);
    return {
      totalLost,
      riskCount: activePatterns.filter(p => p.type === 'Risk').length,
      totalGained,
      edgeCount: activePatterns.filter(p => p.type === 'Edge' && p.status === 'Confirmed').length,
      improvingCount: activePatterns.filter(p => p.status === 'Improving').length,
      resolvedCount: resolvedPatterns.length,
    };
  }, [filteredPatterns, resolvedPatterns.length]);

  const togglePattern = (patternId: string) => {
    setExpandedPatternId(current => current === patternId ? null : patternId);
  };

  const markResolved = (patternId: string) => {
    setPatterns(current => current.map(pattern => {
      if (pattern.id !== patternId || pattern.status === 'Resolved') {
        return pattern;
      }

      return {
        ...pattern,
        resolvedFrom: pattern.status,
        status: 'Resolved',
      };
    }));
    setExpandedPatternId(null);
  };

  const unresolvePattern = (patternId: string) => {
    setPatterns(current => current.map(pattern => {
      if (pattern.id !== patternId || pattern.status !== 'Resolved') {
        return pattern;
      }

      return {
        ...pattern,
        status: pattern.resolvedFrom ?? 'Active',
        resolvedFrom: undefined,
      };
    }));
  };

  const renderPatternCard = (pattern: PatternItem) => {
    const accent = patternAccent(pattern.type);
    const isExpanded = expandedPatternId === pattern.id;
    const totalLabel = pattern.totalPnl < 0 ? 'Total cost' : 'Total earned';
    const totalColor = pattern.totalPnl < 0 ? '#f87171' : '#34d399';
    const confidenceTone = confidenceColor(pattern.confidence);

    return (
      <article
        key={pattern.id}
        className="grid cursor-pointer overflow-hidden rounded-[8px]"
        style={{ gridTemplateColumns: '4px minmax(0,1fr)', backgroundColor: colors.d2, border: cardBorder }}
        onClick={() => togglePattern(pattern.id)}
      >
        <div style={{ backgroundColor: accent }} />
        <div className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded-[4px] px-2 py-1 text-[10px] font-semibold uppercase" style={{ letterSpacing: '0.08em', color: accent, backgroundColor: `${accent}1A`, border: `1px solid ${accent}40` }}>
                {pattern.type}
              </span>
              <span className="rounded-[4px] px-2 py-1 text-[10px] font-medium" style={statusStyles(pattern.status)}>
                {pattern.status}
              </span>
              <span className="text-[11px]" style={{ color: colors.t2 }}>First seen {new Date(pattern.firstSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · {pattern.sessionCount} sessions</span>
            </div>
            <div className="text-right">
              <p className="text-[21px] font-semibold" style={{ color: totalColor }}>{formatSignedCurrency(pattern.totalPnl)}</p>
              <p className="text-[11px]" style={{ color: colors.t2 }}>{totalLabel}</p>
            </div>
          </div>

          <h3 className="mt-2.5 text-[14px] font-semibold" style={{ color: colors.t0 }}>{pattern.title}</h3>
          <p className="mt-1.5 text-[12px] leading-[1.65]" style={{ color: colors.t1 }}>{pattern.description}</p>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-1.5">
              {pattern.tags.map(tag => (
                <span key={tag.label} className="rounded-[4px] px-2 py-[3px] text-[11px]" style={tagStyles(tag.sentiment)}>{tag.label}</span>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-[11px]" style={{ color: colors.t1 }}>Confidence</span>
                <div className="h-[3px] w-20 rounded-[2px]" style={{ backgroundColor: colors.d4 }}>
                  <div className="h-[3px] rounded-[2px]" style={{ width: `${pattern.confidence}%`, backgroundColor: confidenceTone }} />
                </div>
                <span className="text-[11px] font-medium" style={{ color: confidenceTone }}>{pattern.confidence}%</span>
              </div>
              <span className="text-[11px] font-medium" style={{ color: colors.acc }}>View sessions &rarr;</span>
            </div>
          </div>

          {isExpanded && (
            <div className="mt-3 rounded-[8px] border p-3" style={{ borderColor: colors.b0, backgroundColor: colors.d3 }} onClick={event => event.stopPropagation()}>
              <p style={tinyMetaLabelStyle}>Sessions</p>
              <div className="mt-2 space-y-1.5">
                {pattern.sessions.map(session => (
                  <div key={`${pattern.id}-${session.date}-${session.pnl}`} className="flex items-center justify-between text-[12px]">
                    <span style={{ color: colors.t1 }}>{new Date(session.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    <span style={{ color: session.pnl >= 0 ? colors.grn : colors.red }}>{formatSignedCurrency(session.pnl)}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => markResolved(pattern.id)}
                className="mt-3 rounded-[6px] border px-3 py-1.5 text-[12px] transition-colors"
                style={{ borderColor: colors.b1, backgroundColor: colors.d4, color: colors.t0 }}
              >
                Mark as resolved
              </button>
              <div className="mt-3 rounded-[6px] border p-3" style={{ borderColor: `${colors.acc}30`, backgroundColor: `rgba(245,158,11,0.07)` }}>
                <p style={{ ...tinyMetaLabelStyle, color: colors.acc }}>Flyxa Suggestion</p>
                <p className="mt-1 text-[12px] leading-[1.6]" style={{ color: colors.t1 }}>{getSuggestion(pattern)}</p>
              </div>
            </div>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="animate-fade-in h-[calc(100vh-3.5rem)] overflow-hidden rounded-2xl" style={{ backgroundColor: colors.d0, color: colors.t0 }}>
      <div className="grid h-full grid-cols-[178px_minmax(0,1fr)] overflow-hidden">
        <FlyxaNav />

        <main className="min-h-0 overflow-hidden" style={{ backgroundColor: colors.d0 }}>
          <div className="flex h-full min-h-0 flex-col">
            <section className="border-b px-6 py-5" style={{ borderColor: colors.b0 }}>
              <p className="text-[9.5px] uppercase tracking-[0.12em]" style={{ color: colors.t2 }}>Flyxa AI</p>
              <div className="mt-2 flex items-center gap-3">
                <h1 className="text-[24px] font-bold tracking-[-0.02em]" style={{ color: colors.t0 }}>Pattern library</h1>
                <div className="flex gap-0.5 rounded-[5px] p-0.5" style={{ backgroundColor: colors.d3 }}>
                  {(['1M', '3M', '6M', 'All'] as DetectedTimeFrame[]).map(tf => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setDetectedTf(tf)}
                      className="rounded-[3px] px-2.5 py-[3px] text-[10px] font-medium transition-colors"
                      style={{
                        backgroundColor: detectedTf === tf ? colors.d4 : 'transparent',
                        color: detectedTf === tf ? colors.t0 : colors.t2,
                        border: detectedTf === tf ? `1px solid ${colors.b1}` : '1px solid transparent',
                      }}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-[12px]" style={{ color: colors.t2 }}>Patterns auto-detected from your trade history &middot; {detectedPatterns.length} found over {detectedTf === 'All' ? 'all time' : detectedTf === '1M' ? 'the last month' : detectedTf === '3M' ? 'the last 3 months' : 'the last 6 months'}</p>
            </section>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-4">

                {/* ── Auto-detected patterns ── */}
                {detectedPatterns.length > 0 && (
                  <section>
                    <div className="mb-2 flex items-center gap-2">
                      <p className="text-[9.5px] font-medium uppercase tracking-[0.12em]" style={{ color: colors.acc }}>Auto-detected from trade history</p>
                      <span className="rounded-[3px] px-1.5 py-0.5 text-[9px] font-semibold" style={{ backgroundColor: 'rgba(245,158,11,0.12)', color: colors.acc }}>{detectedPatterns.length}</span>
                    </div>
                    <div className="space-y-3">
                      {detectedPatterns.map(renderPatternCard)}
                    </div>
                  </section>
                )}
                {detectedPatterns.length === 0 && accountTrades.length > 0 && (
                  <div className="rounded-[8px] border px-4 py-3 text-[12px]" style={{ borderColor: colors.b0, backgroundColor: colors.d2, color: colors.t2 }}>
                    No statistically significant patterns found in the selected period. Patterns emerge once a symbol, session, or emotional state has 3–5+ trades with a consistent directional result. Keep logging.
                  </div>
                )}
                {accountTrades.length === 0 && (
                  <div className="rounded-[8px] border px-4 py-3 text-[12px]" style={{ borderColor: colors.b0, backgroundColor: colors.d2, color: colors.t2 }}>
                    No trade data found. Log trades in the journal to activate auto-detection.
                  </div>
                )}

                <section className="space-y-2 rounded-[8px] p-3" style={{ border: cardBorder, backgroundColor: colors.d2 }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span style={tinyMetaLabelStyle}>Type</span>
                    {(['All', 'Risk', 'Edge', 'Psychology', 'Behaviour'] as const).map(type => (
                      <button key={type} type="button" onClick={() => setSelectedType(type)} className={`rounded-[4px] border px-3 py-1 text-[12px] ${filterPillClass(selectedType === type)}`}>
                        {type}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span style={tinyMetaLabelStyle}>Session</span>
                    {(['All', 'RTH open', 'Overlap', 'Midday'] as const).map(session => (
                      <button key={session} type="button" onClick={() => setSelectedSession(session)} className={`rounded-[4px] border px-3 py-1 text-[12px] ${filterPillClass(selectedSession === session)}`}>
                        {session}
                      </button>
                    ))}
                    <div className="ml-auto flex items-center gap-2">
                      <span style={tinyMetaLabelStyle}>Sort</span>
                      <select
                        value={sortBy}
                        onChange={event => setSortBy(event.target.value as SortOption)}
                        className="rounded-[4px] border px-2.5 py-1.5 text-[12px]"
                        style={{ borderColor: colors.b0, backgroundColor: colors.d3, color: colors.t0 }}
                      >
                        <option value="impact">Most impactful</option>
                        <option value="recent">Most recent</option>
                        <option value="frequency">Most frequent</option>
                      </select>
                    </div>
                  </div>
                </section>

                <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
                  <div className="rounded-[8px] p-3" style={{ border: cardBorder, backgroundColor: colors.d2 }}>
                    <p style={tinyMetaLabelStyle}>Costing you</p>
                    <p className="mt-1 text-[22px] font-semibold" style={{ color: colors.red }}>{formatSignedCurrency(summary.totalLost)}</p>
                    <p className="text-[12px]" style={{ color: colors.t2 }}>{summary.riskCount} active risk patterns</p>
                  </div>
                  <div className="rounded-[8px] p-3" style={{ border: cardBorder, backgroundColor: colors.d2 }}>
                    <p style={tinyMetaLabelStyle}>Making you money</p>
                    <p className="mt-1 text-[22px] font-semibold" style={{ color: colors.grn }}>{formatSignedCurrency(summary.totalGained)}</p>
                    <p className="text-[12px]" style={{ color: colors.t2 }}>{summary.edgeCount} confirmed edges</p>
                  </div>
                  <div className="rounded-[8px] p-3" style={{ border: cardBorder, backgroundColor: colors.d2 }}>
                    <p style={tinyMetaLabelStyle}>Improving</p>
                    <p className="mt-1 text-[22px] font-semibold" style={{ color: colors.acc }}>{summary.improvingCount}</p>
                    <p className="text-[12px]" style={{ color: colors.t2 }}>patterns trending better</p>
                  </div>
                  <div className="rounded-[8px] p-3" style={{ border: cardBorder, backgroundColor: colors.d2 }}>
                    <p style={tinyMetaLabelStyle}>Resolved</p>
                    <p className="mt-1 text-[22px] font-semibold" style={{ color: colors.t1 }}>{summary.resolvedCount}</p>
                    <p className="text-[12px]" style={{ color: colors.t2 }}>eliminated patterns</p>
                  </div>
                </section>

                <section>
                  <div className="mb-2">
                    <p className="text-[9.5px] font-medium uppercase tracking-[0.12em]" style={{ color: colors.red }}>Manually tracked · Costing you</p>
                    <p className="text-[12px]" style={{ color: colors.t2 }}>{costingPatterns.length} patterns</p>
                  </div>
                  <div className="space-y-3">
                    {costingPatterns.map(renderPatternCard)}
                    {costingPatterns.length === 0 && (
                      <div className="rounded-[8px] border p-4 text-[12px]" style={{ borderColor: colors.b0, backgroundColor: colors.d2, color: colors.t2 }}>
                        No real risk patterns detected from your current trades.
                      </div>
                    )}
                  </div>
                </section>

                <section>
                  <div className="mb-2">
                    <p className="text-[9.5px] font-medium uppercase tracking-[0.12em]" style={{ color: colors.grn }}>Manually tracked · Making you money</p>
                    <p className="text-[12px]" style={{ color: colors.t2 }}>{earningPatterns.length} patterns</p>
                  </div>
                  <div className="space-y-3">
                    {earningPatterns.map(renderPatternCard)}
                    {earningPatterns.length === 0 && (
                      <div className="rounded-[8px] border p-4 text-[12px]" style={{ borderColor: colors.b0, backgroundColor: colors.d2, color: colors.t2 }}>
                        No real earning patterns detected from your current trades.
                      </div>
                    )}
                  </div>
                </section>

                <section className="rounded-[8px] p-3" style={{ border: cardBorder, backgroundColor: colors.d2 }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[9.5px] font-medium uppercase tracking-[0.12em]" style={{ color: colors.t1 }}>Resolved</p>
                      <p className="text-[12px]" style={{ color: colors.t2 }}>{resolvedPatterns.length} eliminated patterns</p>
                    </div>
                    <button type="button" onClick={() => setShowResolved(value => !value)} className="text-[12px] font-medium transition-colors" style={{ color: colors.t1 }}>
                      {showResolved ? 'Hide all ↑' : 'Show all ↓'}
                    </button>
                  </div>
                  {showResolved && (
                    <div className="mt-3 space-y-2">
                      {resolvedPatterns.map(pattern => {
                        const lastSeen = pattern.sessions.length > 0 ? pattern.sessions[0].date : pattern.firstSeen;
                        return (
                          <div key={pattern.id} className="rounded-[8px] border px-3 py-2 text-[12px]" style={{ borderColor: colors.b0, backgroundColor: colors.d3, color: colors.t2 }}>
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <span style={{ color: colors.t1 }}>{pattern.title}</span>
                                <p className="mt-0.5">Last seen {new Date(lastSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span style={{ color: colors.t1 }}>~{formatSignedCurrency(Math.abs(pattern.totalPnl))} saved</span>
                                <button
                                  type="button"
                                  onClick={() => unresolvePattern(pattern.id)}
                                  className="rounded-[4px] border px-2 py-1 text-[11px] transition-colors"
                                  style={{ borderColor: colors.b1, backgroundColor: colors.d4, color: colors.t0 }}
                                >
                                  Unresolve
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
