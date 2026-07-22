-- Invite columns on the waitlist: a row is invited when invite_token is set,
-- and burned when redeemed_at is set. Run in the Supabase SQL editor.
alter table public.waitlist
  add column if not exists invite_token text,
  add column if not exists invited_at timestamptz,
  add column if not exists redeemed_at timestamptz;

create unique index if not exists waitlist_invite_token_idx
  on public.waitlist (invite_token)
  where invite_token is not null;
