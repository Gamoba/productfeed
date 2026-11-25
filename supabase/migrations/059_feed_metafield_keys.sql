-- The distinct metafields (namespace, key) of a feed's products, with how many
-- metafield rows each has, grouped in the database.
--
-- The app used to page through every product_metafields row of the feed
-- (1000 at a time) to find the distinct keys: ~60 sequential requests and
-- 8–20 s for a store with ~24 metafields per product. This is one query.
--
-- Read-only and additive: a function, no table changes. Only the service role
-- (the app's server) may call it. Nothing touches Shopify.
--
-- Idempotent: safe to replay via scripts/migrate.ts.
-- Rollback: supabase/rollback/rollback_059.sql

BEGIN;

CREATE OR REPLACE FUNCTION feed_metafield_keys(p_feed_id uuid)
RETURNS TABLE (namespace text, key text, rows bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT m.namespace, m.key, count(*)::bigint AS rows
  FROM product_metafields m
  WHERE m.feed_id = p_feed_id
  GROUP BY m.namespace, m.key
  ORDER BY m.namespace, m.key
$$;

REVOKE ALL ON FUNCTION feed_metafield_keys(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION feed_metafield_keys(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION feed_metafield_keys(uuid) TO service_role;

COMMIT;
