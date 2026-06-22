import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

const router = Router();

type RequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
type LeaderboardPeriod = 'week' | 'month' | 'season' | 'allTime';
type RivalPeriodStats = {
  netPnl: number;
  winRate: number;
  tradeCount: number;
  tradingDays: number;
  greenDays: number;
  maxDrawdown: number;
  consistency: number;
  ruleAdherence: number;
  riskAdjusted: number;
  equityCurve: number[];
};
type RivalStats = {
  lifetimeXp: number;
  dailyJournalStreak: number;
  dailyJournalScore: number;
  tradingJournalScore: number;
  backtestSessions: number;
  processScore: number;
  winRate: number | null;
  avgR: number | null;
  netPnl: number | null;
  periods?: Partial<Record<LeaderboardPeriod, RivalPeriodStats>>;
  previousPeriods?: Partial<Record<Exclude<LeaderboardPeriod, 'allTime'>, RivalPeriodStats>>;
};

const EMPTY_STATS: RivalStats = {
  lifetimeXp: 0,
  dailyJournalStreak: 0,
  dailyJournalScore: 0,
  tradingJournalScore: 0,
  backtestSessions: 0,
  processScore: 0,
  winRate: null,
  avgR: null,
  netPnl: null,
};

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

function isMissingRivalsTableError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return message.includes("rival_profiles") || message.includes("rival_requests");
}

function withRivalsSetupHint(error: unknown): Error {
  if (isMissingRivalsTableError(error)) {
    const setupError = new Error('Rivals database tables are missing. Run Supabase migration 013_create_rivals.sql.');
    (setupError as Error & { statusCode?: number }).statusCode = 503;
    return setupError;
  }
  if (error instanceof Error) return error;
  return new Error(extractErrorMessage(error));
}

function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,24}$/.test(cleaned) ? cleaned : null;
}

function initialsFromUsername(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

function clampScore(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function nonNegativeInt(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric));
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : null;
}

function isMissingCommissionColumnError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return message.includes("'commission'") &&
    message.includes("'trades'") &&
    message.includes('schema cache');
}

type PerformanceBundle = {
  periods: Record<LeaderboardPeriod, RivalPeriodStats>;
  previousPeriods: Record<Exclude<LeaderboardPeriod, 'allTime'>, RivalPeriodStats>;
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function periodBounds(period: Exclude<LeaderboardPeriod, 'allTime'>, previous = false): [string, string] {
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  let start = new Date(now);
  let end = new Date(now);
  if (period === 'week') {
    const mondayOffset = (now.getUTCDay() + 6) % 7;
    start.setUTCDate(now.getUTCDate() - mondayOffset - (previous ? 7 : 0));
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 6);
  } else if (period === 'month') {
    start.setUTCDate(now.getUTCDate() - (previous ? 59 : 29));
    end.setUTCDate(now.getUTCDate() - (previous ? 30 : 0));
  } else {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (previous ? 1 : 0), 1));
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (previous ? 0 : -1), 0));
  }
  return [isoDate(start), isoDate(end)];
}

function emptyPeriodStats(): RivalPeriodStats {
  return { netPnl: 0, winRate: 0, tradeCount: 0, tradingDays: 0, greenDays: 0, maxDrawdown: 0, consistency: 0, ruleAdherence: 0, riskAdjusted: 0, equityCurve: [] };
}

function normalizePeriodStats(value: unknown): RivalPeriodStats | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const finiteNumber = (field: string, fallback = 0) => {
    const numeric = typeof raw[field] === 'number' ? raw[field] : Number(raw[field]);
    return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : fallback;
  };
  const equityCurve = Array.isArray(raw.equityCurve)
    ? raw.equityCurve
      .map(point => Number(point))
      .filter(Number.isFinite)
      .slice(-24)
      .map(point => Math.round(point * 100) / 100)
    : [];
  return {
    netPnl: finiteNumber('netPnl'),
    winRate: clampScore(raw.winRate),
    tradeCount: nonNegativeInt(raw.tradeCount),
    tradingDays: nonNegativeInt(raw.tradingDays),
    greenDays: nonNegativeInt(raw.greenDays),
    maxDrawdown: Math.max(0, finiteNumber('maxDrawdown')),
    consistency: clampScore(raw.consistency),
    ruleAdherence: clampScore(raw.ruleAdherence),
    riskAdjusted: finiteNumber('riskAdjusted'),
    equityCurve,
  };
}

