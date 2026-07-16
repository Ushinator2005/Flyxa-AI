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

// Confirmation email via Resend. Unset key = silently skipped, so the
// waitlist works before email is configured and signups NEVER fail
// because a confirmation couldn't send.
//
// Env:
//   RESEND_API_KEY       — re_... from resend.com
//   WAITLIST_FROM_EMAIL  — verified sender, e.g. "Flyxa <hello@flyxa.app>"
const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
const WAITLIST_FROM_EMAIL = process.env.WAITLIST_FROM_EMAIL?.trim() || 'Flyxa <onboarding@resend.dev>';
// Public URL of the petal mark (e.g. https://app.flyxa.app/logo-email.png).
// Must be publicly reachable — Gmail fetches it from the recipient's side —
// so it stays unset in local dev and the email falls back to the text wordmark.
const WAITLIST_LOGO_URL = process.env.WAITLIST_LOGO_URL?.trim();

async function sendWaitlistConfirmation(email: string): Promise<void> {
  if (!RESEND_API_KEY) return;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: WAITLIST_FROM_EMAIL,
      to: [email],
      reply_to: process.env.WAITLIST_REPLY_TO?.trim() || undefined,
      subject: 'Your seat is reserved — Flyxa private beta',
      // Plain-text part alongside HTML — HTML-only mail scores worse with spam filters.
      text: [
        'FLYXA — TRADING INTELLIGENCE',
        '',
        'Your seat is reserved.',
        '',
        'Flyxa is the AI trading journal that reads your charts, verifies your',
        'trades, and grades every session against your own rules. A small group',
        'of traders runs it daily while we sharpen the edges.',
        '',
        'What is waiting for you:',
        '  01  AI trade scanner - screenshot in, verified trade out.',
        '  02  A rulebook that bites - every session checked against your limits.',
        '  03  Session coach - pre-market brief to graded post-session debrief.',
        '',
        'Seats open in waves. When yours is ready, the invite comes to this',
        'address. One email, nothing else.',
        '',
        'Questions? Just reply.',
        '- The Flyxa team',
      ].join('\n'),
      html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0e0d0d;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0e0d0d;">
    <tr>
      <td align="center" style="padding:44px 16px;">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;">

          <!-- Logo lockup -->
          <tr>
            <td align="center" style="padding:0 0 26px;font-family:Helvetica,Arial,sans-serif;">
              ${WAITLIST_LOGO_URL ? `
              <img src="${WAITLIST_LOGO_URL}" width="42" height="42" alt=""
                style="display:inline-block;vertical-align:middle;margin-right:13px;border:0;" />
              <span style="display:inline-block;vertical-align:middle;font-size:30px;font-weight:700;letter-spacing:-1px;color:#f5f2ec;">Flyxa</span>
              ` : `
              <div style="font-size:30px;font-weight:700;letter-spacing:-1px;color:#f5f2ec;">
                Fly<span style="color:#f59e0b;">x</span>a
              </div>
              `}
              <div style="margin-top:6px;font-size:9px;font-weight:600;letter-spacing:5px;color:#6f695f;">
                TRADING&nbsp;INTELLIGENCE
              </div>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="border:1px solid #2a2723;border-radius:14px;background-color:#141211;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">

                <!-- Signature line -->
                <tr><td style="height:3px;background-color:#f59e0b;font-size:0;line-height:0;">&nbsp;</td></tr>

                <tr>
                  <td style="padding:32px 36px 8px;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:3px;color:#f59e0b;">
                      PRIVATE BETA · WAITLIST CONFIRMED
                    </p>
                    <h1 style="margin:16px 0 14px;font-size:27px;font-weight:700;letter-spacing:-0.5px;line-height:1.2;color:#f5f2ec;">
                      Your seat is reserved.
                    </h1>
                    <p style="margin:0;font-size:14px;line-height:1.75;color:#b8b2a7;">
                      Flyxa is the AI trading journal that reads your charts, verifies your
                      trades, and grades every session against your own rules. A small group
                      of traders runs it daily while we sharpen the edges.
                    </p>
                  </td>
                </tr>

                <!-- What's waiting -->
                <tr>
                  <td style="padding:22px 36px 6px;font-family:Helvetica,Arial,sans-serif;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="30" valign="top" style="padding:9px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">01</td>
                        <td style="padding:9px 0;border-bottom:1px solid #221f1c;">
                          <span style="font-size:13.5px;font-weight:700;color:#f5f2ec;">AI trade scanner</span>
                          <span style="font-size:13px;color:#8d8779;"> — screenshot in, verified trade out.</span>
                        </td>
                      </tr>
                      <tr>
                        <td width="30" valign="top" style="padding:9px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">02</td>
                        <td style="padding:9px 0;border-bottom:1px solid #221f1c;">
                          <span style="font-size:13.5px;font-weight:700;color:#f5f2ec;">A rulebook that bites</span>
                          <span style="font-size:13px;color:#8d8779;"> — every session checked against your limits.</span>
                        </td>
                      </tr>
                      <tr>
                        <td width="30" valign="top" style="padding:9px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">03</td>
                        <td style="padding:9px 0;">
                          <span style="font-size:13.5px;font-weight:700;color:#f5f2ec;">Session coach</span>
                          <span style="font-size:13px;color:#8d8779;"> — pre-market brief to graded post-session debrief.</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:18px 36px 30px;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0 0 14px;font-size:14px;line-height:1.75;color:#b8b2a7;">
                      Seats open in waves. When yours is ready, the invite comes to this
                      address — one email, nothing else.
                    </p>
                    <p style="margin:0;font-size:14px;line-height:1.75;color:#b8b2a7;">
                      Questions? Just reply.<br/>
                      <span style="color:#f5f2ec;">— The Flyxa team</span>
                    </p>
                  </td>
                </tr>

                <!-- Card footer -->
                <tr>
                  <td style="border-top:1px solid #2a2723;padding:13px 36px;font-family:Helvetica,Arial,sans-serif;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size:9px;font-weight:700;letter-spacing:2px;color:#6f695f;">
                          AI JOURNAL · RISK RULES · SESSION COACH
                        </td>
                        <td align="right" style="font-size:9px;font-weight:700;letter-spacing:2px;color:#f59e0b;">
                          SEATS OPEN IN WAVES
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Under-card note -->
          <tr>
            <td align="center" style="padding:20px 10px 0;font-family:Helvetica,Arial,sans-serif;">
              <p style="margin:0;font-size:11px;line-height:1.6;color:#6f695f;">
                You're receiving this because you joined the Flyxa waitlist.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend ${response.status}: ${detail.slice(0, 300)}`);
  }
}

router.post('/', waitlistLimiter, async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const source = String(req.body?.source ?? '').trim().slice(0, 64) || null;

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    const { error } = await supabase.from('waitlist').insert({ email, source });

    if (error) {
      // 23505 = unique violation — they're already on the list; treat as success
      // (and don't re-send the confirmation).
      if (error.code === '23505') {
        return res.json({ ok: true, already: true });
      }
      throw error;
    }

    // Fire-and-forget: a failed confirmation email must never fail the signup.
    void sendWaitlistConfirmation(email).catch(err => {
      console.error('Waitlist confirmation email failed:', err);
    });

    return res.json({ ok: true, already: false });
  } catch (err) {
    console.error('Waitlist signup failed:', err);
    return res.status(500).json({ error: 'Could not join the waitlist. Try again.' });
  }
});

export default router;
