-- Trade shares: let users share specific trades with accepted rivals.
-- Uses a trade snapshot (jsonb) instead of a FK to the trades table,
-- because trades are stored in the flyxaStore (user_store.flyxa_data),
-- not directly in the trades SQL table.
CREATE TABLE IF NOT EXISTS public.trade_shares (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id_ref         text NOT NULL,
  shared_by_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_with_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trade_snapshot       jsonb NOT NULL,
  shared_at            timestamptz DEFAULT now(),
  UNIQUE (trade_id_ref, shared_with_user_id)
);

ALTER TABLE public.trade_shares ENABLE ROW LEVEL SECURITY;

-- Sharer can create, view, and delete their own shares
CREATE POLICY "trade_shares_owner_all"
  ON public.trade_shares FOR ALL
  USING (auth.uid() = shared_by_user_id);

-- Recipient can see shares addressed to them
CREATE POLICY "trade_shares_recipient_select"
  ON public.trade_shares FOR SELECT
  USING (auth.uid() = shared_with_user_id);
