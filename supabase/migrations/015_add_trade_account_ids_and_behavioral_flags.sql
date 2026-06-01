alter table public.trades
add column if not exists account_ids text[] default '{}';

alter table public.trades
add column if not exists behavioral_flags text[] default '{}';

update public.trades
set account_ids = array[account_id]
where coalesce(array_length(account_ids, 1), 0) = 0
  and account_id is not null
  and account_id <> '';
