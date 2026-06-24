import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';
import { normalizeConfluences } from '../utils/confluenceTags';

const router = Router();

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isTradeDirection(value: unknown): value is 'Long' | 'Short' {
  return value === 'Long' || value === 'Short';
}

function isExitReason(value: unknown): value is 'TP' | 'SL' | 'BE' {
  return value === 'TP' || value === 'SL' || value === 'BE';
}

function hasValidPriceStructure(direction: 'Long' | 'Short', entry: number, stop: number, target: number): boolean {
  return direction === 'Long'
    ? stop < entry && entry < target
    : target < entry && entry < stop;
}

function getNormalizedExitPrice(exitReason: 'TP' | 'SL' | 'BE', stop: number, target: number, entry: number): number {
  if (exitReason === 'TP') return target;
  if (exitReason === 'BE') return entry;
  return stop;
}

function getSession(time: string): string {
  const [hStr, mStr] = time.split(':');
  const h = Number(hStr);
  const m = Number(mStr) || 0;
  const mins = h * 60 + m;
  // Priority order mirrors the frontend: NY beats London in the 09:30-11:30 overlap.
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'New York';
  if (mins >= 7 * 60 && mins < 9 * 60 + 30) return 'Pre Market';
  if (mins >= 3 * 60 && mins < 11 * 60 + 30) return 'London';
  if (mins >= 19 * 60 || mins < 4 * 60) return 'Asia';
  return 'Other';
}

function isMissingColumnError(error: unknown, column: string): boolean {
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  return message.includes(`'${column}'`) &&
    message.includes("'trades'") &&
    message.includes('schema cache');
}

function normalizeStringArray(value: unknown, fallback: string[] = [], maxItems = 12): string[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : fallback;
  const deduped = new Set<string>();
  const normalized: string[] = [];

  for (const entry of rawValues) {
    if (typeof entry !== 'string') continue;
    const cleaned = entry.trim().replace(/\s+/g, ' ');
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (deduped.has(key)) continue;
    deduped.add(key);
    normalized.push(cleaned.slice(0, 64));
    if (normalized.length >= maxItems) break;
  }

  return normalized;
}

function normalizeAccountIds(value: unknown, fallback?: string): string[] {
  return normalizeStringArray(value, fallback ? [fallback] : [], 20);
}

function normalizeBehavioralFlags(value: unknown): string[] {
  return normalizeStringArray(value, [], 20)
    .map(flag => flag.toLowerCase() === 'off-playbook' ? 'incorrect-stop-loss' : flag);
}

