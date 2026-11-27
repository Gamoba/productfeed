-- An index for the query every heavy path runs.
--
-- Products are read the same way everywhere (fetchAllActiveProducts in
-- lib/feedGenerator.ts): the feed's active products, oldest first, a page at a
-- time —
--
--   WHERE feed_id = ? AND status = 'active' ORDER BY created_at, id OFFSET n LIMIT k
--
-- The indexes on products were (feed_id), the unique (feed_id, shopify_id) and
-- (shopify_id). None of them carries that order, so Postgres read the feed's
-- whole active set and sorted it — for every page. One pass over an
-- 11k-product feed is ~44 pages, so ~44 sorts of 11k rows, and that pass runs
-- for feed generation, validation, the product counts, the preview, the
-- products page and the daily SKU count.
--
-- With this index each page is an ordered range scan: no sort, and the OFFSET
-- is skipped inside the index.
--
-- Lock: CREATE INDEX takes ACCESS EXCLUSIVE on products while it builds —
-- seconds on a table this size, during which feeds are still served from
-- feed_cache. On a busy moment, run this instead and then record it by hand:
--
--   CREATE INDEX CONCURRENTLY idx_products_feed_active_order
--     ON products (feed_id, status, created_at, id);
--   INSERT INTO schema_migrations (filename)
--     VALUES ('067_products_feed_order_index.sql');
--
-- CONCURRENTLY cannot run inside a transaction, which is why it isn't the
-- form used here.
--
-- Additive and idempotent. Nothing touches Shopify.
-- Rollback: supabase/rollback/rollback_067.sql

BEGIN;

CREATE INDEX IF NOT EXISTS idx_products_feed_active_order
  ON products (feed_id, status, created_at, id);

-- idx_products_feed_id is left alone on purpose: it is redundant now (both
-- the index above and the unique (feed_id, shopify_id) start with feed_id),
-- but dropping it is a separate decision — it costs a little on every sync
-- write and nothing else.

COMMIT;
