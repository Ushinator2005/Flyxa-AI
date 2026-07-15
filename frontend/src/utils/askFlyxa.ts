import { Trade } from '../types/index.js';
import { normalizeConfluenceTags } from './confluenceTags.js';

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

export const QUICK_QUESTIONS = [
  'When do I trade best?',
  'Do I follow my plan?',
  'How does my emotion affect trading?',
  'Am I overtrading?',
  'Am I getting better?',
  'How do I trade after a loss?',
  'Which confluences work?',
  'What\'s my best instrument?',
  'Give me a summary',
  'What\'s my win rate?',
  'What\'s my best day of week?',
  'How long do I hold trades?',
];

// ─── computeAllStats ──────────────────────────────────────────────────────────
// Computes all relevant trade statistics as a serialisable JSON object.
// Passed to the backend so the AI can reason over real numbers.

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function statRow(trades: Trade[]) {
  const wins = trades.filter(t => (t.pnl ?? 0) > 0);
  const losses = trades.filter(t => (t.pnl ?? 0) < 0);
  const total = net(trades);
  const grossWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  return {
    trades: trades.length,
    winRate: Math.round(wr(trades) * 10) / 10,
    netPnl: Math.round(total * 100) / 100,
    avgPnl: trades.length ? Math.round((total / trades.length) * 100) / 100 : 0,
    avgWin: wins.length ? Math.round((grossWin / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : grossWin > 0 ? 999 : 0,
  };
}

export function computeAllStats(trades: Trade[]): Record<string, unknown> {
  if (!trades.length) return { overview: { totalTrades: 0 } };

  // ── Overview ──
  const overview = { totalTrades: trades.length, ...statRow(trades) };

  // ── By session ──
  const sessionGroups = groupBy(trades, t => t.session ?? 'Other');
  const bySession = Object.entries(sessionGroups).map(([session, ts]) => ({ session, ...statRow(ts) }));

  // ── By day of week ──
  const dowGroups = groupBy(trades, t => {
    const d = t.trade_date ? new Date(`${t.trade_date}T00:00:00`) : null;
    return d && !isNaN(d.getTime()) ? DOW_NAMES[d.getDay()] : 'Unknown';
  });
  const byDay = Object.entries(dowGroups)
    .filter(([d]) => d !== 'Unknown')
    .map(([day, ts]) => ({ day, ...statRow(ts) }));

  // ── By symbol ──
  const symbolGroups = groupBy(trades, t =>
    (t.symbol ?? 'Unknown').replace(/\s+\d{2}-\d{2}$/, '').toUpperCase()
  );
  const bySymbol = Object.entries(symbolGroups)
    .map(([symbol, ts]) => ({ symbol, ...statRow(ts) }))
    .sort((a, b) => b.trades - a.trades);

  // ── By emotional state ──
  const emotionGroups = groupBy(trades, t => t.emotional_state?.trim() || 'Not logged');
  const byEmotion = Object.entries(emotionGroups)
    .filter(([, ts]) => ts.length >= 2)
    .map(([emotion, ts]) => ({ emotion, ...statRow(ts) }));

  // ── By direction ──
  const dirGroups = groupBy(trades, t => t.direction ?? 'Unknown');
  const byDirection = Object.entries(dirGroups).map(([direction, ts]) => ({ direction, ...statRow(ts) }));

  // ── Plan adherence ──
  const followedTrades = trades.filter(t => t.followed_plan === true);
  const brokeTrades = trades.filter(t => t.followed_plan === false);
  const planAdherence = {
    pctFollowed: trades.length ? Math.round((followedTrades.length / trades.length) * 100) : null,
    hasData: followedTrades.length + brokeTrades.length > 0,
    followed: followedTrades.length > 0 ? statRow(followedTrades) : null,
    broke: brokeTrades.length > 0 ? statRow(brokeTrades) : null,
  };

  // ── Overtrading (trades per day) ──
  const dayGroups = groupBy(trades, t => t.trade_date ?? '');
  const perDayCounts = Object.values(dayGroups).map(ts => ts.length);
  const daysTraded = perDayCounts.length;
  const maxInDay = perDayCounts.length ? Math.max(...perDayCounts) : 0;
  const avgPerDay = daysTraded ? Math.round((trades.length / daysTraded) * 10) / 10 : 0;
  const daysAbove3 = perDayCounts.filter(c => c > 3).length;
  const daysAbove5 = perDayCounts.filter(c => c > 5).length;
  const overtrading = { daysTraded, avgPerDay, maxInDay, daysAbove3, daysAbove5 };

  // ── Post-loss behaviour ──
  const sorted = [...trades].sort((a, b) => {
    const da = `${a.trade_date ?? ''}T${a.trade_time ?? '00:00'}`;
    const db = `${b.trade_date ?? ''}T${b.trade_time ?? '00:00'}`;
    return da < db ? -1 : da > db ? 1 : 0;
  });
  const afterLoss: Trade[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i - 1].pnl ?? 0) < 0) afterLoss.push(sorted[i]);
  }
  const postLoss = afterLoss.length >= 3 ? { sampleSize: afterLoss.length, ...statRow(afterLoss) } : null;

  // ── Streak ──
  let longestWin = 0, longestLoss = 0, curWin = 0, curLoss = 0;
  for (const t of sorted) {
    if ((t.pnl ?? 0) > 0) { curWin++; curLoss = 0; longestWin = Math.max(longestWin, curWin); }
    else { curLoss++; curWin = 0; longestLoss = Math.max(longestLoss, curLoss); }
  }
  const lastPnl = sorted.length ? (sorted[sorted.length - 1].pnl ?? 0) : 0;
  let currentStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i].pnl ?? 0;
    if ((lastPnl > 0 && p > 0) || (lastPnl <= 0 && p <= 0)) currentStreak++;
    else break;
  }
  const streak = {
    current: currentStreak,
    currentType: lastPnl > 0 ? 'win' : 'loss',
    longestWin,
    longestLoss,
  };

  // ── Trend (first 10 vs last 10) ──
  const trend = sorted.length >= 20 ? {
    first10: statRow(sorted.slice(0, 10)),
    last10: statRow(sorted.slice(-10)),
    last30: sorted.length >= 30 ? statRow(sorted.slice(-30)) : null,
    improving: net(sorted.slice(-10)) > net(sorted.slice(0, 10)),
  } : null;

  // ── Top confluences ──
  const confMap: Record<string, Trade[]> = {};
  for (const t of trades) {
    for (const c of normalizeConfluenceTags(t.confluences)) {
      const key = c.trim();
      if (key) (confMap[key] ??= []).push(t);
    }
  }
  const topConfluences = Object.entries(confMap)
    .filter(([, ts]) => ts.length >= 2)
    .map(([name, ts]) => ({ name, uses: ts.length, ...statRow(ts) }))
    .sort((a, b) => b.netPnl - a.netPnl)
    .slice(0, 10);

  // ── Duration ──
  const withDuration = trades.filter(t => (t.trade_length_seconds ?? 0) > 0);
  const winDuration = withDuration.filter(t => (t.pnl ?? 0) > 0);
  const lossDuration = withDuration.filter(t => (t.pnl ?? 0) < 0);
  const avgSec = (arr: Trade[]) => arr.length
    ? Math.round(arr.reduce((s, t) => s + (t.trade_length_seconds ?? 0), 0) / arr.length)
    : null;
  const duration = {
    avgSeconds: avgSec(withDuration),
    avgWinSeconds: avgSec(winDuration),
    avgLossSeconds: avgSec(lossDuration),
    sampleSize: withDuration.length,
  };

  return {
    overview,
    bySession,
    byDay,
    bySymbol,
    byEmotion,
    byDirection,
    planAdherence,
    overtrading,
    postLoss,
    streak,
    trend,
    topConfluences,
    duration,
  };
}
