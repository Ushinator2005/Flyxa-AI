import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest, Trade } from '../types/index';
import { normalizeConfluenceKey, normalizeConfluences } from '../utils/confluenceTags';

const router = Router();

function calcConsecutive(trades: Trade[]): { wins: number; losses: number } {
  let maxWins = 0, maxLosses = 0, curWins = 0, curLosses = 0;
  for (const t of trades) {
    if (t.exit_reason === 'TP') {
      curWins++;
      curLosses = 0;
      maxWins = Math.max(maxWins, curWins);
    } else {
      curLosses++;
      curWins = 0;
      maxLosses = Math.max(maxLosses, curLosses);
    }
  }
  return { wins: maxWins, losses: maxLosses };
}

// GET /summary
router.get('/summary', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', req.userId!)
      .order('trade_date', { ascending: true });

    if (error) throw error;

    const allTrades = (trades || []) as Trade[];
    const wins = allTrades.filter(t => t.exit_reason === 'TP');
    const losses = allTrades.filter(t => t.exit_reason === 'SL');

    const netPnL = allTrades.reduce((s, t) => s + t.pnl, 0);
    const winRate = allTrades.length > 0 ? (wins.length / allTrades.length) * 100 : 0;

    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
    const profitFactor = grossLoss !== 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? Infinity : 0;

    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

    const sortedPnl = allTrades.map(t => t.pnl).sort((a, b) => b - a);
    const largestWin = sortedPnl[0] || 0;
    const largestLoss = sortedPnl[sortedPnl.length - 1] || 0;

    // Average R:R
    const rrValues = allTrades
      .filter(t => t.sl_price && t.tp_price && t.entry_price)
      .map(t => Math.abs(t.tp_price - t.entry_price) / Math.abs(t.sl_price - t.entry_price));
    const avgRR = rrValues.length > 0 ? rrValues.reduce((s, v) => s + v, 0) / rrValues.length : 0;

    const consec = calcConsecutive(allTrades);

    res.json({
      netPnL,
      winRate,
      profitFactor: isFinite(profitFactor) ? profitFactor : 999,
      avgRR,
      totalTrades: allTrades.length,
      avgWin,
      avgLoss,
      largestWin,
      largestLoss,
      consecutiveWins: consec.wins,
      consecutiveLosses: consec.losses,
    });
  } catch (err) {
    next(err);
  }
});

