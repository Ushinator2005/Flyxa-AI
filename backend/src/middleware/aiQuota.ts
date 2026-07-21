import { Response, NextFunction } from 'express';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

const DAILY_LIMIT = Number(process.env.AI_DAILY_CALL_LIMIT ?? 50);

/**
 * Per-user daily cap on Claude-backed endpoints. Each call atomically
 * increments a (user, UTC day) counter in ai_usage; once the counter exceeds
 * AI_DAILY_CALL_LIMIT the request is rejected with 429.
 *
 * Fails open (allows the request) if the counter table/function is missing or
 * errors, so AI features never hard-break on infrastructure issues.
 */
export async function aiQuotaMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: 'No authorization token provided' });
    return;
  }

  try {
    const day = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.rpc('increment_ai_usage', {
      p_user_id: req.userId,
      p_day: day,
    });

    if (error) {
      console.warn('[aiQuota] increment failed, allowing request:', error.message);
      next();
      return;
    }

    const count = typeof data === 'number' ? data : Number(data);
    if (Number.isFinite(count) && count > DAILY_LIMIT) {
      res.status(429).json({
        error: `Daily AI limit reached (${DAILY_LIMIT} calls/day). Resets at midnight UTC.`,
      });
      return;
    }

    next();
  } catch (err) {
    console.warn('[aiQuota] unexpected error, allowing request:', err);
    next();
  }
}
