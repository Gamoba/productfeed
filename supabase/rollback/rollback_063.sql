-- Rollback of 063_lock_public_api.sql. This REOPENS the public data API to
-- the state before 063 (see that file for why it was closed). Only use it if
-- 063 broke something, and re-close as soon as possible.

BEGIN;

-- 1. RLS off again on the tables that had none before 063.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bucket_examples', 'bucket_products', 'bucket_title_config', 'feed_cache', 'feed_filters',
    'feed_mappings', 'feed_settings', 'feeds', 'google_ads_bucket_members', 'google_ads_buckets',
    'google_ads_campaign_daily', 'google_ads_campaigns', 'google_ads_connections',
    'google_ads_custom_labels', 'google_ads_feed_settings', 'google_ads_product_conversions',
    'google_ads_product_daily', 'optimization_buckets', 'product_metafields',
    'product_title_optimizations', 'products', 'rate_limit_counters', 'shopify_order_line_items',
    'shopify_order_sync_state', 'shopify_orders', 'shopify_refund_line_items', 'shopify_refunds',
    'shopify_return_line_items', 'shopify_returns', 'title_optimization_filters',
    'title_optimization_settings', 'title_rules', 'variant_costs', 'variant_stock_snapshots'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- 2. The previous write-everything policies.
DROP POLICY IF EXISTS "Members can read account projects" ON projects;
DROP POLICY IF EXISTS "Members can manage account projects" ON projects;
CREATE POLICY "Members can manage account projects"
  ON projects FOR ALL
  USING (EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = projects.account_id AND m.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = projects.account_id AND m.user_id = auth.uid()));

DROP POLICY IF EXISTS "Users can read own shop settings" ON shop_settings;
DROP POLICY IF EXISTS "Users can manage own shop settings" ON shop_settings;
CREATE POLICY "Users can manage own shop settings"
  ON shop_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 3. EXECUTE back to everyone on the app functions (except the two that 055
--    had already restricted).
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.prorettype <> 'trigger'::regtype
      AND p.prorettype <> 'event_trigger'::regtype
      AND p.proname NOT IN ('rls_auto_enable', 'account_member_profiles', 'auth_user_id_by_email')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', f.sig);
  END LOOP;
END $$;

DELETE FROM schema_migrations WHERE filename = '063_lock_public_api.sql';

COMMIT;
