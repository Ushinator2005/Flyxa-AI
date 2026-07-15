-- Flyxa subscription state, written by the Stripe webhook (service role) and
-- read by GET /api/subscription/status. Run this once in the Supabase SQL editor.

create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

-- Only the service role (backend) touches this table; clients read via the API.
alter table public.user_subscriptions enable row level security;

-- Allow a signed-in user to read their own row directly if ever needed.
create policy "read own subscription"
  on public.user_subscriptions for select
  using (auth.uid() = user_id);