function normalizePeriods(
  value: unknown,
  allowedPeriods: LeaderboardPeriod[]
): Partial<Record<LeaderboardPeriod, RivalPeriodStats>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(
    allowedPeriods
      .map(period => [period, normalizePeriodStats(raw[period])] as const)
      .filter((entry): entry is readonly [LeaderboardPeriod, RivalPeriodStats] => entry[1] !== null)
  );
}

function summarizeTrades(trades: Array<Record<string, unknown>>, bounds?: [string, string]): RivalPeriodStats {
  const filtered = trades
    .filter(trade => {
      const date = String(trade.trade_date ?? '');
      return !bounds || (date >= bounds[0] && date <= bounds[1]);
    })
    .sort((a, b) => `${a.trade_date ?? ''} ${a.trade_time ?? ''}`.localeCompare(`${b.trade_date ?? ''} ${b.trade_time ?? ''}`));
  if (filtered.length === 0) return emptyPeriodStats();
  const daily = new Map<string, number>();
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let wins = 0;
  let evaluated = 0;
  let followed = 0;
  const equityCurve: number[] = [];
  for (const trade of filtered) {
    const pnl = Number(trade.pnl);
    const commission = Number(trade.commission ?? 0);
    const net = (Number.isFinite(pnl) ? pnl : 0) - (Number.isFinite(commission) ? commission : 0);
    cumulative += net;
    if (net > 0) wins += 1;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    const date = String(trade.trade_date ?? '');
    daily.set(date, (daily.get(date) ?? 0) + net);
    if (typeof trade.followed_plan === 'boolean') {
      evaluated += 1;
      if (trade.followed_plan) followed += 1;
    }
    equityCurve.push(Math.round(cumulative * 100) / 100);
  }
  const greenDays = [...daily.values()].filter(value => value > 0).length;
  const positiveShare = daily.size ? greenDays / daily.size : 0;
  const drawdownPenalty = Math.min(1, maxDrawdown / Math.max(Math.abs(cumulative), 1));
  return {
    netPnl: Math.round(cumulative * 100) / 100,
    winRate: Math.round((wins / filtered.length) * 100),
    tradeCount: filtered.length,
    tradingDays: daily.size,
    greenDays,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    consistency: Math.round(Math.max(0, Math.min(100, positiveShare * 75 + (1 - drawdownPenalty) * 25))),
    ruleAdherence: evaluated ? Math.round((followed / evaluated) * 100) : 0,
    riskAdjusted: Math.round((cumulative / Math.max(maxDrawdown, 1)) * 100) / 100,
    equityCurve: equityCurve.slice(-24),
  };
}

function tradesFromStoreBlob(userId: string, value: unknown): Array<Record<string, unknown>> {
  const blob = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const state = blob.state && typeof blob.state === 'object'
    ? blob.state as Record<string, unknown>
    : {};
  const entries = Array.isArray(state.entries) ? state.entries : [];
  return entries.flatMap(entryValue => {
    if (!entryValue || typeof entryValue !== 'object') return [];
    const entry = entryValue as Record<string, unknown>;
    const entryDate = typeof entry.date === 'string' ? entry.date : '';
    const trades = Array.isArray(entry.trades) ? entry.trades : [];
    return trades.flatMap(tradeValue => {
      if (!tradeValue || typeof tradeValue !== 'object') return [];
      const trade = tradeValue as Record<string, unknown>;
      const reflection = trade.reflection && typeof trade.reflection === 'object'
        ? trade.reflection as Record<string, unknown>
        : {};
      return [{
        user_id: userId,
        pnl: trade.pnl,
        commission: trade.commission,
        trade_date: typeof trade.date === 'string' ? trade.date : entryDate,
        trade_time: trade.time,
        followed_plan: typeof reflection.followedPlan === 'boolean' ? reflection.followedPlan : null,
      }];
    });
  });
}

