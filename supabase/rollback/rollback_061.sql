-- Rollback of 061_billing_accounts.sql. Drops every billing table and the new
-- accounts columns. All billing data (subscriptions, referrals, commissions)
-- is lost; Stripe itself keeps its customers and subscriptions.

BEGIN;

DROP TABLE IF EXISTS commissions;
DROP TABLE IF EXISTS commission_payouts;
DROP TABLE IF EXISTS referrals;
DROP TABLE IF EXISTS access_grants;
DROP TABLE IF EXISTS referral_links;
DROP TABLE IF EXISTS mcc_signup_invites;
DROP TABLE IF EXISTS stripe_events;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS stripe_customers;
DROP TABLE IF EXISTS plan_prices;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS platform_settings;
DROP TABLE IF EXISTS platform_admins;

DROP INDEX IF EXISTS accounts_access_code_key;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_type_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_commission_rate_check;
ALTER TABLE accounts
  DROP COLUMN IF EXISTS type,
  DROP COLUMN IF EXISTS billing_exempt,
  DROP COLUMN IF EXISTS access_code,
  DROP COLUMN IF EXISTS commission_rate;

DELETE FROM schema_migrations WHERE filename = '061_billing_accounts.sql';

COMMIT;
