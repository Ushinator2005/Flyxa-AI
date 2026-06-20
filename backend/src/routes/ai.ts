import { Router, Response, NextFunction } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import {
  analyzeIndividualTrade,
  analyzePatterns,
  generateWeeklyReport,
  generatePsychologyReport,
  compareTradeToPlaybook,
  answerFlyxaQuestion,
  answerTradeDataQuery,
  filterNewsItems,
} from '../services/claude';
import { analyzeChartImage } from '../services/gemini';
import { AuthenticatedRequest, Trade } from '../types/index';
import { normalizeConfluences } from '../utils/confluenceTags';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// POST /scan
router.post('/scan', authMiddleware, upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'focusImages', maxCount: 10 },
]), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const imageFile = files?.['image']?.[0];
    if (!imageFile) {
      res.status(400).json({ error: 'image is required' });
      return;
    }

    const entryDate = typeof req.body.entryDate === 'string' ? req.body.entryDate : new Date().toISOString().slice(0, 10);
    const entryTime = typeof req.body.entryTime === 'string' ? req.body.entryTime : '09:30';

    let scannerContext: Record<string, unknown> | undefined;
    if (typeof req.body.scannerContext === 'string') {
      try { scannerContext = JSON.parse(req.body.scannerContext); } catch { /* ignore */ }
    }

    const focusFileList = files?.['focusImages'] ?? [];
    const focusImages = focusFileList.map(f => ({
      base64Image: f.buffer.toString('base64'),
      mimeType: f.mimetype,
      label: f.originalname,
    }));

    const base64Image = imageFile.buffer.toString('base64');
    const mimeType = imageFile.mimetype;

    const result = await analyzeChartImage(base64Image, mimeType, entryDate, entryTime, focusImages, scannerContext);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /ask-flyxa-data  — AI-powered trade data query
router.post('/ask-flyxa-data', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const question = typeof req.body.question === 'string' ? req.body.question : '';
    const stats = (req.body.stats && typeof req.body.stats === 'object' && !Array.isArray(req.body.stats))
      ? (req.body.stats as Record<string, unknown>)
      : {};

    if (!question.trim()) {
      res.status(400).json({ error: 'question is required' });
      return;
    }

    const reply = await answerTradeDataQuery(question, stats);
    res.json({ reply });
  } catch (err) {
    next(err);
  }
});

// POST /flyxa-chat
router.post('/flyxa-chat', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const question = typeof req.body.question === 'string' ? req.body.question : '';
    const history = Array.isArray(req.body.history)
      ? req.body.history
          .filter((message: unknown): message is { role: 'user' | 'assistant'; content: string } => (
            !!message &&
            typeof message === 'object' &&
            ('role' in message) &&
            ('content' in message) &&
            ((message as { role?: unknown }).role === 'user' || (message as { role?: unknown }).role === 'assistant') &&
            typeof (message as { content?: unknown }).content === 'string'
          ))
      : [];

    if (!question.trim()) {
      res.status(400).json({ error: 'question is required' });
      return;
    }

    const reply = await answerFlyxaQuestion(question, history);
    res.json({ reply });
  } catch (err) {
    next(err);
  }
});

