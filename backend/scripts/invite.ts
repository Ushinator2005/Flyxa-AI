// Open seats for waitlist members. Run from backend/:
//
//   npm run invite -- someone@example.com other@example.com
//   npm run invite -- --next 5          # next 5 in line (referral standing)
//   npm run invite -- --resend x@y.com  # fresh link for an already-invited email
//
// Each target gets a one-time token (7-day expiry) and the branded seat-open
// email. Emails not on the waitlist are added first, so you can invite friends
// directly. Redeemed emails are always skipped.
//
// --next honors the SAME standing the confirmation screen shows: join order
// minus REFERRAL_BOOST_PER places for each friend a signup referred. So the
// on-screen "Your position" is real — referrals actually move people up the
// queue we invite from.
import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import { supabase } from '../src/services/supabase';
import { sendInviteEmail, REFERRAL_BOOST_PER } from '../src/routes/waitlist';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function inviteEmail(email: string, allowResend: boolean): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) {
    console.log(`  SKIP  ${normalized} — not a valid email`);
    return;
  }

  let { data: row, error } = await supabase
    .from('waitlist')
    .select('email, invite_token, invited_at, redeemed_at')
    .eq('email', normalized)
    .maybeSingle();
  if (error) throw error;

  if (!row) {
    const { error: insertError } = await supabase
      .from('waitlist')
      .insert({ email: normalized, source: 'direct-invite' });
    if (insertError) throw insertError;
    row = { email: normalized, invite_token: null, invited_at: null, redeemed_at: null };
    console.log(`  NOTE  ${normalized} was not on the waitlist — added`);
  }

  if (row.redeemed_at) {
    console.log(`  SKIP  ${normalized} — already has an account`);
    return;
  }
  if (row.invited_at && !allowResend) {
    console.log(`  SKIP  ${normalized} — already invited ${row.invited_at.slice(0, 10)} (use --resend for a fresh link)`);
    return;
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const { error: updateError } = await supabase
    .from('waitlist')
    .update({ invite_token: token, invited_at: new Date().toISOString() })
    .eq('email', normalized);
  if (updateError) throw updateError;

  await sendInviteEmail(normalized, token);
  console.log(`  SENT  ${normalized}`);
}

// The next N seats to open, in true queue order: chronological rank minus the
// referral boost, smallest effective position first. Falls back to plain FIFO
// if the referral columns aren't there yet (migration not run).
async function selectNextInLine(n: number): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from('waitlist')
      .select('email, referral_code, referred_by, invited_at, redeemed_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    const rows = data ?? [];

    // Tally how many signups each code brought in.
    const referrals = new Map<string, number>();
    for (const r of rows) {
      if (r.referred_by) referrals.set(r.referred_by, (referrals.get(r.referred_by) ?? 0) + 1);
    }

    // rows are already in created_at order, so index+1 is the chronological
    // rank; subtract the boost to get the effective standing.
    return rows
      .map((r, i) => ({
        email: r.email as string,
        invited_at: r.invited_at as string | null,
        redeemed_at: r.redeemed_at as string | null,
        effective: (i + 1) - (r.referral_code ? (referrals.get(r.referral_code) ?? 0) : 0) * REFERRAL_BOOST_PER,
      }))
      .filter(r => !r.invited_at && !r.redeemed_at)
      .sort((a, b) => a.effective - b.effective)
      .slice(0, n)
      .map(r => r.email);
  } catch {
    // Referral columns unavailable — plain oldest-first.
    const { data, error } = await supabase
      .from('waitlist')
      .select('email')
      .is('invited_at', null)
      .is('redeemed_at', null)
      .order('created_at', { ascending: true })
      .limit(n);
    if (error) throw error;
    return (data ?? []).map(r => r.email);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowResend = args.includes('--resend');
  const nextIdx = args.indexOf('--next');

  let targets: string[] = [];
  if (nextIdx !== -1) {
    const n = Math.max(1, Math.min(100, Number(args[nextIdx + 1]) || 1));
    targets = await selectNextInLine(n);
    if (!targets.length) {
      console.log('Nobody left to invite — every waitlist signup is already invited.');
      return;
    }
    console.log(`Inviting the next ${targets.length} in line (referral standing):`);
  } else {
    targets = args.filter(a => !a.startsWith('--'));
    if (!targets.length) {
      console.log('Usage: npm run invite -- <email...> | --next <N> [--resend]');
      return;
    }
  }

  for (const email of targets) {
    await inviteEmail(email, allowResend);
  }
}

main().then(
  () => process.exit(0),
  err => { console.error('Invite run failed:', err); process.exit(1); },
);
