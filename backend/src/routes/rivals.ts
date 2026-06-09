import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

const router = Router();

type RequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
type RivalStats = {
  dailyJournalStreak: number;
  dailyJournalScore: number;
  tradingJournalScore: number;
  backtestSessions: number;
  processScore: number;
  winRate: number | null;
  avgR: number | null;
};

const EMPTY_STATS: RivalStats = {
  dailyJournalStreak: 0,
  dailyJournalScore: 0,
  tradingJournalScore: 0,
  backtestSessions: 0,
  processScore: 0,
  winRate: null,
  avgR: null,
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

function normalizeStats(value: unknown): RivalStats {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    dailyJournalStreak: nonNegativeInt(raw.dailyJournalStreak),
    dailyJournalScore: clampScore(raw.dailyJournalScore),
    tradingJournalScore: clampScore(raw.tradingJournalScore),
    backtestSessions: nonNegativeInt(raw.backtestSessions),
    processScore: clampScore(raw.processScore),
    winRate: nullableNumber(raw.winRate),
    avgR: nullableNumber(raw.avgR),
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
}) {
  const username = profile.username;
  return {
    userId: profile.user_id,
    username,
    displayName: profile.display_name || username,
    avatarInitials: initialsFromUsername(username),
    avatarColor: profile.avatar_color || '#f59e0b',
    avatarUrl: profile.avatar_url || null,
    stats: normalizeStats(profile.stats ?? EMPTY_STATS),
  };
}

// GET /profile
router.get('/profile', authMiddleware, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const profile = await getProfileByUserId(req.userId!);
    res.json(profile ? toRivalProfile(profile) : null);
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

    res.json(toRivalProfile(data));
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

    res.json(toRivalProfile(data));
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
    res.json(profile && profile.user_id !== req.userId ? toRivalProfile(profile) : null);
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
      const { data: profiles, error: profilesError } = await supabase
        .from('rival_profiles')
        .select('user_id, username, display_name, avatar_color, avatar_url, stats')
        .in('user_id', otherUserIds);
      if (profilesError) throw profilesError;
      for (const profile of profiles ?? []) profilesById.set(profile.user_id, toRivalProfile(profile));
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
      profile: toRivalProfile(recipient),
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
      profile: profile ? toRivalProfile(profile) : null,
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
