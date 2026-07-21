-- Per-user daily usage counter for Claude-backed AI endpoints.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- No policies: only the backend (service role) reads or writes this table.
alter table public.ai_usage enable row level security;

-- Atomically increment and return the new count for (user, day).
create or replace function public.increment_ai_usage(p_user_id uuid, p_day date)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage (user_id, day, count)
  values (p_user_id, p_day, 1)
  on conflict (user_id, day)
  do update set count = ai_usage.count + 1, updated_at = now()
  returning count;
$$;

-- Only the backend may call the increment function.
revoke execute on function public.increment_ai_usage(uuid, date) from public, anon, authenticated;
