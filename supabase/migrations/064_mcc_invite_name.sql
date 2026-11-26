-- MCC side (docs/billing-data-model.md): small additions to 061.
--
--   mcc_signup_invites.name   the agency's name, given by the platform admin
--                             when inviting; becomes the MCC account's name.
--   access_grants index       a User account's open requests and grants are
--                             listed on its Agency access page.
--
-- Additive only. Idempotent: safe to replay via scripts/migrate.ts.
-- Rollback: supabase/rollback/rollback_064.sql

BEGIN;

ALTER TABLE mcc_signup_invites ADD COLUMN IF NOT EXISTS name text;

CREATE INDEX IF NOT EXISTS idx_access_grants_user ON access_grants(user_account_id, status);

COMMIT;
