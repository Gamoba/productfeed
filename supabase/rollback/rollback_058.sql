-- Rollback of 058_master_fields.sql.
--
-- Drops the master_fields table. Feed mappings of type MASTER and `master:`
-- references are left in place; without the table they evaluate to '' (empty),
-- so run this only when no feed uses master fields, or remap those fields
-- first. Check with:
--   SELECT feed_id, google_field FROM feed_mappings
--   WHERE mapping_type = 'MASTER' OR config::text LIKE '%"master:%';

BEGIN;

DROP TABLE IF EXISTS master_fields;
DELETE FROM schema_migrations WHERE filename = '058_master_fields.sql';

COMMIT;
