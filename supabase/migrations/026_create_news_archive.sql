-- Searchable headline archive for the news terminal. Every headline that
-- passes through the backend (Tree News push, RSS wire, AI classification)
-- is stored here so traders can search history and replay news against
-- their trade timeline. Global data — written only by the backend service
-- role, read through the backend API.
create table if not exists public.news_archive (
  id bigint generated always as identity primary key,
  headline text not null,
  source text not null default '',
  url text,
  summary text,
  impact text check (impact in ('high', 'medium', 'low')),
  is_breaking boolean not null default false,
  published_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- One row per (publication time, headline) — re-ingesting the same wire
-- item is a no-op; classification updates upsert against this key.
create unique index if not exists news_archive_dedup
  on public.news_archive (published_at, headline);

create index if not exists news_archive_published_idx
  on public.news_archive (published_at desc);

-- No policies: only the backend (service role) reads or writes this table.
alter table public.news_archive enable row level security;