// GET /daily-pnl
router.get('/daily-pnl', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('trade_date, pnl')
      .eq('user_id', req.userId!)
      .order('trade_date', { ascending: true });

    if (error) throw error;

    const grouped: Record<string, number> = {};
    for (const t of (trades || [])) {
      grouped[t.trade_date] = (grouped[t.trade_date] || 0) + t.pnl;
    }

    const result = Object.entries(grouped).map(([date, pnl]) => ({ date, pnl }));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /equity-curve
router.get('/equity-curve', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('trade_date, trade_time, pnl')
      .eq('user_id', req.userId!)
      .order('trade_date', { ascending: true })
      .order('trade_time', { ascending: true });

    if (error) throw error;

    let cumulative = 0;
    const result = (trades || []).map(t => {
      cumulative += t.pnl;
      return { date: t.trade_date, pnl: t.pnl, cumulative };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /by-session
router.get('/by-session', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('session, pnl, exit_reason')
      .eq('user_id', req.userId!);

    if (error) throw error;

    const sessions: Record<string, { total: number; wins: number; pnl: number; grossProfit: number; grossLoss: number }> = {};

    for (const t of (trades || [])) {
      const s = t.session || 'Other';
      if (!sessions[s]) sessions[s] = { total: 0, wins: 0, pnl: 0, grossProfit: 0, grossLoss: 0 };
      sessions[s].total++;
      sessions[s].pnl += t.pnl;
      if (t.exit_reason === 'TP') {
        sessions[s].wins++;
        sessions[s].grossProfit += t.pnl;
      } else {
        sessions[s].grossLoss += t.pnl;
      }
    }

    const result = Object.entries(sessions).map(([session, data]) => ({
      session,
      trades: data.total,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
      netPnL: data.pnl,
      profitFactor: data.grossLoss !== 0 ? data.grossProfit / Math.abs(data.grossLoss) : data.grossProfit > 0 ? 999 : 0,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /by-instrument
router.get('/by-instrument', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('symbol, pnl, exit_reason')
      .eq('user_id', req.userId!);

    if (error) throw error;

    const instruments: Record<string, { total: number; wins: number; pnl: number; grossProfit: number; grossLoss: number }> = {};

    for (const t of (trades || [])) {
      const sym = t.symbol;
      if (!instruments[sym]) instruments[sym] = { total: 0, wins: 0, pnl: 0, grossProfit: 0, grossLoss: 0 };
      instruments[sym].total++;
      instruments[sym].pnl += t.pnl;
      if (t.exit_reason === 'TP') {
        instruments[sym].wins++;
        instruments[sym].grossProfit += t.pnl;
      } else {
        instruments[sym].grossLoss += t.pnl;
      }
    }

    const result = Object.entries(instruments).map(([symbol, data]) => ({
      symbol,
      trades: data.total,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
      netPnL: data.pnl,
      profitFactor: data.grossLoss !== 0 ? data.grossProfit / Math.abs(data.grossLoss) : data.grossProfit > 0 ? 999 : 0,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /by-confluence
router.get('/by-confluence', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('confluences, pnl, exit_reason')
      .eq('user_id', req.userId!);

    if (error) throw error;

    const confluenceStats: Record<string, {
      label: string;
      total: number;
      wins: number;
      pnl: number;
      grossProfit: number;
      grossLoss: number;
    }> = {};

    for (const trade of (trades || [])) {
      const confluences = normalizeConfluences(trade.confluences);
      if (!confluences.length) continue;

      for (const confluence of confluences) {
        const key = normalizeConfluenceKey(confluence);
        if (!confluenceStats[key]) {
          confluenceStats[key] = {
            label: confluence,
            total: 0,
            wins: 0,
            pnl: 0,
            grossProfit: 0,
            grossLoss: 0,
          };
        }

        confluenceStats[key].total++;
        confluenceStats[key].pnl += trade.pnl;
        if (trade.exit_reason === 'TP') {
          confluenceStats[key].wins++;
          confluenceStats[key].grossProfit += trade.pnl;
        } else {
          confluenceStats[key].grossLoss += trade.pnl;
        }
      }
    }

    const result = Object.values(confluenceStats)
      .map(stat => ({
        confluence: stat.label,
        trades: stat.total,
        winRate: stat.total > 0 ? (stat.wins / stat.total) * 100 : 0,
        netPnL: stat.pnl,
        avgPnL: stat.total > 0 ? stat.pnl / stat.total : 0,
        profitFactor: stat.grossLoss !== 0
          ? stat.grossProfit / Math.abs(stat.grossLoss)
          : stat.grossProfit > 0
            ? 999
            : 0,
      }))
      .sort((a, b) => b.netPnL - a.netPnL);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /by-day-of-week
router.get('/by-day-of-week', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('trade_date, pnl, exit_reason')
      .eq('user_id', req.userId!);

    if (error) throw error;

    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const grouped: Record<string, { total: number; wins: number; pnl: number }> = {};

    for (const t of (trades || [])) {
      const dayIdx = new Date(t.trade_date).getDay();
      const day = days[dayIdx];
      if (!grouped[day]) grouped[day] = { total: 0, wins: 0, pnl: 0 };
      grouped[day].total++;
      grouped[day].pnl += t.pnl;
      if (t.exit_reason === 'TP') grouped[day].wins++;
    }

    const result = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(day => ({
      day,
      trades: grouped[day]?.total || 0,
      winRate: grouped[day]?.total > 0 ? (grouped[day].wins / grouped[day].total) * 100 : 0,
      avgPnL: grouped[day]?.total > 0 ? grouped[day].pnl / grouped[day].total : 0,
      netPnL: grouped[day]?.pnl || 0,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /by-time-of-day
router.get('/by-time-of-day', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('trade_time, pnl, exit_reason')
      .eq('user_id', req.userId!);

    if (error) throw error;

    const grouped: Record<number, { total: number; wins: number; pnl: number }> = {};

    for (const t of (trades || [])) {
      const hour = parseInt(t.trade_time.split(':')[0]);
      if (!grouped[hour]) grouped[hour] = { total: 0, wins: 0, pnl: 0 };
      grouped[hour].total++;
      grouped[hour].pnl += t.pnl;
      if (t.exit_reason === 'TP') grouped[hour].wins++;
    }

    const result = Object.entries(grouped).map(([hour, data]) => ({
      hour: parseInt(hour),
      label: `${hour.toString().padStart(2, '0')}:00`,
      trades: data.total,
      winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
      avgPnL: data.total > 0 ? data.pnl / data.total : 0,
      netPnL: data.pnl,
    })).sort((a, b) => a.hour - b.hour);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /monthly-heatmap
router.get('/monthly-heatmap', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const year = parseInt(req.query.year as string) || new Date().getFullYear();
    const month = parseInt(req.query.month as string) || new Date().getMonth() + 1;

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const [
      { data: trades, error: tradesError },
      { data: journals, error: journalsError },
    ] = await Promise.all([
      supabase
        .from('trades')
        .select('trade_date, pnl')
        .eq('user_id', req.userId!)
        .gte('trade_date', startDate)
        .lte('trade_date', endDate),
      supabase
        .from('journal_entries')
        .select('id, date')
        .eq('user_id', req.userId!)
        .gte('date', startDate)
        .lte('date', endDate),
    ]);

    if (tradesError) throw tradesError;
    if (journalsError) throw journalsError;

    const days: Record<number, number> = {};
    const counts: Record<number, number> = {};
    for (const t of (trades || [])) {
      const day = new Date(t.trade_date).getDate();
      days[day] = (days[day] || 0) + t.pnl;
      counts[day] = (counts[day] || 0) + 1;
    }

    const journalsByDay: Record<number, { id: string; date: string }> = {};
    for (const entry of (journals || [])) {
      const day = new Date(entry.date).getDate();
      if (!journalsByDay[day]) {
        journalsByDay[day] = { id: entry.id, date: entry.date };
      }
    }

    res.json({ year, month, days, counts, journals: journalsByDay });
  } catch (err) {
    next(err);
  }
});

// GET /advanced
router.get('/advanced', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', req.userId!)
      .order('trade_date', { ascending: true });

    if (error) throw error;

    const allTrades = (trades || []) as Trade[];

    // R:R distribution
    const rrDist: Record<string, number> = {};
    for (const t of allTrades) {
      if (t.sl_price && t.tp_price && t.entry_price) {
        const rr = Math.abs(t.tp_price - t.entry_price) / Math.abs(t.sl_price - t.entry_price);
        const bucket = rr < 1 ? '<1' : rr < 1.5 ? '1-1.5' : rr < 2 ? '1.5-2' : rr < 3 ? '2-3' : '>3';
        rrDist[bucket] = (rrDist[bucket] || 0) + 1;
      }
    }

    // Hold time analysis
    const holdTimeGroups: Record<string, { total: number; wins: number; pnl: number }> = {};
    for (const t of allTrades) {
      if (t.trade_length_seconds) {
        const mins = t.trade_length_seconds / 60;
        const bucket = mins < 5 ? '<5m' : mins < 15 ? '5-15m' : mins < 30 ? '15-30m' : mins < 60 ? '30-60m' : '>60m';
        if (!holdTimeGroups[bucket]) holdTimeGroups[bucket] = { total: 0, wins: 0, pnl: 0 };
        holdTimeGroups[bucket].total++;
        holdTimeGroups[bucket].pnl += t.pnl;
        if (t.exit_reason === 'TP') holdTimeGroups[bucket].wins++;
      }
    }

    // By emotional state
    const emotionalStats: Record<string, { total: number; wins: number; pnl: number }> = {};
    for (const t of allTrades) {
      const state = t.emotional_state || 'Unknown';
      if (!emotionalStats[state]) emotionalStats[state] = { total: 0, wins: 0, pnl: 0 };
      emotionalStats[state].total++;
      emotionalStats[state].pnl += t.pnl;
      if (t.exit_reason === 'TP') emotionalStats[state].wins++;
    }

    // By confidence level
    const confidenceStats: Record<number, { total: number; wins: number; pnl: number }> = {};
    for (const t of allTrades) {
      const conf = t.confidence_level || 5;
      if (!confidenceStats[conf]) confidenceStats[conf] = { total: 0, wins: 0, pnl: 0 };
      confidenceStats[conf].total++;
      confidenceStats[conf].pnl += t.pnl;
      if (t.exit_reason === 'TP') confidenceStats[conf].wins++;
    }

    // Drawdown calculation
    let peak = 0, maxDrawdown = 0, cumulative = 0;
    const drawdownSeries: Array<{ date: string; cumulative: number; drawdown: number }> = [];
    for (const t of allTrades) {
      cumulative += t.pnl;
      if (cumulative > peak) peak = cumulative;
      const drawdown = peak > 0 ? ((peak - cumulative) / peak) * 100 : 0;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      drawdownSeries.push({ date: t.trade_date, cumulative, drawdown });
    }

    res.json({
      rrDistribution: Object.entries(rrDist).map(([bucket, count]) => ({ bucket, count })),
      holdTimeAnalysis: Object.entries(holdTimeGroups).map(([bucket, data]) => ({
        bucket,
        trades: data.total,
        winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
        avgPnL: data.total > 0 ? data.pnl / data.total : 0,
      })),
      byEmotionalState: Object.entries(emotionalStats).map(([state, data]) => ({
        state,
        trades: data.total,
        winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
        netPnL: data.pnl,
        avgPnL: data.total > 0 ? data.pnl / data.total : 0,
      })),
      byConfidence: Object.entries(confidenceStats).map(([level, data]) => ({
        level: parseInt(level),
        trades: data.total,
        winRate: data.total > 0 ? (data.wins / data.total) * 100 : 0,
        avgPnL: data.total > 0 ? data.pnl / data.total : 0,
      })).sort((a, b) => a.level - b.level),
      drawdown: {
        maxDrawdown,
        series: drawdownSeries,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