// POST /trade-analysis/:tradeId
router.post('/trade-analysis/:tradeId', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { tradeId } = req.params;
    const requestTrade = req.body?.trade;

    // Resolve the trade being reviewed
    let focusTrade: Trade;
    if (requestTrade && typeof requestTrade === 'object' && requestTrade.symbol) {
      focusTrade = { ...requestTrade, id: typeof requestTrade.id === 'string' ? requestTrade.id : tradeId, user_id: req.userId! } as Trade;
    } else {
      const { data: trade, error } = await supabase
        .from('trades')
        .select('*')
        .eq('id', tradeId)
        .eq('user_id', req.userId!)
        .single();
      if (error || !trade) { res.status(404).json({ error: 'Trade not found' }); return; }
      focusTrade = trade as Trade;
    }

    // Fetch user's full trade history for stats context (lightweight fields only)
    const { data: rawHistory } = await supabase
      .from('trades')
      .select('id, pnl, emotional_state, confluences, followed_plan, session, trade_date, created_at')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: true });

    type HistTrade = { id: string; pnl: number; emotional_state: string; confluences: string[]; followed_plan: boolean | null; session: string; trade_date: string; created_at: string };
    const normalizeHistTrade = (value: unknown): HistTrade | null => {
      if (!value || typeof value !== 'object') return null;
      const trade = value as Partial<Trade> & Record<string, unknown>;
      const pnl = Number(trade.pnl);
      if (!Number.isFinite(pnl)) return null;
      const id = typeof trade.id === 'string' && trade.id.trim()
        ? trade.id
        : `${trade.trade_date ?? trade.created_at ?? 'trade'}-${trade.symbol ?? ''}-${trade.trade_time ?? ''}-${pnl}`;
      const emotion = typeof trade.emotional_state === 'string' && trade.emotional_state.trim()
        ? trade.emotional_state.trim()
        : 'Not logged';
      return {
        id,
        pnl,
        emotional_state: emotion,
        confluences: normalizeConfluences(trade.confluences),
        followed_plan: typeof trade.followed_plan === 'boolean' ? trade.followed_plan : null,
        session: typeof trade.session === 'string' && trade.session.trim() ? trade.session.trim() : 'Other',
        trade_date: typeof trade.trade_date === 'string' ? trade.trade_date : '',
        created_at: typeof trade.created_at === 'string' ? trade.created_at : '',
      };
    };

    const requestHistory = Array.isArray(req.body?.history) ? req.body.history : [];
    const mergedHistory = new Map<string, HistTrade>();
    for (const raw of [...(rawHistory ?? []), ...requestHistory]) {
      const normalized = normalizeHistTrade(raw);
      if (!normalized) continue;
      mergedHistory.set(normalized.id, normalized);
    }
    const history = Array.from(mergedHistory.values())
      .sort((a, b) => String(a.created_at || a.trade_date).localeCompare(String(b.created_at || b.trade_date)));

    // ── Stat helpers ──────────────────────────────────────────────────────────
    const winRate = (ts: HistTrade[]) => ts.length ? Math.round((ts.filter(t => t.pnl > 0).length / ts.length) * 100) : 0;
    const netPnl  = (ts: HistTrade[]) => Math.round(ts.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = (ts: HistTrade[]) => {
      const g = ts.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
      const l = Math.abs(ts.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
      return l > 0 ? (Math.round((g / l) * 100) / 100).toFixed(2) : g > 0 ? '∞' : '0';
    };

    // ── Overall ───────────────────────────────────────────────────────────────
    const overall = history.length >= 3 ? `${history.length} trades | ${winRate(history)}% WR | $${netPnl(history)} net | ${profitFactor(history)}x PF` : null;

    // ── By emotion ────────────────────────────────────────────────────────────
    const emotionStats = (() => {
      const groups: Record<string, HistTrade[]> = {};
      for (const t of history) {
        if (!t.emotional_state || t.emotional_state === 'Not logged') continue;
        const e = t.emotional_state;
        (groups[e] ??= []).push(t);
      }
      return Object.entries(groups)
        .filter(([, ts]) => ts.length >= 2)
        .map(([e, ts]) => `${e}: ${ts.length} trades, ${winRate(ts)}% WR, $${netPnl(ts)} net`)
        .join(' | ');
    })();

    // ── Confluences in this trade ─────────────────────────────────────────────
    const tradeConfs = normalizeConfluences(focusTrade.confluences);
    const confStats = tradeConfs.length ? tradeConfs.map(c => {
      const ts = history.filter(t => Array.isArray(t.confluences) && t.confluences.includes(c));
      return ts.length >= 2 ? `${c}: ${ts.length} uses, ${winRate(ts)}% WR, $${netPnl(ts)} net` : null;
    }).filter(Boolean).join(' | ') : null;

    // ── Plan adherence ────────────────────────────────────────────────────────
    const planLogged = history.filter(t => typeof t.followed_plan === 'boolean');
    const followed = planLogged.filter(t => t.followed_plan === true);
    const broke    = planLogged.filter(t => t.followed_plan === false);
    const planStats = planLogged.length >= 2
      ? [
          followed.length ? `Followed plan: ${followed.length} trades, ${winRate(followed)}% WR ($${netPnl(followed)} net)` : null,
          broke.length ? `Broke plan: ${broke.length} trades, ${winRate(broke)}% WR ($${netPnl(broke)} net)` : null,
        ].filter(Boolean).join(' | ')
      : null;

    // ── Same session ──────────────────────────────────────────────────────────
    const sessionTrades = history.filter(t => t.session === focusTrade.session);
    const sessionStats = sessionTrades.length >= 3
      ? `${focusTrade.session} session: ${sessionTrades.length} trades, ${winRate(sessionTrades)}% WR, $${netPnl(sessionTrades)} net`
      : null;

    // ── Recent form (last 10) ─────────────────────────────────────────────────
    const last10 = history.slice(-10);
    const recentStats = last10.length >= 5
      ? `Last ${last10.length} trades: ${winRate(last10)}% WR, $${netPnl(last10)} net`
      : null;

    // ── Post-loss context (was the trade before this a loss?) ─────────────────
    const tradeIndex = history.findIndex(t => t.id === focusTrade.id);
    const prevTrade = tradeIndex > 0 ? history[tradeIndex - 1] : null;
    const postLossNote = prevTrade && prevTrade.pnl < 0 ? `Previous trade was a loss ($${Math.round(prevTrade.pnl)})` : null;

    // ── Build context block ───────────────────────────────────────────────────
    const contextLines: string[] = [];
    if (history.length) contextLines.push(`Analysis sample: ${history.length} trades across all accounts`);
    if (overall)     contextLines.push(`Overall: ${overall}`);
    if (emotionStats) contextLines.push(`By emotion: ${emotionStats}`);
    if (confStats)   contextLines.push(`Tagged confluences: ${confStats}`);
    if (planStats)   contextLines.push(`Plan adherence: ${planStats}`);
    if (sessionStats) contextLines.push(`Session: ${sessionStats}`);
    if (recentStats) contextLines.push(`Recent form: ${recentStats}`);
    if (postLossNote) contextLines.push(`Context: ${postLossNote}`);
    const statsContext = contextLines.length ? contextLines.join('\n') : null;

    const analysis = await analyzeIndividualTrade(focusTrade, statsContext);
    res.json({ analysis });
  } catch (err) {
    next(err);
  }
});

