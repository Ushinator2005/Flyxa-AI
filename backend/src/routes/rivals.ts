import { Router, Response, NextFunction } from 'express';
import { authMiddleware } from '../middleware/auth';
import { supabase } from '../services/supabase';
import { AuthenticatedRequest } from '../types/index';

const router = Router();

type RequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

function isMissingRivalsTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("public.rival_profiles") || message.includes("public.rival_requests");
}

function withRivalsSetupHint(error: unknown): Error {
  if (!isMissingRivalsTableError(error)) return error instanceof Error ? error : new Error(String(error));
  const setupError = new Error('Rivals database tables are missing. Run Supabase migration 013_create_rivals.sql.');
  (setupError as Error & { statusCode?: number }).statusCode = 503;
  return setupError;
}

function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{3,24}$/.test(cleaned) ? cleaned : null;
}

function initialsFromUsername(username: string): string {
  return username.slice(0, 2).toUpperCase();
}

async function getProfileByUserId(userId: string) {
  const { data, error } = await supabase
    .from('rival_profiles')
    .select('user_id, username, display_name, avatar_color')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function getProfileByUsername(username: string) {
  const { data, error } = await supabase
    .from('rival_profiles')
    .select('user_id, username, display_name, avatar_color')
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
}) {
  const username = profile.username;
  return {
    userId: profile.user_id,
    username,
    displayName: profile.display_name || username,
    avatarInitials: initialsFromUsername(username),
    avatarColor: profile.avatar_color || '#f59e0b',
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

    const { data, error } = await supabase
      .from('rival_profiles')
      .upsert({
        user_id: req.userId!,
        username,
        display_name: displayName,
        avatar_color: avatarColor,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })
      .select('user_id, username, display_name, avatar_color')
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ error: 'That username is already taken.' });
        return;
      }
      throw error;
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
        .select('user_id, username, display_name, avatar_color')
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
    res.json(data);
  } catch (err) {
    next(withRivalsSetupHint(err));
  }
});

export default router;
