-- Add starting_balance column to trading_accounts table
alter table trading_accounts add column if not exists starting_balance numeric;
