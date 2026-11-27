-- Rollback of 067_products_feed_order_index.sql. Only drops the index; no
-- data is involved. The queries go back to sorting each page.

BEGIN;

DROP INDEX IF EXISTS idx_products_feed_active_order;
DELETE FROM schema_migrations WHERE filename = '067_products_feed_order_index.sql';

COMMIT;
