alter table public.journal_entries
  add column if not exists mood text;
