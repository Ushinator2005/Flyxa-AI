create table if not exists public.prop_firm_rule_versions (
  id text primary key,
  firm_slug text not null,
  firm_name text not null,
  program_slug text not null,
  program text not null,
  path text not null check (path in ('standard', 'no_activation_fee')),
  account_size integer not null check (account_size > 0),
  profit_target numeric not null check (profit_target > 0),
  maximum_loss_limit numeric not null check (maximum_loss_limit > 0 and maximum_loss_limit < account_size),
  daily_loss_limit numeric,
  optional_daily_loss_limit numeric,
  responsible_trading_discount numeric not null default 0 check (responsible_trading_discount >= 0),
  responsible_trading_benefit text not null default '',
  maximum_contracts integer not null check (maximum_contracts > 0),
  maximum_micros integer not null check (maximum_micros > 0),
  consistency_target_pct numeric not null check (consistency_target_pct > 0 and consistency_target_pct <= 100),
  minimum_trading_days integer not null check (minimum_trading_days >= 0),
  drawdown_type text not null check (drawdown_type in ('trailing', 'static')),
  activation_fee numeric not null check (activation_fee >= 0),
  monthly_price numeric not null check (monthly_price >= 0),
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'verified', 'retired')),
  effective_from date not null,
  effective_to date,
  verified_at timestamptz not null,
  source_url text not null,
  secondary_source_urls jsonb not null default '[]'::jsonb,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_slug, program_slug, path, account_size, version)
);

create index if not exists prop_firm_rules_lookup_idx
  on public.prop_firm_rule_versions (firm_slug, program_slug, path, account_size, status);

alter table public.prop_firm_rule_versions enable row level security;

drop policy if exists "Authenticated users can read verified prop firm rules" on public.prop_firm_rule_versions;
create policy "Authenticated users can read verified prop firm rules"
  on public.prop_firm_rule_versions
  for select
  to authenticated
  using (status = 'verified');

insert into public.prop_firm_rule_versions (
  id, firm_slug, firm_name, program_slug, program, path, account_size,
  profit_target, maximum_loss_limit, daily_loss_limit, optional_daily_loss_limit,
  responsible_trading_discount, responsible_trading_benefit,
  maximum_contracts, maximum_micros, consistency_target_pct, minimum_trading_days,
  drawdown_type, activation_fee, monthly_price, version, status, effective_from,
  verified_at, source_url, secondary_source_urls, note
)
values
  ('topstep-trading-combine-50000-standard-v1','topstep','Topstep','trading-combine','Trading Combine','standard',50000,3000,2000,null,1000,0,'',5,50,50,2,'trailing',149,49,1,'verified','2026-06-18','2026-06-22T00:00:00Z','https://help.topstep.com/en/articles/8284197-trading-combine-parameters','["https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit","https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account","https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions"]'::jsonb,'Standard path. Optional fixed $1,000 daily loss limit.'),
  ('topstep-trading-combine-50000-no-activation-fee-v1','topstep','Topstep','trading-combine','Trading Combine','no_activation_fee',50000,3000,2000,null,1000,10,'Double payout caps after passing while the limited-time offer is active.',5,50,50,2,'trailing',0,95,1,'verified','2026-06-18','2026-06-22T00:00:00Z','https://help.topstep.com/en/articles/8284197-trading-combine-parameters','["https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit","https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account","https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions"]'::jsonb,'No Activation Fee path. Optional fixed $1,000 daily loss limit.'),
  ('topstep-trading-combine-100000-standard-v1','topstep','Topstep','trading-combine','Trading Combine','standard',100000,6000,3000,null,2000,0,'',10,100,50,2,'trailing',149,99,1,'verified','2026-06-18','2026-06-22T00:00:00Z','https://help.topstep.com/en/articles/8284197-trading-combine-parameters','["https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit","https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account","https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions"]'::jsonb,'Standard path. Optional fixed $2,000 daily loss limit.'),
  ('topstep-trading-combine-100000-no-activation-fee-v1','topstep','Topstep','trading-combine','Trading Combine','no_activation_fee',100000,6000,3000,null,2000,20,'Double payout caps after passing while the limited-time offer is active.',10,100,50,2,'trailing',0,149,1,'verified','2026-06-18','2026-06-22T00:00:00Z','https://help.topstep.com/en/articles/8284197-trading-combine-parameters','["https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit","https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account","https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions"]'::jsonb,'No Activation Fee path. Optional fixed $2,000 daily loss limit.'),
  ('topstep-trading-combine-150000-standard-v1','topstep','Topstep','trading-combine','Trading Combine','standard',150000,9000,4500,null,3000,0,'',15,150,50,2,'trailing',149,199,1,'verified','2026-06-18','2026-06-22T00:00:00Z','https://help.topstep.com/en/articles/8284197-trading-combine-parameters','["https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit","https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account","https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions"]'::jsonb,'Standard path. Optional fixed $3,000 daily loss limit.'),
  ('topstep-trading-combine-150000-no-activation-fee-v1','topstep','Topstep','trading-combine','Trading Combine','no_activation_fee',150000,9000,4500,null,3000,30,'Double payout caps after passing while the limited-time offer is active.',15,150,50,2,'trailing',0,229,1,'verified','2026-06-18','2026-06-22T00:00:00Z','https://help.topstep.com/en/articles/8284197-trading-combine-parameters','["https://help.topstep.com/en/articles/8284204-what-is-the-maximum-loss-limit","https://help.topstep.com/en/articles/10490293-daily-loss-limit-in-the-trading-combine-and-express-funded-account","https://help.topstep.com/en/articles/14289835-topstep-pricing-and-payment-questions"]'::jsonb,'No Activation Fee path. Optional fixed $3,000 daily loss limit.')
on conflict (id) do update set
  profit_target = excluded.profit_target,
  maximum_loss_limit = excluded.maximum_loss_limit,
  optional_daily_loss_limit = excluded.optional_daily_loss_limit,
  responsible_trading_discount = excluded.responsible_trading_discount,
  responsible_trading_benefit = excluded.responsible_trading_benefit,
  maximum_contracts = excluded.maximum_contracts,
  maximum_micros = excluded.maximum_micros,
  consistency_target_pct = excluded.consistency_target_pct,
  minimum_trading_days = excluded.minimum_trading_days,
  activation_fee = excluded.activation_fee,
  monthly_price = excluded.monthly_price,
  status = excluded.status,
  effective_from = excluded.effective_from,
  verified_at = excluded.verified_at,
  source_url = excluded.source_url,
  secondary_source_urls = excluded.secondary_source_urls,
  note = excluded.note,
  updated_at = now();
