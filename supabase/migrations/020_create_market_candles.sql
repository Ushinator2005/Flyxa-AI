-- Store user-imported OHLCV candles for Flyxa backtesting/data feed.
create table if not exists market_candles (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  time timestamptz not null,
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume numeric default 0,
  source text default 'csv',
  created_at timestamptz default now(),
  unique(user_id, symbol, timeframe, time)
);

create index if not exists market_candles_user_symbol_timeframe_time_idx
  on market_candles (user_id, symbol, timeframe, time);

alter table market_candles enable row level security;

drop policy if exists "Users can read own market candles" on market_candles;
create policy "Users can read own market candles"
  on market_candles
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own market candles" on market_candles;
create policy "Users can insert own market candles"
  on market_candles
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own market candles" on market_candles;
create policy "Users can update own market candles"
  on market_candles
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own market candles" on market_candles;
create policy "Users can delete own market candles"
  on market_candles
  for delete
  using (auth.uid() = user_id);