async function getPerformanceByUserIds(userIds: string[]): Promise<Map<string, PerformanceBundle>> {
  const result = new Map<string, PerformanceBundle>();
  if (userIds.length === 0) return result;
  let { data, error } = await supabase
    .from('trades')
    .select('user_id, pnl, commission, trade_date, trade_time, followed_plan')
    .in('user_id', userIds);

  if (error && isMissingCommissionColumnError(error)) {
    const fallback = await supabase
      .from('trades')
      .select('user_id, pnl, trade_date, trade_time, followed_plan')
      .in('user_id', userIds);
    data = fallback.data as typeof data;
    error = fallback.error;
  }

  if (error) throw error;
  const tradesByUserId = new Map<string, Array<Record<string, unknown>>>();
  for (const userId of userIds) {
    const trades = (data ?? []).filter(trade => String(trade.user_id) === userId) as Array<Record<string, unknown>>;
    if (trades.length > 0) tradesByUserId.set(userId, trades);
  }

  const usersWithoutLegacyTrades = userIds.filter(userId => !tradesByUserId.has(userId));
  if (usersWithoutLegacyTrades.length > 0) {
    const { data: stores, error: storesError } = await supabase
      .from('user_store')
      .select('user_id, flyxa_data')
      .in('user_id', usersWithoutLegacyTrades);
    if (storesError) throw storesError;
    for (const store of stores ?? []) {
      const storeTrades = tradesFromStoreBlob(String(store.user_id), store.flyxa_data);
      if (storeTrades.length > 0) tradesByUserId.set(String(store.user_id), storeTrades);
    }
  }

  for (const userId of userIds) {
    const trades = tradesByUserId.get(userId);
    // If neither persistence path has trades, keep the last published profile
    // snapshot instead of overwriting it with synthetic zeroes.
    if (!trades?.length) continue;
    result.set(userId, {
      periods: {
        allTime: summarizeTrades(trades),
        week: summarizeTrades(trades, periodBounds('week')),
        month: summarizeTrades(trades, periodBounds('month')),
        season: summarizeTrades(trades, periodBounds('season')),
      },
      previousPeriods: {
        week: summarizeTrades(trades, periodBounds('week', true)),
        month: summarizeTrades(trades, periodBounds('month', true)),
        season: summarizeTrades(trades, periodBounds('season', true)),
      },
    });
  }
  return result;
}

function normalizeStats(value: unknown): RivalStats {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const periods = normalizePeriods(raw.periods, ['week', 'month', 'season', 'allTime']);
  const previousPeriods = normalizePeriods(
    raw.previousPeriods,
    ['week', 'month', 'season']
  ) as Partial<Record<Exclude<LeaderboardPeriod, 'allTime'>, RivalPeriodStats>>;
  return {
    lifetimeXp: nonNegativeInt(raw.lifetimeXp),
    dailyJournalStreak: nonNegativeInt(raw.dailyJournalStreak),
    dailyJournalScore: clampScore(raw.dailyJournalScore),
    tradingJournalScore: clampScore(raw.tradingJournalScore),
    backtestSessions: nonNegativeInt(raw.backtestSessions),
    processScore: clampScore(raw.processScore),
    winRate: nullableNumber(raw.winRate),
    avgR: nullableNumber(raw.avgR),
    netPnl: nullableNumber(raw.netPnl),
    ...(Object.keys(periods).length > 0 ? { periods } : {}),
    ...(Object.keys(previousPeriods).length > 0 ? { previousPeriods } : {}),
  };
}

