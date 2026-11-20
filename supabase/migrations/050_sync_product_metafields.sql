-- Write a sync's metafields as a DIFF instead of delete-everything-and-reinsert.
--
-- The sync used to delete every metafield of the synced products and insert
-- them all again: ~60k rows per BWH feed per sync, nearly all unchanged. Each
-- deleted/rewritten row (and its TOASTed value) leaves a dead version for
-- autovacuum to clean up, and on this small instance that cleanup starved the
-- app of CPU for minutes after a sync (Products page stuck loading,
-- 2026-11-20).
--
-- This function gets the products' complete current metafields and touches
-- only what differs:
--   • new (product, namespace, key)            → INSERT
--   • existing, value or type changed          → UPDATE
--   • existing, identical                      → nothing (no new row version)
--   • existing, no longer sent for that product → DELETE
-- Scoped to p_product_ids, so a chunked caller never deletes another chunk's
-- rows. Products that left the source entirely are removed by the products
-- cleanup (ON DELETE CASCADE), not here.
--
-- IS DISTINCT FROM, not <>: value and type are nullable.
--
-- Returns the counts so the sync can log what it actually wrote.
--
-- Idempotent: CREATE OR REPLACE so migrate.ts can replay it.

CREATE OR REPLACE FUNCTION sync_product_metafields(
  p_feed_id     uuid,
  p_product_ids uuid[],
  p_rows        jsonb
)
RETURNS TABLE (inserted integer, updated integer, deleted integer)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH incoming AS (
    SELECT
      (r ->> 'product_id')::uuid AS product_id,
      r ->> 'namespace'          AS namespace,
      r ->> 'key'                AS key,
      r ->> 'value'              AS value,
      r ->> 'type'               AS type
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
  ),
  removed AS (
    DELETE FROM product_metafields m
    WHERE m.feed_id = p_feed_id
      AND m.product_id = ANY (p_product_ids)
      AND NOT EXISTS (
        SELECT 1 FROM incoming i
        WHERE i.product_id = m.product_id
          AND i.namespace  = m.namespace
          AND i.key        = m.key
      )
    RETURNING 1
  ),
  written AS (
    INSERT INTO product_metafields (feed_id, product_id, namespace, key, value, type)
    SELECT p_feed_id, i.product_id, i.namespace, i.key, i.value, i.type
    FROM incoming i
    ON CONFLICT (feed_id, product_id, namespace, key) DO UPDATE
      SET value = EXCLUDED.value,
          type  = EXCLUDED.type
      WHERE product_metafields.value IS DISTINCT FROM EXCLUDED.value
         OR product_metafields.type  IS DISTINCT FROM EXCLUDED.type
    -- xmax = 0 only on a freshly inserted row: tells inserts from updates.
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT
    (SELECT count(*) FROM written WHERE was_insert)::integer,
    (SELECT count(*) FROM written WHERE NOT was_insert)::integer,
    (SELECT count(*) FROM removed)::integer;
END;
$$;

-- PostgREST caches the schema; make the new function callable via .rpc().
NOTIFY pgrst, 'reload schema';
