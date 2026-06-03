-- Dedicated backup table for pre-session data — mirrors store_entries_backup pattern.
-- Keyed by (user_id, session_date) so each user has one row per trading day.
-- If user_store is ever wiped, pre-session history can be recovered from here.
create table if not exists pre_sessions (
  id          text        not null,                                        -- date string "YYYY-MM-DD"
  user_id     uuid        not null references auth.users(id) on delete cascade,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, id)
);

alter table pre_sessions enable row level security;

create policy "Users manage own pre sessions"
  on pre_sessions
  for all
  to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

create index if not exists pre_sessions_user_id_idx on pre_sessions(user_id);
create index if not exists pre_sessions_date_idx    on pre_sessions(user_id, id desc);
