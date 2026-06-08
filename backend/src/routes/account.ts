import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

const router = Router();

async function deleteOwnRows(table: string, userId: string): Promise<void> {
  const { error } = await supabase.from(table).delete().eq('user_id', userId);
  // 42P01 = table does not exist, 42703 = column does not exist — both are safe to ignore
  if (error && error.code !== '42P01' && error.code !== '42703') throw error;
}

// POST /api/account/reset
router.post('/reset', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.userId!;

    await Promise.all([
      deleteOwnRows('trades', userId),
      deleteOwnRows('psychology_logs', userId),
      deleteOwnRows('playbook_entries', userId),
      deleteOwnRows('journal_entries', userId),
      deleteOwnRows('risk_settings', userId),
      deleteOwnRows('trading_accounts', userId),
      deleteOwnRows('store_entries_backup', userId),
      deleteOwnRows('pre_sessions', userId),
      deleteOwnRows('user_store', userId),
    ]);

    // rival_requests uses different column names — handle table-not-found gracefully
    const { error: rrError } = await supabase
      .from('rival_requests')
      .delete()
      .or(`requester_id.eq.${userId},recipient_id.eq.${userId}`);
    if (rrError && rrError.code !== '42P01' && rrError.code !== '42703') throw rrError;

    // Reset rival profile stats but keep the username
    try {
      const { data: profile } = await supabase
        .from('rival_profiles')
        .select('username')
        .eq('user_id', userId)
        .maybeSingle();

      if (profile?.username) {
        await supabase
          .from('rival_profiles')
          .update({
            display_name: profile.username,
            avatar_color: '#f59e0b',
            avatar_url: null,
            stats: {},
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId);
      }
    } catch { /* rival_profiles table may not exist — safe to skip */ }

    res.json({ ok: true, preserved: ['username'] });
  } catch (err) {
    next(err);
  }
});

export default router;

