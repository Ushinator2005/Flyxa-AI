import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import rateLimit from 'express-rate-limit';
import { supabase } from '../services/supabase';
import { authMiddleware } from '../middleware/auth';
import { AuthenticatedRequest } from '../types/index';
import { LOGO_EMAIL_BASE64 } from '../assets/logoEmail';

// Where invite links point. Deliberately NOT FRONTEND_URL — invites are sent
// from the founder's laptop where that is localhost, and an emailed localhost
// link is dead on arrival. Override with WAITLIST_APP_URL only for testing.
const APP_URL = process.env.WAITLIST_APP_URL?.trim() || 'https://www.flyxa.app';
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

// Deep link to the waitlist's "Check your spot" view, email prefilled.
const checkSpotUrl = (email: string) => `${APP_URL}/auth?check=1&email=${encodeURIComponent(email)}`;

// Known disposable / temp-mail domains. Not exhaustive (new ones appear daily),
// but it turns away the lazy throwaways that referral farming relies on.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'grr.la', 'sharklasers.com',
  '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com', 'tempmailo.com',
  'throwawaymail.com', 'yopmail.com', 'getnada.com', 'nada.email', 'trashmail.com',
  'maildrop.cc', 'mailnesia.com', 'dispostable.com', 'fakeinbox.com', 'tempinbox.com',
  'mintemail.com', 'mohmal.com', 'emailondeck.com', 'moakt.com', 'mailsac.com',
  'inboxkitten.com', 'spam4.me', 'byom.de', 'discard.email', 'trbvm.com', 'tmpmail.org',
]);
const isDisposableEmail = (email: string) => DISPOSABLE_DOMAINS.has(email.split('@')[1] ?? '');

// Optional social-proof floor added to the real signup count on the public
// count endpoint. Defaults to 0 (honest real number). Set WAITLIST_COUNT_BASE
// to seed the displayed figure at launch.
const WAITLIST_COUNT_BASE = Math.max(0, Math.trunc(Number(process.env.WAITLIST_COUNT_BASE)) || 0);

// Referral: every waitlist row gets a shareable code. Each friend who joins
// through that code moves the referrer up REFERRAL_BOOST_PER places in line.
export const REFERRAL_BOOST_PER = Math.max(0, Math.trunc(Number(process.env.WAITLIST_REFERRAL_BOOST)) || 3);
const REFERRAL_CODE_RE = /^[a-z0-9]{1,12}-[a-z0-9]{3,10}$/;

// Founder-only admin surface (top referrers, totals). Anyone else with a valid
// token gets a 403 — the referrals endpoint exposes real emails.
const FOUNDER_EMAIL = (process.env.FOUNDER_EMAIL || 'ushinator2005@gmail.com').trim().toLowerCase();

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
// The petal mark ships as an inline attachment (cid:) rather than a hosted
// URL — remote images break on redirects, image proxies, and privacy
// blockers; an embedded 4KB PNG renders everywhere.

