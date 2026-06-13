-- Add per-trade commission field to trades table
-- Used to track fees/commissions for accurate balance calculation
ALTER TABLE trades ADD COLUMN IF NOT EXISTS commission numeric DEFAULT 0;

-- Add commission_per_contract to trading_accounts table
-- Used to pre-fill commission in trade form based on account/firm settings
ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS commission_per_contract numeric;
