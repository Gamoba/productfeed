-- Rollback of 060_feed_counts.sql. Without the table the app counts live
-- again (lib/feedCounts reads nothing and skips the write).

BEGIN;

DROP TABLE IF EXISTS feed_counts;
DELETE FROM schema_migrations WHERE filename = '060_feed_counts.sql';

COMMIT;
