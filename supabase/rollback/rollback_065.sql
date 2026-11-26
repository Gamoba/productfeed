-- Rollback of 065_custom_plan_links.sql. Custom plans still waiting for an
-- account (account_id NULL) must be removed or given an account first, or
-- the old check can't be restored.

BEGIN;

DROP TABLE IF EXISTS plan_signup_links;
ALTER TABLE plans DROP COLUMN IF EXISTS note;
ALTER TABLE plans DROP CONSTRAINT IF EXISTS plans_public_no_account;
ALTER TABLE plans ADD CONSTRAINT plans_custom_account CHECK (is_custom = (account_id IS NOT NULL));
DELETE FROM schema_migrations WHERE filename = '065_custom_plan_links.sql';

COMMIT;
