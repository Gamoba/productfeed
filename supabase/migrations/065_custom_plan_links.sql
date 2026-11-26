-- Custom plans for companies Gamoba has an agreement with (decision 24; the
-- "contact us" Enterprise route ends in one of these).
--
--   plans                a custom plan may wait for its account: account_id
--                        stays NULL until someone signs up through its link.
--                        Public plans still never have an account.
--   plan_signup_links    a one-time signup link for a custom plan: the new
--                        company's account gets the plan. Only the token's
--                        hash is stored; optionally locked to one email.
--
-- Additive (the check is relaxed, not tightened). Idempotent.
-- Rollback: supabase/rollback/rollback_065.sql

BEGIN;

ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_custom_account;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_public_no_account') THEN
    ALTER TABLE plans ADD CONSTRAINT plans_public_no_account CHECK (is_custom OR account_id IS NULL);
  END IF;
END $$;

ALTER TABLE plans ADD COLUMN IF NOT EXISTS note text;

CREATE TABLE IF NOT EXISTS plan_signup_links (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id     text        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL UNIQUE,
  email       text,
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  account_id  uuid        REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_plan_signup_links_plan ON plan_signup_links(plan_id);

-- Service role only, like every billing table (migrations 061, 063).
ALTER TABLE plan_signup_links ENABLE ROW LEVEL SECURITY;

COMMIT;
