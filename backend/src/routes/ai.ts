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

    if (requestTrade && typeof requestTrade === 'object' && requestTrade.symbol) {
      const analysis = await analyzeIndividualTrade({
        ...requestTrade,
        id: typeof requestTrade.id === 'string' ? requestTrade.id : tradeId,
        user_id: req.userId!,
      } as Trade);
      res.json({ analysis });
      return;
    }

    const { data: trade, error } = await supabase
      .from('trades')
      .select('*')
      .eq('id', tradeId)
      .eq('user_id', req.userId!)
      .single();

    if (error || !trade) {
      res.status(404).json({ error: 'Trade not found' });
      return;
    }

    const analysis = await analyzeIndividualTrade(trade as Trade);
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
