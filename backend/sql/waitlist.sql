-- Flyxa launch waitlist. Public POST /api/waitlist writes rows via the
-- service role; there are no client-facing policies on purpose — the list
-- is readable only from the backend / Supabase dashboard.
-- Run this once in the Supabase SQL editor.

create table if not exists public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  source text,
  created_at timestamptz not null default now(),
  invited_at timestamptz
);

alter table public.waitlist enable row level security;
-- No policies: anon/authenticated clients can neither read nor write.
-- The backend uses the service role, which bypasses RLS.
