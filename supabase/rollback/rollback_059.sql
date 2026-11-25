-- Rollback of 059_feed_metafield_keys.sql. The app falls back to paging
-- through product_metafields when the function is missing (lib/metafieldKeys).

BEGIN;

DROP FUNCTION IF EXISTS feed_metafield_keys(uuid);
DELETE FROM schema_migrations WHERE filename = '059_feed_metafield_keys.sql';

COMMIT;
