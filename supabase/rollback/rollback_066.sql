-- Rollback of 066_sku_usage_and_addons.sql.
--
-- Drops the SKU-usage and add-on tables. Add-ons an account still has are
-- dropped with them, so cancel the Stripe subscription items first (Billing →
-- Manage billing, or the Stripe dashboard): nothing here touches Stripe.
-- Measured usage and the record of what was billed are lost.

BEGIN;

DROP FUNCTION IF EXISTS public.shop_sku_usage_count(jsonb);
DROP TABLE IF EXISTS account_addons;
DROP TABLE IF EXISTS addon_prices;
DROP TABLE IF EXISTS addons;
DROP TABLE IF EXISTS sku_charges;
DROP TABLE IF EXISTS shop_sku_usage;
DELETE FROM schema_migrations WHERE filename = '066_sku_usage_and_addons.sql';

COMMIT;
