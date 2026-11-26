-- Rollback of 064_mcc_invite_name.sql.

BEGIN;

DROP INDEX IF EXISTS idx_access_grants_user;
ALTER TABLE mcc_signup_invites DROP COLUMN IF EXISTS name;
DELETE FROM schema_migrations WHERE filename = '064_mcc_invite_name.sql';

COMMIT;
