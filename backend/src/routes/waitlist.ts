import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { supabase } from '../services/supabase';

// Public waitlist signup — the only unauthenticated write endpoint in the API.
// Fed by the landing page and the app's auth screen while Flyxa is in private
// beta. Existing accounts are unaffected; new signups are disabled in Supabase
// Auth settings, so this list is the sole front door.

const router = Router();

// Tighter than the global limiter: a waitlist form never needs bursts.
const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

router.post('/', waitlistLimiter, async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const source = String(req.body?.source ?? '').trim().slice(0, 64) || null;

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    const { error } = await supabase.from('waitlist').insert({ email, source });

    if (error) {
      // 23505 = unique violation — they're already on the list; treat as success.
      if (error.code === '23505') {
        return res.json({ ok: true, already: true });
      }
      throw error;
    }

    return res.json({ ok: true, already: false });
  } catch (err) {
    console.error('Waitlist signup failed:', err);
    return res.status(500).json({ error: 'Could not join the waitlist. Try again.' });
  }
});

export default router;