// GET all trades for user
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabase
      .from('trades')
      .select('*')
      .eq('user_id', req.userId!)
      .order('trade_date', { ascending: false })
      .order('trade_time', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST create trade
router.post('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const {
      symbol,
      screenshot_url,
      accountId,
      account_id,
      accountIds,
      account_ids,
      direction,
      entry_price,
      sl_price,
      tp_price,
      exit_reason,
      contract_size,
      point_value,
      trade_date,
      trade_time,
      trade_length_seconds,
      candle_count,
      timeframe_minutes,
      emotional_state,
      confidence_level,
      pre_trade_notes,
      post_trade_notes,
      confluences,
      followed_plan,
      behavioral_flags,
      commission,
    } = req.body;

    const isBreakeven = exit_reason === 'BE';

    if (
      typeof symbol !== 'string' ||
      !symbol.trim() ||
      !isTradeDirection(direction) ||
      !isFiniteNumber(entry_price) ||
      !isExitReason(exit_reason) ||
      typeof trade_date !== 'string' ||
      typeof trade_time !== 'string' ||
      // SL/TP only required for non-BE trades
      (!isBreakeven && (!isFiniteNumber(sl_price) || !isFiniteNumber(tp_price)))
    ) {
      res.status(400).json({ error: 'Missing or invalid required trade fields' });
      return;
    }

    if (!isBreakeven && !hasValidPriceStructure(direction, entry_price, sl_price, tp_price)) {
      res.status(400).json({ error: 'Entry, stop, and target levels do not match the selected trade direction' });
      return;
    }

    const normalizedContractSize = isFiniteNumber(contract_size) ? contract_size : 1;
    const normalizedPointValue = isFiniteNumber(point_value) ? point_value : 1;
    const normalizedExitPrice = getNormalizedExitPrice(exit_reason, sl_price, tp_price, entry_price);

    // Calculate P&L
    const pnl = direction === 'Long'
      ? (normalizedExitPrice - entry_price) * normalizedContractSize * normalizedPointValue
      : (entry_price - normalizedExitPrice) * normalizedContractSize * normalizedPointValue;

    // Determine session
    const session = getSession(trade_time);
    const normalizedConfluences = normalizeConfluences(confluences);
    const primaryAccountId = Array.isArray(accountIds) && typeof accountIds[0] === 'string'
      ? accountIds[0]
      : Array.isArray(account_ids) && typeof account_ids[0] === 'string'
        ? account_ids[0]
        : typeof accountId === 'string'
          ? accountId
          : typeof account_id === 'string'
            ? account_id
            : '';
    const normalizedAccountIds = normalizeAccountIds(
      Array.isArray(accountIds) && accountIds.length > 0 ? accountIds : account_ids,
      primaryAccountId
    );
    const normalizedBehavioralFlags = normalizeBehavioralFlags(behavioral_flags);

    const insertPayload = {
      user_id: req.userId!,
      symbol,
      screenshot_url: typeof screenshot_url === 'string' ? screenshot_url : '',
      account_id: primaryAccountId,
      ...(normalizedAccountIds.length > 0 ? { account_ids: normalizedAccountIds } : {}),
      direction,
      entry_price,
      exit_price: normalizedExitPrice,
      sl_price,
      tp_price,
      exit_reason,
      pnl,
      contract_size: normalizedContractSize,
      point_value: normalizedPointValue,
      trade_date,
      trade_time,
      trade_length_seconds,
      candle_count,
      timeframe_minutes,
      emotional_state,
      confidence_level,
      pre_trade_notes: pre_trade_notes || '',
      post_trade_notes: post_trade_notes || '',
      ...(normalizedConfluences.length > 0 ? { confluences: normalizedConfluences } : {}),
      followed_plan: followed_plan !== undefined ? followed_plan : true,
      behavioral_flags: normalizedBehavioralFlags,
      session,
      ...(isFiniteNumber(commission) && commission >= 0 ? { commission } : { commission: 0 }),
    };

    let { data, error } = await supabase
      .from('trades')
      .insert(insertPayload)
      .select()
      .single();

    // Allow trade saves to continue until the live database has the new column.
    if (
      error &&
      (
        isMissingColumnError(error, 'screenshot_url') ||
        isMissingColumnError(error, 'account_id') ||
        isMissingColumnError(error, 'account_ids') ||
        isMissingColumnError(error, 'confluences') ||
        isMissingColumnError(error, 'behavioral_flags') ||
        isMissingColumnError(error, 'commission')
      )
    ) {
      const {
        screenshot_url: _ignoredScreenshotUrl,
        account_id: _ignoredAccountId,
        account_ids: _ignoredAccountIds,
        confluences: _ignoredConfluences,
        behavioral_flags: _ignoredBehavioralFlags,
        commission: _ignoredCommission,
        ...fallbackInsertPayload
      } = insertPayload;
      ({ data, error } = await supabase
        .from('trades')
        .insert(fallbackInsertPayload)
        .select()
        .single());
    }

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// PUT update trade
router.put('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('trades')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      res.status(404).json({ error: 'Trade not found' });
      return;
    }

    if (existing.user_id !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const {
      id: _ignoredId,
      user_id: _ignoredUserId,
      created_at: _ignoredCreatedAt,
      pnl: _ignoredPnl,
      session: _ignoredSession,
      ...updateData
    } = req.body as Record<string, unknown>;

    const merged = { ...existing, ...updateData };

    const mergedExitReason = merged.exit_reason;
    const isBreakevenUpdate = mergedExitReason === 'BE';

    if (
      typeof merged.symbol !== 'string' ||
      !merged.symbol.trim() ||
      !isTradeDirection(merged.direction) ||
      !isFiniteNumber(merged.entry_price) ||
      !isExitReason(mergedExitReason) ||
      typeof merged.trade_time !== 'string' ||
      // SL/TP only required for non-BE trades
      (!isBreakevenUpdate && (!isFiniteNumber(merged.sl_price) || !isFiniteNumber(merged.tp_price)))
    ) {
      res.status(400).json({ error: 'Updated trade is missing required fields' });
      return;
    }

    if (
      !isBreakevenUpdate &&
      !hasValidPriceStructure(merged.direction, merged.entry_price, merged.sl_price as number, merged.tp_price as number)
    ) {
      res.status(400).json({ error: 'Entry, stop, and target levels do not match the selected trade direction' });
      return;
    }

    const normalizedExitPrice = getNormalizedExitPrice(merged.exit_reason, merged.sl_price, merged.tp_price, merged.entry_price);
    const normalizedContractSize = isFiniteNumber(merged.contract_size) ? merged.contract_size : 1;
    const normalizedPointValue = isFiniteNumber(merged.point_value) ? merged.point_value : 1;

    const nextUpdateData = { ...updateData };
    if (typeof nextUpdateData.accountId === 'string' && !('account_id' in nextUpdateData)) {
      nextUpdateData.account_id = nextUpdateData.accountId;
    }
    if (Array.isArray(nextUpdateData.account_ids) && typeof nextUpdateData.account_ids[0] === 'string' && !('account_id' in nextUpdateData)) {
      nextUpdateData.account_id = nextUpdateData.account_ids[0];
    }
    if (Array.isArray(nextUpdateData.accountIds) && typeof nextUpdateData.accountIds[0] === 'string') {
      nextUpdateData.account_id = nextUpdateData.accountIds[0];
    }
    const accountIdSource = Array.isArray(nextUpdateData.accountIds) && nextUpdateData.accountIds.length > 0
      ? nextUpdateData.accountIds
      : Array.isArray(nextUpdateData.account_ids) && nextUpdateData.account_ids.length > 0
        ? nextUpdateData.account_ids
        : (merged as Record<string, unknown>).account_ids;
    nextUpdateData.account_ids = normalizeAccountIds(accountIdSource, nextUpdateData.account_id as string | undefined);
    delete nextUpdateData.accountId;
    delete nextUpdateData.accountIds;
    if ('behavioral_flags' in nextUpdateData) {
      nextUpdateData.behavioral_flags = normalizeBehavioralFlags(nextUpdateData.behavioral_flags);
    }
    const existingRecord = existing as Record<string, unknown>;
    const shouldPersistConfluences = 'confluences' in updateData || Array.isArray(existingRecord.confluences);
    if (shouldPersistConfluences) {
      nextUpdateData.confluences = normalizeConfluences((merged as Record<string, unknown>).confluences);
    }

    nextUpdateData.exit_price = normalizedExitPrice;
    nextUpdateData.pnl = merged.direction === 'Long'
      ? (normalizedExitPrice - merged.entry_price) * normalizedContractSize * normalizedPointValue
      : (merged.entry_price - normalizedExitPrice) * normalizedContractSize * normalizedPointValue;
    nextUpdateData.session = getSession(merged.trade_time);

    let { data, error } = await supabase
      .from('trades')
      .update(nextUpdateData)
      .eq('id', id)
      .select()
      .single();

    if (
      error &&
      (
        (isMissingColumnError(error, 'screenshot_url') && 'screenshot_url' in nextUpdateData) ||
        (isMissingColumnError(error, 'account_id') && ('account_id' in nextUpdateData || 'accountId' in nextUpdateData)) ||
        (isMissingColumnError(error, 'account_ids') && 'account_ids' in nextUpdateData) ||
        (isMissingColumnError(error, 'confluences') && 'confluences' in nextUpdateData) ||
        (isMissingColumnError(error, 'behavioral_flags') && 'behavioral_flags' in nextUpdateData) ||
        (isMissingColumnError(error, 'commission') && 'commission' in nextUpdateData)
      )
    ) {
      const {
        screenshot_url: _ignoredScreenshotUrl,
        account_id: _ignoredAccountId,
        account_ids: _ignoredAccountIds,
        accountId: _ignoredAccountIdAlias,
        confluences: _ignoredConfluences,
        behavioral_flags: _ignoredBehavioralFlags,
        commission: _ignoredCommission,
        ...fallbackUpdateData
      } = nextUpdateData;
      ({ data, error } = await supabase
        .from('trades')
        .update(fallbackUpdateData)
        .eq('id', id)
        .select()
        .single());
    }

    if (error) throw error;
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE trade
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('trades')
      .select('user_id')
      .eq('id', id)
      .single();

    if (fetchError || !existing) {
      res.status(404).json({ error: 'Trade not found' });
      return;
    }

    if (existing.user_id !== req.userId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const { error } = await supabase
      .from('trades')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /shared-with-me — trades rivals have shared with the current user
router.get('/shared-with-me', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: shares, error: sharesError } = await supabase
      .from('trade_shares')
      .select('id, shared_at, shared_by_user_id, trade_snapshot')
      .eq('shared_with_user_id', req.userId!)
      .order('shared_at', { ascending: false });

    if (sharesError) throw sharesError;
    if (!shares || shares.length === 0) {
      res.json([]);
      return;
    }

    const sharerIds = [...new Set(shares.map(s => s.shared_by_user_id as string))];
    const { data: profiles } = await supabase
      .from('rival_profiles')
      .select('user_id, username, display_name, avatar_color, avatar_url')
      .in('user_id', sharerIds);

    const profileMap = Object.fromEntries((profiles ?? []).map(p => [p.user_id as string, p]));

    res.json(shares.map(share => ({
      shareId: share.id,
      sharedAt: share.shared_at,
      sharedByUserId: share.shared_by_user_id,
      sharedByProfile: profileMap[share.shared_by_user_id as string] ?? null,
      trade: share.trade_snapshot,
    })));
  } catch (err) {
    next(err);
  }
});

