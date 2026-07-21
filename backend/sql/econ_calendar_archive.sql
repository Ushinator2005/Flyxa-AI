-- Economic-calendar archive. The free ForexFactory feed only publishes the
-- current and next week, so the backend saves every event it sees (including
-- actuals as they fill in) and past weeks are served from this table.
-- History accumulates from the day this ships. Run once in the Supabase SQL editor.

create table if not exists public.econ_calendar_events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  country text not null default '',
  date_text text not null,          -- raw feed datetime string, passed through to the app
  time_text text not null default '',
  impact text not null default '',
  actual text,
  forecast text,
  previous text,
  date_slice date not null,         -- YYYY-MM-DD for range queries
  time_key text not null default '',
  updated_at timestamptz not null default now(),
  unique (title, date_slice, time_key)
);

create index if not exists econ_calendar_events_date_idx on public.econ_calendar_events (date_slice);

alter table public.econ_calendar_events enable row level security;
-- No policies: service role only. Clients read via the API.
