create table if not exists public.rival_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text,
  avatar_color text not null default '#f59e0b',
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rival_profiles_username_format check (username ~ '^[a-z0-9_]{3,24}$')
);

alter table public.rival_profiles enable row level security;

drop policy if exists "Profiles are readable" on public.rival_profiles;
create policy "Profiles are readable" on public.rival_profiles
  for select using (true);

drop policy if exists "Users can manage own rival profile" on public.rival_profiles;
create policy "Users can manage own rival profile" on public.rival_profiles
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.rival_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint rival_requests_no_self check (requester_id <> recipient_id),
  constraint rival_requests_status check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  unique (requester_id, recipient_id)
);

alter table public.rival_requests enable row level security;

drop policy if exists "Users can read own rival requests" on public.rival_requests;
create policy "Users can read own rival requests" on public.rival_requests
  for select using (auth.uid() = requester_id or auth.uid() = recipient_id);

drop policy if exists "Users can create own rival requests" on public.rival_requests;
create policy "Users can create own rival requests" on public.rival_requests
  for insert with check (auth.uid() = requester_id);

drop policy if exists "Users can update own rival requests" on public.rival_requests;
create policy "Users can update own rival requests" on public.rival_requests
  for update using (auth.uid() = requester_id or auth.uid() = recipient_id)
  with check (auth.uid() = requester_id or auth.uid() = recipient_id);

create index if not exists rival_profiles_username_idx on public.rival_profiles (username);
create index if not exists rival_requests_requester_idx on public.rival_requests (requester_id);
create index if not exists rival_requests_recipient_idx on public.rival_requests (recipient_id);