// POST /share — share a trade snapshot with an accepted rival
router.post('/share', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { rivalUserId, tradeId, tradeData } = req.body as {
      rivalUserId?: unknown;
      tradeId?: unknown;
      tradeData?: unknown;
    };

    if (typeof rivalUserId !== 'string' || !rivalUserId.trim()) {
      res.status(400).json({ error: 'rivalUserId is required' });
      return;
    }
    if (typeof tradeId !== 'string' || !tradeId.trim()) {
      res.status(400).json({ error: 'tradeId is required' });
      return;
    }
    if (!tradeData || typeof tradeData !== 'object') {
      res.status(400).json({ error: 'tradeData is required' });
      return;
    }

    // Must be an accepted rival
    const { data: rivalRel } = await supabase
      .from('rival_requests')
      .select('id')
      .eq('status', 'accepted')
      .or(`and(requester_id.eq.${req.userId},recipient_id.eq.${rivalUserId}),and(requester_id.eq.${rivalUserId},recipient_id.eq.${req.userId})`)
      .maybeSingle();

    if (!rivalRel) {
      res.status(403).json({ error: 'You can only share trades with accepted rivals' });
      return;
    }

    const { data, error } = await supabase
      .from('trade_shares')
      .upsert(
        {
          trade_id_ref: tradeId,
          shared_by_user_id: req.userId!,
          shared_with_user_id: rivalUserId,
          trade_snapshot: tradeData,
        },
        { onConflict: 'trade_id_ref,shared_with_user_id' },
      )
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /share/:tradeIdRef/:rivalUserId — remove a share
router.delete('/share/:tradeIdRef/:rivalUserId', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { tradeIdRef, rivalUserId } = req.params;

    const { error } = await supabase
      .from('trade_shares')
      .delete()
      .eq('trade_id_ref', tradeIdRef)
      .eq('shared_by_user_id', req.userId!)
      .eq('shared_with_user_id', rivalUserId);

    if (error) throw error;
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
