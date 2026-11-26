-- When a subscription is set to end. Stripe's current API schedules a
-- cancellation (e.g. "cancel at the end of the period" in the customer portal)
-- by setting `cancel_at` to a date, with cancel_at_period_end left false, so
-- the flag alone misses it. NULL = not scheduled to end.
--
-- Additive only. Idempotent: safe to replay via scripts/migrate.ts.
-- Rollback: supabase/rollback/rollback_062.sql

BEGIN;

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at timestamptz;

COMMIT;
