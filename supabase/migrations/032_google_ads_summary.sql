-- Aggregation functions for the Google Ads product performance view.
--
-- WHY SQL AND NOT JAVASCRIPT: google_ads_product_daily holds one row per item
-- per day. A 10.000-SKU catalogue over a 90-day window is ~900k rows — fine for
-- Postgres to fold, hopeless to page through PostgREST and sum in the browser.
-- Aggregating here keeps the page fast regardless of catalogue size.
--
-- Ratios (ROAS, POAS, CTR, CPC) are deliberately NOT computed here. They are
-- derived in TypeScript so that "no spend" stays distinguishable from "zero
-- return" — SQL would have to pick between NULL and 0, and 0 is a lie that would
-- later put every unserved product in a "loser" bucket.
--
-- Read-only: both functions are STABLE and touch nothing.
-- Idempotent: CREATE OR REPLACE.

BEGIN;

-- ── Product-level roll-up ──────────────────────────────────────────────────
-- Google reports per Merchant Center offer (variant); this folds those up to
-- the Shopify product and joins the catalogue for title/handle/image.
--
-- Rows whose product_ref is NULL (an item id the pattern could not parse) are
-- returned under a NULL product_ref rather than dropped, so unmatched spend is
-- VISIBLE in the UI instead of quietly vanishing from the totals.

CREATE OR REPLACE FUNCTION google_ads_product_summary(
  p_feed_id uuid,
  p_from    date,
  p_to      date
)
RETURNS TABLE (
  product_ref       text,
  title             text,
  handle            text,
  image_url         text,
  product_type      text,
  vendor            text,
  variant_count     bigint,
  impressions       bigint,
  clicks            bigint,
  cost              numeric,
  conversions       numeric,
  conversions_value numeric,
  roas_conversions  numeric,
  roas_value        numeric,
  poas_conversions  numeric,
  poas_value        numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    d.product_ref,
    p.title,
    p.handle,
    (p.images -> 0 ->> 'src')            AS image_url,
    p.product_type,
    p.vendor,
    count(DISTINCT d.item_id)            AS variant_count,
    sum(d.impressions)::bigint           AS impressions,
    sum(d.clicks)::bigint                AS clicks,
    -- micros → currency units once, at the aggregate, so no float drift per row
    (sum(d.cost_micros)::numeric / 1000000) AS cost,
    sum(d.conversions)                   AS conversions,
    sum(d.conversions_value)             AS conversions_value,
    sum(d.roas_conversions)              AS roas_conversions,
    sum(d.roas_value)                    AS roas_value,
    sum(d.poas_conversions)              AS poas_conversions,
    sum(d.poas_value)                    AS poas_value
  FROM google_ads_product_daily d
  LEFT JOIN products p
         ON p.feed_id = d.feed_id
        AND p.shopify_id = d.product_ref
  WHERE d.feed_id = p_feed_id
    AND d.date BETWEEN p_from AND p_to
  GROUP BY d.product_ref, p.title, p.handle, (p.images -> 0 ->> 'src'),
           p.product_type, p.vendor
$$;

-- ── Variant-level detail ───────────────────────────────────────────────────
-- One row per Merchant Center item, with the variant's own attributes pulled
-- out of products.variants. That jsonb already carries option1/2/3, title, sku
-- and price (lib/sync.ts stores the full Shopify variant), which is what makes
-- size/colour reporting possible without another Shopify read.
--
-- NOTE: the option NAMES ("Size", "Colour") are not stored — only their
-- values — so the UI labels these generically until products.options is added.

CREATE OR REPLACE FUNCTION google_ads_variant_summary(
  p_feed_id     uuid,
  p_from        date,
  p_to          date,
  p_product_ref text DEFAULT NULL
)
RETURNS TABLE (
  item_id           text,
  product_ref       text,
  variant_ref       text,
  product_title     text,
  variant_title     text,
  sku               text,
  option1           text,
  option2           text,
  option3           text,
  price             text,
  impressions       bigint,
  clicks            bigint,
  cost              numeric,
  conversions       numeric,
  conversions_value numeric,
  roas_conversions  numeric,
  roas_value        numeric,
  poas_conversions  numeric,
  poas_value        numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH agg AS (
    SELECT
      d.item_id,
      d.product_ref,
      d.variant_ref,
      sum(d.impressions)::bigint              AS impressions,
      sum(d.clicks)::bigint                   AS clicks,
      (sum(d.cost_micros)::numeric / 1000000) AS cost,
      sum(d.conversions)                      AS conversions,
      sum(d.conversions_value)                AS conversions_value,
      sum(d.roas_conversions)                 AS roas_conversions,
      sum(d.roas_value)                       AS roas_value,
      sum(d.poas_conversions)                 AS poas_conversions,
      sum(d.poas_value)                       AS poas_value
    FROM google_ads_product_daily d
    WHERE d.feed_id = p_feed_id
      AND d.date BETWEEN p_from AND p_to
      AND (p_product_ref IS NULL OR d.product_ref = p_product_ref)
    GROUP BY d.item_id, d.product_ref, d.variant_ref
  )
  SELECT
    a.item_id,
    a.product_ref,
    a.variant_ref,
    p.title AS product_title,
    variant.v ->> 'title'   AS variant_title,
    variant.v ->> 'sku'     AS sku,
    variant.v ->> 'option1' AS option1,
    variant.v ->> 'option2' AS option2,
    variant.v ->> 'option3' AS option3,
    variant.v ->> 'price'   AS price,
    a.impressions, a.clicks, a.cost,
    a.conversions, a.conversions_value,
    a.roas_conversions, a.roas_value,
    a.poas_conversions, a.poas_value
  FROM agg a
  LEFT JOIN products p
         ON p.feed_id = p_feed_id
        AND p.shopify_id = a.product_ref
  -- LATERAL so the variant lookup runs per row; LIMIT 1 because variant ids are
  -- unique within a product.
  LEFT JOIN LATERAL (
    SELECT elem AS v
    FROM jsonb_array_elements(COALESCE(p.variants, '[]'::jsonb)) AS elem
    WHERE elem ->> 'id' = a.variant_ref
    LIMIT 1
  ) AS variant ON true
$$;

COMMIT;
