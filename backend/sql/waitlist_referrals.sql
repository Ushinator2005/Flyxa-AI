-- Referral columns on the waitlist. Each row gets a shareable referral_code;
-- a new signup that arrives through a code stores it in referred_by, and each
-- such signup moves the referrer up the line. Run in the Supabase SQL editor.
alter table public.waitlist
  add column if not exists referral_code text,
  add column if not exists referred_by text;

create unique index if not exists waitlist_referral_code_idx
  on public.waitlist (referral_code)
  where referral_code is not null;

create index if not exists waitlist_referred_by_idx
  on public.waitlist (referred_by);