async function getProfileByUserId(userId: string) {
  const { data, error } = await supabase
    .from('rival_profiles')
    .select('user_id, username, display_name, avatar_color, avatar_url, stats')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getProfileByUsername(username: string) {
  const { data, error } = await supabase
    .from('rival_profiles')
    .select('user_id, username, display_name, avatar_color, avatar_url, stats')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function toRivalProfile(profile: {
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_color: string | null;
  avatar_url?: string | null;
  stats?: unknown;
}, performance?: PerformanceBundle) {
  const username = profile.username;
  const stats = normalizeStats(profile.stats ?? EMPTY_STATS);
  if (performance) {
    stats.netPnl = performance.periods.allTime.netPnl;
    stats.winRate = performance.periods.allTime.winRate;
    stats.periods = Object.fromEntries(
      (['week', 'month', 'season', 'allTime'] as LeaderboardPeriod[]).map(period => [
        period,
        {
          ...performance.periods[period],
          ruleAdherence: stats.periods?.[period]?.ruleAdherence ?? performance.periods[period].ruleAdherence,
        },
      ])
    ) as Record<LeaderboardPeriod, RivalPeriodStats>;
    stats.previousPeriods = Object.fromEntries(
      (['week', 'month', 'season'] as const).map(period => [
        period,
        {
          ...performance.previousPeriods[period],
          ruleAdherence: stats.previousPeriods?.[period]?.ruleAdherence ?? performance.previousPeriods[period].ruleAdherence,
        },
      ])
    ) as Record<Exclude<LeaderboardPeriod, 'allTime'>, RivalPeriodStats>;
  }
  return {
    userId: profile.user_id,
    username,
    displayName: profile.display_name || username,
    avatarInitials: initialsFromUsername(username),
    avatarColor: profile.avatar_color || '#f59e0b',
    avatarUrl: profile.avatar_url || null,
    stats,
  };
}

async function toRivalProfileWithPnl(profile: Parameters<typeof toRivalProfile>[0]) {
  const performance = await getPerformanceByUserIds([profile.user_id]);
  return toRivalProfile(profile, performance.get(profile.user_id));
}

// GET /profile
router.get('/profile', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await getProfileByUserId(req.userId!);
    res.json(profile ? await toRivalProfileWithPnl(profile) : null);
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

// PUT /profile
router.put('/profile', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const username = normalizeUsername((req.body as { username?: unknown }).username);
    if (!username) {
      res.status(400).json({ error: 'Username must be 3-24 characters using letters, numbers, or underscores.' });
      return;
    }

    const displayNameRaw = (req.body as { displayName?: unknown }).displayName;
    const displayName = typeof displayNameRaw === 'string' && displayNameRaw.trim()
      ? displayNameRaw.trim().slice(0, 40)
      : username;

    const avatarColorRaw = (req.body as { avatarColor?: unknown }).avatarColor;
    const avatarColor = typeof avatarColorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(avatarColorRaw)
      ? avatarColorRaw
      : '#f59e0b';
    const avatarUrlRaw = (req.body as { avatarUrl?: unknown }).avatarUrl;
    const avatarUrl = typeof avatarUrlRaw === 'string' && avatarUrlRaw.trim()
      ? avatarUrlRaw.trim().slice(0, 2000)
      : null;

    const profileUpdate: {
      user_id: string;
      username: string;
      display_name: string;
      avatar_color: string;
      avatar_url?: string | null;
      updated_at: string;
    } = {
      user_id: req.userId!,
      username,
      display_name: displayName,
      avatar_color: avatarColor,
      updated_at: new Date().toISOString(),
    };

    if (avatarUrlRaw !== undefined) {
      profileUpdate.avatar_url = avatarUrl;
    }

    const { data, error } = await supabase
      .from('rival_profiles')
      .upsert(profileUpdate, { onConflict: 'user_id' })
      .select('user_id, username, display_name, avatar_color, avatar_url, stats')
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'That username is already taken.' });
        return;
      }
      res.status(500).json({ error: error.message || 'Failed to save profile.' });
      return;
    }

    res.json(await toRivalProfileWithPnl(data));
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