// Exported for one-off design previews (scripts/) — the route itself is the
// only production caller. `position` is the signup's place in line; null hides
// the queue box rather than showing a wrong number.
export async function sendWaitlistConfirmation(email: string, position: number | null): Promise<void> {
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
      subject: "You're on the Flyxa waitlist",
      attachments: [
        {
          filename: 'flyxa-logo.png',
          content: LOGO_EMAIL_BASE64,
          content_id: 'flyxa-logo',
        },
      ],
      // Plain-text part alongside HTML — HTML-only mail scores worse with spam filters.
      text: [
        'FLYXA. TRADING INTELLIGENCE',
        '',
        "You're on the list.",
        ...(position ? ['', `Place in line: #${position}. Invites go out in order, to this address.`] : []),
        '',
        'Flyxa is a trading journal that reads you, not just your P&L. Drop a',
        'screenshot and it logs the trade, scores your process, and shows you',
        'the habit costing you money.',
        '',
        `Check your spot anytime: ${checkSpotUrl(email)}`,
        '',
        'What happens next:',
        '  1. Invites open in waves, in queue order.',
        '  2. When yours is ready, one email lands at this address with your login.',
        '  3. Nothing else in between. No drip campaign.',
        '',
        'Questions? Just reply to this email.',
        'The Flyxa team',
        '',
        'flyxa.app',
      ].join('\n'),
      html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    /* Wordmark font — honored by Apple Mail and friends; Gmail strips this
       block and falls back to Helvetica. */
    @font-face {
      font-family: 'Space Grotesk';
      font-style: normal;
      font-weight: 700;
      src: url(https://fonts.gstatic.com/s/spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4Cw.woff2) format('woff2');
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#0e0d0d;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0e0d0d;">
    <tr>
      <td align="center" style="padding:44px 16px;">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;">

          <!-- Logo lockup: mark above wordmark, all-white type -->
          <tr>
            <td align="center" style="padding:0 0 28px;font-family:Helvetica,Arial,sans-serif;">
              <img src="cid:flyxa-logo" width="40" height="40" alt="Flyxa"
                style="display:block;margin:0 auto 12px;border:0;" />
              <div style="font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#f5f2ec;">
                Flyxa
              </div>
              <div style="margin-top:7px;font-size:9px;font-weight:600;letter-spacing:5px;color:#6f695f;">
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
                  <td style="padding:32px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:3px;color:#f59e0b;">
                      PRIVATE BETA
                    </p>
                    <h1 style="margin:14px 0 0;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.5px;line-height:1.2;color:#f5f2ec;">
                      You're on the list.
                    </h1>
                  </td>
                </tr>

                ${position ? `
                <!-- Place in line -->
                <tr>
                  <td style="padding:24px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                      style="border:1px solid #2a2723;border-radius:12px;background-color:#100f0e;">
                      <tr>
                        <td align="center" style="padding:24px 20px 22px;">
                          <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:4px;color:#8d8779;font-family:'Courier New',monospace;">
                            PLACE&nbsp;IN&nbsp;LINE
                          </p>
                          <p style="margin:10px 0 8px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:46px;font-weight:700;letter-spacing:-1px;line-height:1;color:#f59e0b;">
                            #${position}
                          </p>
                          <p style="margin:0;font-size:11px;color:#8d8779;">
                            invites go out in order, to this address
                          </p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ` : ''}

                <!-- Divider -->
                <tr>
                  <td style="padding:26px 36px 0;">
                    <div style="height:1px;background-color:#221f1c;font-size:0;line-height:0;">&nbsp;</div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:22px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#b8b2a7;">
                      Flyxa is a trading journal that reads you, not just your P&amp;L. Drop a
                      screenshot and it logs the trade, scores your process, and shows you the
                      habit costing you money.
                    </p>
                  </td>
                </tr>

                <!-- Check your spot -->
                <tr>
                  <td style="padding:20px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="border:1px solid #2a2723;border-radius:8px;">
                          <a href="${checkSpotUrl(email)}"
                            style="display:inline-block;padding:11px 22px;font-size:13px;font-weight:700;color:#f5f2ec;text-decoration:none;font-family:Helvetica,Arial,sans-serif;">
                            Check your spot &rarr;
                          </a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:9px 0 0;font-size:11px;color:#8d8779;">
                      See your live place in line and referrals any time.
                    </p>
                  </td>
                </tr>

                <!-- What happens next -->
                <tr>
                  <td style="padding:24px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:3px;color:#8d8779;font-family:'Courier New',monospace;">
                      WHAT&nbsp;HAPPENS&nbsp;NEXT
                    </p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="24" valign="top" style="padding:6px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">1-</td>
                        <td style="padding:6px 0;font-size:13.5px;line-height:1.6;color:#cfc9bd;">Invites open in waves, in queue order.</td>
                      </tr>
                      <tr>
                        <td width="24" valign="top" style="padding:6px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">2-</td>
                        <td style="padding:6px 0;font-size:13.5px;line-height:1.6;color:#cfc9bd;">When yours is ready, one email lands at this address with your login.</td>
                      </tr>
                      <tr>
                        <td width="24" valign="top" style="padding:6px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">3-</td>
                        <td style="padding:6px 0;font-size:13.5px;line-height:1.6;color:#cfc9bd;">Nothing else in between. No drip campaign.</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Divider -->
                <tr>
                  <td style="padding:20px 36px 0;">
                    <div style="height:1px;background-color:#221f1c;font-size:0;line-height:0;">&nbsp;</div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:20px 36px 32px;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0 0 4px;font-size:14px;line-height:1.7;color:#b8b2a7;">
                      Questions? Just reply to this email.
                    </p>
                    <p style="margin:0;font-size:14px;font-weight:700;color:#f5f2ec;">
                      The Flyxa team
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Under-card footer -->
          <tr>
            <td align="center" style="padding:22px 10px 0;font-family:Helvetica,Arial,sans-serif;">
              <p style="margin:0;font-size:11px;color:#8d8779;">
                <a href="https://www.flyxa.app" style="font-weight:700;color:#f59e0b;text-decoration:none;">flyxa.app</a>
                &nbsp;&nbsp;·&nbsp;&nbsp;© 2026 Flyxa. All rights reserved.
              </p>
              <p style="margin:16px 0 0;font-size:10px;line-height:1.6;color:#6f695f;">
                You're receiving this one-time email because you joined the waitlist at flyxa.app.
              </p>
              <p style="margin:6px 0 0;font-size:10px;line-height:1.6;color:#6f695f;">
                <a href="mailto:team@flyxa.app?subject=Unsubscribe" style="color:#6f695f;text-decoration:underline;">Unsubscribe</a>
                &nbsp;·&nbsp; Flyxa Pty Ltd, Sydney NSW 2000, Australia
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

// Referral-boost notice. Sent to a referrer when someone joins with their link,
// confirming the referral landed and showing their new place in line.
export async function sendReferralBoostEmail(email: string, standing: Standing): Promise<void> {
  if (!RESEND_API_KEY) return;
  const positionText = standing.position != null ? `#${standing.position}` : null;
  const refCount = standing.referralCount;
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
      subject: 'Someone joined with your link',
      attachments: [
        { filename: 'flyxa-logo.png', content: LOGO_EMAIL_BASE64, content_id: 'flyxa-logo' },
      ],
      text: [
        'FLYXA. TRADING INTELLIGENCE',
        '',
        'You moved up the line.',
        '',
        `A trader just joined Flyxa with your invite link${refCount ? ` (${refCount} total now)` : ''}.`,
        ...(positionText ? ['', `Your new place in line: ${positionText}.`] : []),
        ...(standing.referralUrl ? ['', `Share your link again: ${standing.referralUrl}`] : []),
        '',
        `Check your spot anytime: ${checkSpotUrl(email)}`,
        '',
        'The Flyxa team',
        '',
        'flyxa.app',
      ].join('\n'),
      html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    @font-face {
      font-family: 'Space Grotesk';
      font-style: normal;
      font-weight: 700;
      src: url(https://fonts.gstatic.com/s/spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4Cw.woff2) format('woff2');
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#0e0d0d;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0e0d0d;">
    <tr>
      <td align="center" style="padding:44px 16px;">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;">

          <tr>
            <td align="center" style="padding:0 0 28px;font-family:Helvetica,Arial,sans-serif;">
              <img src="cid:flyxa-logo" width="40" height="40" alt="Flyxa" style="display:block;margin:0 auto 12px;border:0;" />
              <div style="font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#f5f2ec;">Flyxa</div>
              <div style="margin-top:7px;font-size:9px;font-weight:600;letter-spacing:5px;color:#6f695f;">TRADING&nbsp;INTELLIGENCE</div>
            </td>
          </tr>

          <tr>
            <td style="border:1px solid #2a2723;border-radius:14px;background-color:#141211;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">

                <tr><td style="height:3px;background-color:#f59e0b;font-size:0;line-height:0;">&nbsp;</td></tr>

                <tr>
                  <td style="padding:32px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:3px;color:#f59e0b;">REFERRAL&nbsp;LANDED</p>
                    <h1 style="margin:14px 0 0;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.5px;line-height:1.2;color:#f5f2ec;">
                      You moved up the line.
                    </h1>
                    <p style="margin:14px 0 0;font-size:14px;line-height:1.7;color:#b8b2a7;">
                      A trader just joined Flyxa with your invite link.${refCount ? ` That&rsquo;s ${refCount} you&rsquo;ve brought in.` : ''} Nice work.
                    </p>
                  </td>
                </tr>

                ${positionText ? `
                <tr>
                  <td style="padding:24px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #2a2723;border-radius:12px;background-color:#100f0e;">
                      <tr>
                        <td align="center" style="padding:24px 20px 22px;">
                          <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:4px;color:#8d8779;font-family:'Courier New',monospace;">NEW&nbsp;PLACE&nbsp;IN&nbsp;LINE</p>
                          <p style="margin:10px 0 0;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:46px;font-weight:700;letter-spacing:-1px;line-height:1;color:#f59e0b;">${positionText}</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ` : ''}

                ${standing.referralUrl ? `
                <tr>
                  <td style="padding:22px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0 0 12px;font-size:13.5px;line-height:1.6;color:#cfc9bd;">Keep climbing. Every trader who joins with your link moves you up ${standing.boostPer} more places.</p>
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="border-radius:8px;background-color:#f59e0b;">
                          <a href="${standing.referralUrl}" style="display:inline-block;padding:12px 26px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0e0d0d;text-decoration:none;">Share your link again</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ` : ''}

                <tr>
                  <td style="padding:22px 36px 32px;font-family:Helvetica,Arial,sans-serif;">
                    <a href="${checkSpotUrl(email)}" style="font-size:12px;font-weight:700;color:#8d8779;text-decoration:underline;">Check your spot &rarr;</a>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:22px 10px 0;font-family:Helvetica,Arial,sans-serif;">
              <p style="margin:0;font-size:11px;color:#8d8779;">
                <a href="https://www.flyxa.app" style="font-weight:700;color:#f59e0b;text-decoration:none;">flyxa.app</a>
                &nbsp;&nbsp;·&nbsp;&nbsp;© 2026 Flyxa. All rights reserved.
              </p>
              <p style="margin:16px 0 0;font-size:10px;line-height:1.6;color:#6f695f;">
                You're receiving this because someone joined the Flyxa waitlist with your referral link.
              </p>
              <p style="margin:6px 0 0;font-size:10px;line-height:1.6;color:#6f695f;">
                <a href="mailto:team@flyxa.app?subject=Unsubscribe" style="color:#6f695f;text-decoration:underline;">Unsubscribe</a>
                &nbsp;·&nbsp; Flyxa Pty Ltd, Sydney NSW 2000, Australia
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

// Seat-open invite. Sent by scripts/invite.ts when the founder opens seats —
// never triggered by users. Same shell as the confirmation email; the hero is
// a single button carrying the one-time invite link.
export async function sendInviteEmail(email: string, token: string): Promise<void> {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set — cannot send invites.');
  const inviteUrl = `${APP_URL}/auth?invite=${token}`;
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
      subject: "Your Flyxa seat is open",
      attachments: [
        {
          filename: 'flyxa-logo.png',
          content: LOGO_EMAIL_BASE64,
          content_id: 'flyxa-logo',
        },
      ],
      text: [
        'FLYXA — TRADING INTELLIGENCE',
        '',
        "You're in.",
        '',
        'A seat opened on Flyxa and it is yours. Create your account with this',
        'email address and start logging sessions today:',
        '',
        inviteUrl,
        '',
        'This link is personal and expires in 7 days.',
        '',
        'First session checklist:',
        '  1. Add your trading account.',
        '  2. Write your rules.',
        '  3. Scan your first trade.',
        '',
        'Questions? Just reply to this email.',
        'The Flyxa team',
        '',
        'flyxa.app',
      ].join('\n'),
      html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    @font-face {
      font-family: 'Space Grotesk';
      font-style: normal;
      font-weight: 700;
      src: url(https://fonts.gstatic.com/s/spacegrotesk/v22/V8mDoQDjQSkFtoMM3T6r8E7mPbF4Cw.woff2) format('woff2');
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#0e0d0d;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0e0d0d;">
    <tr>
      <td align="center" style="padding:44px 16px;">
        <table role="presentation" width="540" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%;">

          <!-- Logo lockup -->
          <tr>
            <td align="center" style="padding:0 0 28px;font-family:Helvetica,Arial,sans-serif;">
              <img src="cid:flyxa-logo" width="40" height="40" alt="Flyxa"
                style="display:block;margin:0 auto 12px;border:0;" />
              <div style="font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.5px;color:#f5f2ec;">
                Flyxa
              </div>
              <div style="margin-top:7px;font-size:9px;font-weight:600;letter-spacing:5px;color:#6f695f;">
                TRADING&nbsp;INTELLIGENCE
              </div>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="border:1px solid #2a2723;border-radius:14px;background-color:#141211;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">

                <tr><td style="height:3px;background-color:#f59e0b;font-size:0;line-height:0;">&nbsp;</td></tr>

                <tr>
                  <td style="padding:32px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:3px;color:#f59e0b;">
                      PRIVATE BETA · SEAT OPEN
                    </p>
                    <h1 style="margin:14px 0 0;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.5px;line-height:1.2;color:#f5f2ec;">
                      You're in.
                    </h1>
                  </td>
                </tr>

                <tr>
                  <td style="padding:16px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#b8b2a7;">
                      A seat opened on Flyxa and it's yours. Your invite is tied to
                      <span style="color:#f5f2ec;">${email}</span> — create your account
                      and start logging sessions today.
                    </p>
                  </td>
                </tr>

                <!-- CTA -->
                <tr>
                  <td align="center" style="padding:26px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
                      <tr>
                        <td style="border-radius:8px;background-color:#f59e0b;">
                          <a href="${inviteUrl}"
                            style="display:inline-block;padding:14px 36px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;color:#0e0d0d;text-decoration:none;">
                            Create your account
                          </a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:12px 0 0;font-size:11px;color:#8d8779;">
                      This link is personal and expires in 7 days.
                    </p>
                  </td>
                </tr>

                <!-- Divider -->
                <tr>
                  <td style="padding:26px 36px 0;">
                    <div style="height:1px;background-color:#221f1c;font-size:0;line-height:0;">&nbsp;</div>
                  </td>
                </tr>

                <!-- First session checklist -->
                <tr>
                  <td style="padding:22px 36px 0;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0 0 6px;font-size:10px;font-weight:700;letter-spacing:3px;color:#8d8779;font-family:'Courier New',monospace;">
                      FIRST&nbsp;SESSION&nbsp;CHECKLIST
                    </p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="24" valign="top" style="padding:6px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">1-</td>
                        <td style="padding:6px 0;font-size:13.5px;line-height:1.6;color:#cfc9bd;">Add your trading account.</td>
                      </tr>
                      <tr>
                        <td width="24" valign="top" style="padding:6px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">2-</td>
                        <td style="padding:6px 0;font-size:13.5px;line-height:1.6;color:#cfc9bd;">Write your rules.</td>
                      </tr>
                      <tr>
                        <td width="24" valign="top" style="padding:6px 0;font-size:12px;font-weight:700;color:#f59e0b;font-family:'Courier New',monospace;">3-</td>
                        <td style="padding:6px 0;font-size:13.5px;line-height:1.6;color:#cfc9bd;">Scan your first trade.</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Divider -->
                <tr>
                  <td style="padding:20px 36px 0;">
                    <div style="height:1px;background-color:#221f1c;font-size:0;line-height:0;">&nbsp;</div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:20px 36px 32px;font-family:Helvetica,Arial,sans-serif;">
                    <p style="margin:0 0 4px;font-size:14px;line-height:1.7;color:#b8b2a7;">
                      Questions? Just reply to this email.
                    </p>
                    <p style="margin:0;font-size:14px;font-weight:700;color:#f5f2ec;">
                      The Flyxa team
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

          <!-- Under-card footer -->
          <tr>
            <td align="center" style="padding:22px 10px 0;font-family:Helvetica,Arial,sans-serif;">
              <p style="margin:0;font-size:11px;color:#8d8779;">
                <a href="https://www.flyxa.app" style="font-weight:700;color:#f59e0b;text-decoration:none;">flyxa.app</a>
                &nbsp;&nbsp;·&nbsp;&nbsp;© 2026 Flyxa. All rights reserved.
              </p>
              <p style="margin:16px 0 0;font-size:10px;line-height:1.6;color:#6f695f;">
                You're receiving this because your waitlist spot at flyxa.app opened.
              </p>
              <p style="margin:6px 0 0;font-size:10px;line-height:1.6;color:#6f695f;">
                <a href="mailto:team@flyxa.app?subject=Unsubscribe" style="color:#6f695f;text-decoration:underline;">Unsubscribe</a>
                &nbsp;·&nbsp; Flyxa Pty Ltd, Sydney NSW 2000, Australia
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

// A signup's standing on the list — everything the confirmation screen shows.
// Best-effort: fields fall back to null/0 on any query failure so the UI simply
// hides the missing pieces rather than erroring.
interface Standing {
  position: number | null;
  aheadOfYou: number | null;
  referralCode: string | null;
  referralUrl: string | null;
  referralCount: number;
  boostPer: number;
}

const EMPTY_STANDING: Standing = {
  position: null, aheadOfYou: null, referralCode: null, referralUrl: null,
  referralCount: 0, boostPer: REFERRAL_BOOST_PER,
};

// Readable, collision-checked share code: local-part slug + short random tail,
// e.g. "ushi-4f2a". Kept short so the /r/ link stays tidy.
async function generateReferralCode(email: string): Promise<string> {
  const local = (email.split('@')[0] || 'trader').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'trader';
  for (let i = 0; i < 6; i++) {
    const code = `${local}-${randomBytes(3).toString('hex').slice(0, 4)}`;
    const { data } = await supabase.from('waitlist').select('id').eq('referral_code', code).maybeSingle();
    if (!data) return code;
  }
  return `${local}-${randomBytes(5).toString('hex')}`;
}

// Compute where an email sits in line, applying referral boosts. Chronological
// rank + social-proof floor, minus REFERRAL_BOOST_PER for each friend they
// referred, floored at 1. Backfills a referral code if the row predates the
// referral columns.
async function buildStanding(email: string): Promise<Standing> {
  try {
    // Chronological rank — works with or without the referral columns.
    const { data: row } = await supabase
      .from('waitlist')
      .select('created_at')
      .eq('email', email)
      .maybeSingle();
    if (!row?.created_at) return EMPTY_STANDING;

    const { count: rank } = await supabase
      .from('waitlist')
      .select('*', { count: 'exact', head: true })
      .lte('created_at', row.created_at);
    const baseRank = (typeof rank === 'number' && rank > 0 ? rank : 1) + WAITLIST_COUNT_BASE;

    // Referral layer — degrades to no boost / no link if the migration hasn't
    // been run (the referral_code / referred_by columns don't exist yet).
    let referralCode: string | null = null;
    let referralCount = 0;
    try {
      const { data: refRow, error: refErr } = await supabase
        .from('waitlist')
        .select('referral_code')
        .eq('email', email)
        .maybeSingle();
      if (refErr) throw refErr;

      referralCode = (refRow?.referral_code as string | null) ?? null;
      if (!referralCode) {
        referralCode = await generateReferralCode(email);
        await supabase.from('waitlist').update({ referral_code: referralCode }).eq('email', email);
      }
      const { count: refs } = await supabase
        .from('waitlist')
        .select('*', { count: 'exact', head: true })
        .eq('referred_by', referralCode);
      referralCount = typeof refs === 'number' ? refs : 0;
    } catch (refErr) {
      console.warn('Referral columns unavailable (run waitlist_referrals.sql):', (refErr as { message?: string })?.message);
      referralCode = null;
      referralCount = 0;
    }

    const position = Math.max(1, baseRank - referralCount * REFERRAL_BOOST_PER);
    return {
      position,
      aheadOfYou: Math.max(0, position - 1),
      referralCode,
      referralUrl: referralCode ? `${APP_URL}/r/${referralCode}` : null,
      referralCount,
      boostPer: REFERRAL_BOOST_PER,
    };
  } catch (err) {
    console.error('buildStanding failed:', err);
    return EMPTY_STANDING;
  }
}

router.post('/', waitlistLimiter, async (req: Request, res: Response) => {
  try {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const source = String(req.body?.source ?? '').trim().slice(0, 64) || null;
    const ref = String(req.body?.ref ?? '').trim().toLowerCase().slice(0, 32);

    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (isDisposableEmail(email)) {
      return res.status(400).json({ error: 'Please use a permanent email address.' });
    }

    // Resolve the referrer: the code must belong to a real, different signup.
    let referredBy: string | null = null;
    let referrerEmail: string | null = null;
    if (ref && REFERRAL_CODE_RE.test(ref)) {
      const { data: refRow } = await supabase
        .from('waitlist')
        .select('email')
        .eq('referral_code', ref)
        .maybeSingle();
      if (refRow && refRow.email !== email) {
        referredBy = ref;
        referrerEmail = refRow.email;
      }
    }

    const referralCode = await generateReferralCode(email);
    let { error } = await supabase
      .from('waitlist')
      .insert({ email, source, referral_code: referralCode, referred_by: referredBy });

    // Referral migration not run yet → the referral_code / referred_by columns
    // don't exist. PostgREST reports this as PGRST204 (schema cache) or the
    // Postgres 42703; either way, fall back to a plain insert so signups always
    // work regardless of migration state.
    if (error && (error.code === 'PGRST204' || error.code === '42703' || /referral_code|referred_by/i.test(error.message ?? ''))) {
      ({ error } = await supabase.from('waitlist').insert({ email, source }));
    }

    if (error) {
      // 23505 = unique violation — they're already on the list; treat as success
      // (and don't re-send the confirmation). Still return their standing.
      if (error.code === '23505') {
        return res.json({ ok: true, already: true, ...(await buildStanding(email)) });
      }
      throw error;
    }

    const standing = await buildStanding(email);

    // Fire-and-forget: a failed confirmation email must never fail the signup.
    void sendWaitlistConfirmation(email, standing.position).catch(err => {
      console.error('Waitlist confirmation email failed:', err);
    });

    // Tell the referrer they just moved up, with their new position. Also
    // fire-and-forget so it can never affect the new signup's response.
    if (referrerEmail) {
      void (async () => {
        const refStanding = await buildStanding(referrerEmail!);
        await sendReferralBoostEmail(referrerEmail!, refStanding);
      })().catch(err => console.error('Referral-boost email failed:', err));
    }

    return res.json({ ok: true, already: false, ...standing });
  } catch (err) {
    console.error('Waitlist signup failed:', err);
    return res.status(500).json({ error: 'Could not join the waitlist. Try again.' });
  }
});

// Resolve a referral code to a friendly referrer name so the waitlist can show
// "Referred by X". The code already embeds the referrer's handle, so this
// exposes nothing the link doesn't already carry. 404 if the code isn't real.
router.get('/referrer/:code', waitlistLimiter, async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code ?? '').trim().toLowerCase();
    if (!REFERRAL_CODE_RE.test(code)) return res.status(404).json({ error: 'not_found' });
    const { data } = await supabase.from('waitlist').select('email').eq('referral_code', code).maybeSingle();
    if (!data?.email) return res.status(404).json({ error: 'not_found' });
    const name = (data.email.split('@')[0] || 'a friend').slice(0, 24);
    return res.json({ name });
  } catch (err) {
    console.error('Waitlist referrer lookup failed:', err);
    return res.status(404).json({ error: 'not_found' });
  }
});

// Read-only standing lookup for a returning signup — powers "Check your spot".
// Never writes, never creates: an unknown email gets a 404 so it can't be used
// to sneak onto the list.
router.get('/standing', waitlistLimiter, async (req: Request, res: Response) => {
  try {
    const email = String(req.query.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    const { data } = await supabase.from('waitlist').select('email').eq('email', email).maybeSingle();
    if (!data) return res.status(404).json({ error: 'not_found' });
    return res.json(await buildStanding(email));
  } catch (err) {
    console.error('Waitlist standing lookup failed:', err);
    return res.status(500).json({ error: 'Could not look up your spot. Try again.' });
  }
});

// Founder-only referral dashboard: list totals and the top referrers. Gated
// twice — a valid auth token AND the founder email — because the payload
// contains real signup emails.
router.get('/admin/referrals', authMiddleware, async (req: Request, res: Response) => {
  const email = (req as AuthenticatedRequest).authUser?.email?.toLowerCase() ?? '';
  if (email !== FOUNDER_EMAIL) {
    return res.status(403).json({ error: 'Not authorized.' });
  }
  try {
    const { data, error } = await supabase
      .from('waitlist')
      .select('email, referral_code, referred_by, invited_at, redeemed_at, created_at')
      .order('created_at', { ascending: true })
      .limit(10000);
    if (error) throw error;
    const rows = data ?? [];

    let invited = 0, redeemed = 0, viaReferral = 0;
    const referralCounts = new Map<string, number>();
    const codeOwner = new Map<string, { email: string; rank: number }>();
    rows.forEach((r, i) => {
      if (r.invited_at) invited++;
      if (r.redeemed_at) redeemed++;
      if (r.referred_by) {
        viaReferral++;
        referralCounts.set(r.referred_by, (referralCounts.get(r.referred_by) ?? 0) + 1);
      }
      if (r.referral_code) codeOwner.set(r.referral_code, { email: r.email, rank: i + 1 });
    });

    const topReferrers = [...referralCounts.entries()]
      .map(([code, referrals]) => {
        const owner = codeOwner.get(code);
        const position = owner ? Math.max(1, owner.rank + WAITLIST_COUNT_BASE - referrals * REFERRAL_BOOST_PER) : null;
        return { code, email: owner?.email ?? null, referrals, position };
      })
      .sort((a, b) => b.referrals - a.referrals)
      .slice(0, 25);

    return res.json({
      totals: {
        total: rows.length + WAITLIST_COUNT_BASE,
        real: rows.length,
        invited,
        redeemed,
        viaReferral,
        base: WAITLIST_COUNT_BASE,
        boostPer: REFERRAL_BOOST_PER,
      },
      topReferrers,
    });
  } catch (err) {
    console.error('Waitlist admin referrals failed:', err);
    return res.status(500).json({ error: 'Could not load referral stats.' });
  }
});

// Public count for the waitlist page's social-proof line. Soft-fails to null
// so the UI simply hides the count if the query errors.
router.get('/count', waitlistLimiter, async (_req: Request, res: Response) => {
  try {
    const { count, error } = await supabase.from('waitlist').select('*', { count: 'exact', head: true });
    if (error) throw error;
    return res.json({ count: (count ?? 0) + WAITLIST_COUNT_BASE });
  } catch (err) {
    console.error('Waitlist count failed:', err);
    return res.json({ count: null });
  }
});

// Shared validity check for the two invite endpoints below.
async function findValidInvite(token: string): Promise<
  | { ok: true; email: string }
  | { ok: false; status: number; message: string }
> {
  if (!INVITE_TOKEN_RE.test(token)) {
    return { ok: false, status: 404, message: 'This invite link is not valid.' };
  }
  const { data, error } = await supabase
    .from('waitlist')
    .select('email, invited_at, redeemed_at')
    .eq('invite_token', token)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    return { ok: false, status: 404, message: 'This invite link is not valid.' };
  }
  if (data.redeemed_at) {
    return { ok: false, status: 410, message: 'This invite was already used. Sign in instead.' };
  }
  const invitedAt = data.invited_at ? new Date(data.invited_at).getTime() : 0;
  if (!invitedAt || Date.now() - invitedAt > INVITE_TTL_MS) {
    return { ok: false, status: 410, message: 'This invite has expired. Reply to your invite email and we will send a fresh one.' };
  }
  return { ok: true, email: data.email };
}

// Resolve an invite token to its email so the signup form can show it.
router.get('/invite/:token', waitlistLimiter, async (req: Request, res: Response) => {
  try {
    const invite = await findValidInvite(String(req.params.token ?? ''));
    if (!invite.ok) return res.status(invite.status).json({ error: invite.message });
    return res.json({ email: invite.email });
  } catch (err) {
    console.error('Invite lookup failed:', err);
    return res.status(500).json({ error: 'Could not check the invite. Try again.' });
  }
});

// Burn an invite: create the account (service role bypasses the disabled
// public signups) and mark the row redeemed. This is the ONLY signup path.
router.post('/redeem', waitlistLimiter, async (req: Request, res: Response) => {
  try {
    const token = String(req.body?.token ?? '');
    const password = String(req.body?.password ?? '');
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const invite = await findValidInvite(token);
    if (!invite.ok) return res.status(invite.status).json({ error: invite.message });

    const { error: createError } = await supabase.auth.admin.createUser({
      email: invite.email,
      password,
      email_confirm: true,
    });
    if (createError) {
      if (/already/i.test(createError.message)) {
        return res.status(409).json({ error: 'An account with this email already exists — sign in instead.' });
      }
      throw createError;
    }

    const { error: updateError } = await supabase
      .from('waitlist')
      .update({ redeemed_at: new Date().toISOString() })
      .eq('invite_token', token);
    if (updateError) {
      // Account exists but the token didn't burn — log loudly; the duplicate
      // guard on createUser stops a second redemption anyway.
      console.error('Invite redeemed but token not burned:', updateError);
    }

    return res.json({ ok: true, email: invite.email });
  } catch (err) {
    console.error('Invite redemption failed:', err);
    return res.status(500).json({ error: 'Could not create the account. Try again.' });
  }
});

export default router;
