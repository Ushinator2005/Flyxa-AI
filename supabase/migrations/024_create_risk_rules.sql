-- Dedicated risk_rules table: stores a user's rule set independently of the
-- main flyxa_data blob so rules are never lost in a blob merge race.
CREATE TABLE IF NOT EXISTS public.risk_rules (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  rules      jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.risk_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "risk_rules_owner_all"
  ON public.risk_rules FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