// PUT /profile/stats
router.put('/profile/stats', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const stats = normalizeStats((req.body as { stats?: unknown }).stats);

    const { data, error } = await supabase
      .from('rival_profiles')
      .update({
        stats,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', req.userId!)
      .select('user_id, username, display_name, avatar_color, avatar_url, stats')
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: 'Create your rival profile before publishing leaderboard stats.' });
      return;
    }

    res.json(await toRivalProfileWithPnl(data));
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

// GET /search?username=
router.get('/search', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const username = normalizeUsername(req.query.username);
    if (!username) {
      res.status(400).json({ error: 'Enter a valid username.' });
      return;
    }

    const profile = await getProfileByUsername(username);
    res.json(profile && profile.user_id !== req.userId ? await toRivalProfileWithPnl(profile) : null);
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

// GET /
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { data: requests, error } = await supabase
      .from('rival_requests')
      .select('id, requester_id, recipient_id, status, created_at, responded_at')
      .or(`requester_id.eq.${req.userId!},recipient_id.eq.${req.userId!}`)
      .order('created_at', { ascending: false });

    if (error) throw error;

    const otherUserIds = Array.from(new Set((requests ?? []).map(request => (
      request.requester_id === req.userId ? request.recipient_id : request.requester_id
    ))));

    const profilesById = new Map<string, ReturnType<typeof toRivalProfile>>();
    if (otherUserIds.length > 0) {
      const [{ data: profiles, error: profilesError }, performanceByUserId] = await Promise.all([
        supabase
          .from('rival_profiles')
          .select('user_id, username, display_name, avatar_color, avatar_url, stats')
          .in('user_id', otherUserIds),
        getPerformanceByUserIds(otherUserIds),
      ]);
      if (profilesError) throw profilesError;
      for (const profile of profiles ?? []) {
        profilesById.set(profile.user_id, toRivalProfile(profile, performanceByUserId.get(profile.user_id)));
      }
    }

    res.json((requests ?? []).map(request => {
      const otherUserId = request.requester_id === req.userId ? request.recipient_id : request.requester_id;
      return {
        id: request.id,
        status: request.status as RequestStatus,
        direction: request.requester_id === req.userId ? 'outgoing' : 'incoming',
        createdAt: request.created_at,
        respondedAt: request.responded_at,
        profile: profilesById.get(otherUserId) ?? null,
      };
    }));
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

// POST /requests
router.post('/requests', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const username = normalizeUsername((req.body as { username?: unknown }).username);
    if (!username) {
      res.status(400).json({ error: 'Enter a valid username.' });
      return;
    }

    const recipient = await getProfileByUsername(username);
    if (!recipient) {
      res.status(404).json({ error: 'No Flyxa trader found with that username.' });
      return;
    }
    if (recipient.user_id === req.userId) {
      res.status(400).json({ error: 'You cannot add yourself as a rival.' });
      return;
    }

    const { data, error } = await supabase
      .from('rival_requests')
      .upsert({
        requester_id: req.userId!,
        recipient_id: recipient.user_id,
        status: 'pending',
        responded_at: null,
      }, { onConflict: 'requester_id,recipient_id' })
      .select('id, requester_id, recipient_id, status, created_at, responded_at')
      .single();

    if (error) throw error;

    res.status(201).json({
      id: data.id,
      status: data.status,
      direction: 'outgoing',
      createdAt: data.created_at,
      respondedAt: data.responded_at,
      profile: await toRivalProfileWithPnl(recipient),
    });
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

// PUT /requests/:id
router.put('/requests/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const action = (req.body as { action?: unknown }).action;
    if (action !== 'accept' && action !== 'decline' && action !== 'cancel') {
      res.status(400).json({ error: 'Action must be accept, decline, or cancel.' });
      return;
    }

    const { data: existing, error: existingError } = await supabase
      .from('rival_requests')
      .select('id, requester_id, recipient_id, status')
      .eq('id', req.params.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing) {
      res.status(404).json({ error: 'Rival request not found.' });
      return;
    }

    const isRecipient = existing.recipient_id === req.userId;
    const isRequester = existing.requester_id === req.userId;
    if ((action === 'accept' || action === 'decline') && !isRecipient) {
      res.status(403).json({ error: 'Only the recipient can respond to this request.' });
      return;
    }
    if (action === 'cancel' && !isRequester) {
      res.status(403).json({ error: 'Only the requester can cancel this request.' });
      return;
    }

    const nextStatus: RequestStatus = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
    const { data, error } = await supabase
      .from('rival_requests')
      .update({
        status: nextStatus,
        responded_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('id, requester_id, recipient_id, status, created_at, responded_at')
      .single();

    if (error) throw error;

    const otherUserId = data.requester_id === req.userId ? data.recipient_id : data.requester_id;
    const profile = await getProfileByUserId(otherUserId);

    res.json({
      id: data.id,
      status: data.status as RequestStatus,
      direction: data.requester_id === req.userId ? 'outgoing' : 'incoming',
      createdAt: data.created_at,
      respondedAt: data.responded_at,
      profile: profile ? await toRivalProfileWithPnl(profile) : null,
    });
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────
// Supabase migration (run once in dashboard):
//
//   CREATE TABLE IF NOT EXISTS rival_messages (
//     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     sender_id UUID NOT NULL,
//     receiver_id UUID NOT NULL,
//     content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   CREATE INDEX ON rival_messages (sender_id, receiver_id, created_at DESC);
//   CREATE INDEX ON rival_messages (receiver_id, created_at DESC);

// GET /messages/:rivalUserId — fetch conversation thread
router.get('/messages/:rivalUserId', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const rivalUserId = req.params.rivalUserId;
    if (!rivalUserId || typeof rivalUserId !== 'string') {
      res.status(400).json({ error: 'Invalid rival user ID.' });
      return;
    }

    const { data, error } = await supabase
      .from('rival_messages')
      .select('id, sender_id, content, created_at')
      .or(
        `and(sender_id.eq.${req.userId!},receiver_id.eq.${rivalUserId}),` +
        `and(sender_id.eq.${rivalUserId},receiver_id.eq.${req.userId!})`
      )
      .order('created_at', { ascending: true })
      .limit(60);

    if (error) throw error;

    res.json((data ?? []).map(msg => ({
      id: msg.id,
      senderId: msg.sender_id,
      content: msg.content,
      createdAt: msg.created_at,
    })));
  } catch (err) {
    next(err);
  }
});

// POST /messages — send a message to a rival
router.post('/messages', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const toUserId = typeof (req.body as { toUserId?: unknown }).toUserId === 'string'
      ? ((req.body as { toUserId: string }).toUserId).trim()
      : null;
    const content = typeof (req.body as { content?: unknown }).content === 'string'
      ? ((req.body as { content: string }).content).trim()
      : null;

    if (!toUserId) {
      res.status(400).json({ error: 'toUserId is required.' });
      return;
    }
    if (!content || content.length < 1 || content.length > 1000) {
      res.status(400).json({ error: 'Message must be 1–1000 characters.' });
      return;
    }
    if (toUserId === req.userId) {
      res.status(400).json({ error: 'Cannot message yourself.' });
      return;
    }

    // Ensure an accepted rival relationship exists (anti-spam)
    const { data: relationship, error: relError } = await supabase
      .from('rival_requests')
      .select('id')
      .eq('status', 'accepted')
      .or(
        `and(requester_id.eq.${req.userId!},recipient_id.eq.${toUserId}),` +
        `and(requester_id.eq.${toUserId},recipient_id.eq.${req.userId!})`
      )
      .maybeSingle();

    if (relError) throw relError;
    if (!relationship) {
      res.status(403).json({ error: 'You can only message accepted rivals.' });
      return;
    }

    const { data, error } = await supabase
      .from('rival_messages')
      .insert({ sender_id: req.userId!, receiver_id: toUserId, content })
      .select('id, sender_id, content, created_at')
      .single();

    if (error) throw error;

    res.status(201).json({
      id: data.id,
      senderId: data.sender_id,
      content: data.content,
      createdAt: data.created_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
