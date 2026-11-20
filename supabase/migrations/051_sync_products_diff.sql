-- Write a sync's products as a DIFF, like migration 050 did for metafields.
--
-- The sync upserted every product on every run — 2.6k rows per BWH feed with
-- their images/variants/collections JSON — so each sync left a full set of
-- dead row versions for autovacuum, nearly all of them for unchanged products.
--
-- ── 1. feeds.last_synced_at ─────────────────────────────────────────────────
-- "Last synced" used to be max(products.synced_at). Once unchanged products
-- are no longer rewritten, their synced_at stops moving, so that stops being
-- the sync time. The feed row records it instead: set by lib/syncProgress.ts
-- when a sync finishes successfully. Backfilled from the old source so every
-- existing feed keeps showing the same date until its next sync.

BEGIN;

ALTER TABLE feeds ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

COMMENT ON COLUMN feeds.last_synced_at IS
  'When the last successful product sync finished. Replaces max(products.synced_at), which no longer moves for unchanged products (migration 051).';

UPDATE feeds f
SET last_synced_at = s.max_synced
FROM (
  SELECT feed_id, max(synced_at) AS max_synced
  FROM products
  WHERE synced_at IS NOT NULL
  GROUP BY feed_id
) s
WHERE s.feed_id = f.id
  AND f.last_synced_at IS NULL;

-- ── 2. sync_products ────────────────────────────────────────────────────────
-- Inserts new products, updates changed ones, and leaves identical ones alone
-- (no new row version). Returns EVERY sent product's id — the caller needs the
-- uuids to attach metafields, unchanged products included — with whether it
-- was inserted / written.
--
-- Products that left the source are not handled here: the sync's cleanup step
-- deletes them (metafields follow via ON DELETE CASCADE).
--
-- LANGUAGE sql, not plpgsql: RETURNS TABLE column names (id, shopify_id) would
-- otherwise become plpgsql variables and clash with the table's columns.
--
-- The final SELECT reads the statement's starting snapshot, so it sees every
-- pre-existing product and none of this call's inserts; `written` supplies
-- those, and the NOT EXISTS keeps updated rows from being listed twice.

CREATE OR REPLACE FUNCTION sync_products(
  p_feed_id   uuid,
  p_synced_at timestamptz,
  p_rows      jsonb
)
RETURNS TABLE (shopify_id text, id uuid, was_insert boolean, was_written boolean)
LANGUAGE sql
AS $$
  WITH incoming AS (
    SELECT *
    FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb)) AS r(
      shopify_id   text,
      title        text,
      body_html    text,
      vendor       text,
      product_type text,
      status       text,
      handle       text,
      link         text,
      published_at timestamptz,
      tags         text,
      images       jsonb,
      variants     jsonb,
      options      jsonb,
      collections  jsonb
    )
  ),
  written AS (
    INSERT INTO products AS p (
      feed_id, shopify_id, title, body_html, vendor, product_type, status, handle,
      link, published_at, tags, images, variants, options, collections,
      synced_at, updated_at
    )
    SELECT
      p_feed_id, i.shopify_id, i.title, i.body_html, i.vendor, i.product_type, i.status,
      i.handle, i.link, i.published_at, i.tags,
      COALESCE(i.images, '[]'::jsonb), COALESCE(i.variants, '[]'::jsonb),
      COALESCE(i.options, '[]'::jsonb), COALESCE(i.collections, '[]'::jsonb),
      p_synced_at, p_synced_at
    FROM incoming i
    ON CONFLICT (feed_id, shopify_id) DO UPDATE
      SET title        = EXCLUDED.title,
          body_html    = EXCLUDED.body_html,
          vendor       = EXCLUDED.vendor,
          product_type = EXCLUDED.product_type,
          status       = EXCLUDED.status,
          handle       = EXCLUDED.handle,
          link         = EXCLUDED.link,
          published_at = EXCLUDED.published_at,
          tags         = EXCLUDED.tags,
          images       = EXCLUDED.images,
          variants     = EXCLUDED.variants,
          options      = EXCLUDED.options,
          collections  = EXCLUDED.collections,
          synced_at    = EXCLUDED.synced_at,
          updated_at   = EXCLUDED.updated_at
      -- Row comparison with IS DISTINCT FROM: NULL-safe, and jsonb compares
      -- by value (key order doesn't matter).
      WHERE (p.title, p.body_html, p.vendor, p.product_type, p.status, p.handle,
             p.link, p.published_at, p.tags, p.images, p.variants, p.options, p.collections)
         IS DISTINCT FROM
            (EXCLUDED.title, EXCLUDED.body_html, EXCLUDED.vendor, EXCLUDED.product_type,
             EXCLUDED.status, EXCLUDED.handle, EXCLUDED.link, EXCLUDED.published_at,
             EXCLUDED.tags, EXCLUDED.images, EXCLUDED.variants, EXCLUDED.options,
             EXCLUDED.collections)
    -- xmax = 0 only on a freshly inserted row.
    RETURNING p.shopify_id, p.id, (p.xmax = 0) AS was_insert
  )
  SELECT w.shopify_id, w.id, w.was_insert, true FROM written w
  UNION ALL
  SELECT p.shopify_id, p.id, false, false
  FROM products p
  JOIN incoming i ON i.shopify_id = p.shopify_id
  WHERE p.feed_id = p_feed_id
    AND NOT EXISTS (SELECT 1 FROM written w WHERE w.shopify_id = p.shopify_id);
$$;

COMMIT;

-- PostgREST caches the schema; make the new function callable via .rpc().
NOTIFY pgrst, 'reload schema';
