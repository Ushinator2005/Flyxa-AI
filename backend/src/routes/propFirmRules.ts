import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { AuthenticatedRequest } from '../types/index';
import { supabase } from '../services/supabase';
import { mapRuleRow, TOPSTEP_RULES } from '../services/propFirmRules';

const router = Router();

router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firm = String(req.query.firm ?? 'Topstep').trim();
    if (firm.toLowerCase() !== 'topstep') {
      return res.json({ rules: [], source: 'database', fallback: false });
    }

    const { data, error } = await supabase
      .from('prop_firm_rule_versions')
      .select('*')
      .eq('firm_slug', 'topstep')
      .eq('status', 'verified')
      .order('account_size', { ascending: true })
      .order('path', { ascending: true });

    if (error || !data?.length) {
      return res.json({
        rules: TOPSTEP_RULES,
        source: 'bundled-verified-catalog',
        fallback: true,
        note: error
          ? 'The prop-firm rules migration is not available yet. Using the bundled verified Topstep catalog.'
          : 'No database records were found. Using the bundled verified Topstep catalog.',
      });
    }

    return res.json({
      rules: data.map(row => mapRuleRow(row as Record<string, unknown>)),
      source: 'database',
      fallback: false,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
