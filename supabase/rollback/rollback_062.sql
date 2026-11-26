-- Rollback of 062_subscription_cancel_at.sql.

BEGIN;

ALTER TABLE subscriptions DROP COLUMN IF EXISTS cancel_at;
DELETE FROM schema_migrations WHERE filename = '062_subscription_cancel_at.sql';

COMMIT;
