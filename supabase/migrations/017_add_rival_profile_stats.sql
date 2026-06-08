alter table public.rival_profiles
  add column if not exists stats jsonb not null default '{}'::jsonb;