// POST /patterns
router.post('/patterns', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.body;

    let query = supabase
      .from('trades')
      .select('*')
      .eq('user_id', req.userId!)
      .order('trade_date', { ascending: true });

    if (startDate) query = query.gte('trade_date', startDate);
    if (endDate) query = query.lte('trade_date', endDate);

    const { data: trades, error } = await query;
    if (error) throw error;

    if (!trades || trades.length === 0) {
      res.json({ analysis: 'No trades found for the selected period.' });
      return;
    }

    const analysis = await analyzePatterns(trades as Trade[]);
    res.json({ analysis });
  } catch (err) {
    next(err);
  }
});

// POST /weekly-report
router.post('/weekly-report', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { weekStart, weekEnd } = req.body;
    if (!weekStart || !weekEnd) {
      res.status(400).json({ error: 'weekStart and weekEnd are required' });
      return;
    }

    const { data: trades, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', req.userId!)
      .gte('trade_date', weekStart)
      .lte('trade_date', weekEnd)
      .order('trade_date', { ascending: true });

    if (error) throw error;

    const report = await generateWeeklyReport((trades || []) as Trade[], weekStart, weekEnd);
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

// POST /psychology-report
router.post('/psychology-report', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const [tradesResult, psychResult] = await Promise.all([
      supabase
        .from('trades')
        .select('*')
        .eq('user_id', req.userId!)
        .order('trade_date', { ascending: true }),
      supabase
        .from('psychology_logs')
        .select('*')
        .eq('user_id', req.userId!)
        .order('date', { ascending: true }),
    ]);

    if (tradesResult.error) throw tradesResult.error;
    if (psychResult.error) throw psychResult.error;

    const report = await generatePsychologyReport(
      (tradesResult.data || []) as Trade[],
      psychResult.data || []
    );
    res.json({ report });
  } catch (err) {
    next(err);
  }
});

// POST /playbook-check/:tradeId
router.post('/playbook-check/:tradeId', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { tradeId } = req.params;

    const [tradeResult, playbookResult] = await Promise.all([
      supabase
        .from('trades')
        .select('*')
        .eq('id', tradeId)
        .eq('user_id', req.userId!)
        .single(),
      supabase
        .from('playbook_entries')
        .select('*')
        .eq('user_id', req.userId!),
    ]);

    if (tradeResult.error || !tradeResult.data) {
      res.status(404).json({ error: 'Trade not found' });
      return;
    }

    if (playbookResult.error) throw playbookResult.error;

    const analysis = await compareTradeToPlaybook(
      tradeResult.data as Trade,
      playbookResult.data || []
    );
    res.json({ analysis });
  } catch (err) {
    next(err);
  }
});

// POST /filter-news
router.post('/filter-news', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { headlines } = req.body;
    if (!Array.isArray(headlines)) {
      res.status(400).json({ error: 'headlines array required' });
      return;
    }
    const items = await filterNewsItems(headlines.slice(0, 40));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

export default router;
