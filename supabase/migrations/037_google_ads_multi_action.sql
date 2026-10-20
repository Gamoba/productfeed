-- Let ROAS and POAS each be defined by SEVERAL conversion actions, summed.
--
-- WHY: migration 033 made the definition a display-time choice of one action.
-- That covers "which of these three actions is really revenue", but not accounts
-- whose revenue is split across actions that are each only part of the picture —
-- new vs returning customers, or one action per market. Those have to be added
-- together to mean anything.
--
-- SUMMING IS THE OPERATOR'S RESPONSIBILITY. Actions overlap by design: the same
-- order is normally counted by several at once, so ticking two that both cover
-- all customers double-counts. The UI says so; the database does not try to
-- detect it, because overlap is not decidable from the stored totals.
--
-- ── THE HAZARD THIS MIGRATION EXISTS TO AVOID ──────────────────────────────
-- 033 joined the conversions table directly and leaned on
-- UNIQUE(feed_id, date, item_id, conversion_action) to guarantee AT MOST ONE
-- matching row per join — which is what kept sum(impressions), sum(clicks) and
-- sum(cost_micros) honest. Swapping `= p_action` for `= ANY(p_actions)` breaks
-- that invariant: N ticked actions can match N rows per item-day, multiplying
-- cost and clicks, and with both sides multi-valued you get the PRODUCT of the
-- two. Nothing errors — the numbers just quietly inflate.
--
-- So the conversions are folded to one row per (date, item_id) in a CTE BEFORE
-- the join. The at-most-one-row invariant is restored, and the cost and click
-- sums are unaffected by how many actions are ticked.
--
-- Idempotent: IF [NOT] EXISTS / DROP IF EXISTS, and the column swap is guarded.

BEGIN;

-- ── 1. Settings: one action becomes many ───────────────────────────────────
-- Plural columns rather than a widened scalar, so the name stays honest. Empty
-- array, not NULL, for "nothing chosen" — one representation of absence.

ALTER TABLE google_ads_feed_settings
  ADD COLUMN IF NOT EXISTS roas_conversion_actions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS poas_conversion_actions text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'google_ads_feed_settings'
      AND column_name = 'roas_conversion_action'
  ) THEN
    UPDATE google_ads_feed_settings
       SET roas_conversion_actions = CASE
             WHEN COALESCE(roas_conversion_action, '') = '' THEN '{}'::text[]
             ELSE ARRAY[roas_conversion_action]
           END,
           poas_conversion_actions = CASE
             WHEN COALESCE(poas_conversion_action, '') = '' THEN '{}'::text[]
             ELSE ARRAY[poas_conversion_action]
           END;

    ALTER TABLE google_ads_feed_settings
      DROP COLUMN roas_conversion_action,
      DROP COLUMN poas_conversion_action;
  END IF;
END $$;

-- ── 2. Summaries, parameterised by action SETS ─────────────────────────────
-- The old scalar signatures are dropped explicitly. text and text[] overloads
-- would both be resolvable from a NULL argument, which makes the call ambiguous
-- rather than merely wrong — the same reasoning as migration 033.

DROP FUNCTION IF EXISTS google_ads_product_summary(uuid, date, date, text, text);
DROP FUNCTION IF EXISTS google_ads_variant_summary(uuid, date, date, text, text, text);

CREATE OR REPLACE FUNCTION google_ads_product_summary(
  p_feed_id      uuid,
  p_from         date,
  p_to           date,
  p_roas_actions text[] DEFAULT NULL,
  p_poas_actions text[] DEFAULT NULL
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
  -- One row per (date, item_id) whatever the number of ticked actions. NULL and
  -- '{}' both mean "nothing chosen" and yield no rows, so the caller may send
  -- either without a special case.
  WITH rc AS (
    SELECT c.date, c.item_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_roas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id
  ),
  pc AS (
    SELECT c.date, c.item_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_poas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id
  )
  SELECT
    d.product_ref,
    p.title,
    p.handle,
    (p.images -> 0 ->> 'src')               AS image_url,
    p.product_type,
    p.vendor,
    count(DISTINCT d.item_id)               AS variant_count,
    sum(d.impressions)::bigint              AS impressions,
    sum(d.clicks)::bigint                   AS clicks,
    (sum(d.cost_micros)::numeric / 1000000) AS cost,
    sum(d.conversions)                      AS conversions,
    sum(d.conversions_value)                AS conversions_value,
    COALESCE(sum(rc.conversions), 0)        AS roas_conversions,
    COALESCE(sum(rc.conversions_value), 0)  AS roas_value,
    COALESCE(sum(pc.conversions), 0)        AS poas_conversions,
    COALESCE(sum(pc.conversions_value), 0)  AS poas_value
  FROM google_ads_product_daily d
  LEFT JOIN products p
         ON p.feed_id = d.feed_id
        AND p.shopify_id = d.product_ref
  LEFT JOIN rc ON rc.date = d.date AND rc.item_id = d.item_id
  LEFT JOIN pc ON pc.date = d.date AND pc.item_id = d.item_id
  WHERE d.feed_id = p_feed_id
    AND d.date BETWEEN p_from AND p_to
  GROUP BY d.product_ref, p.title, p.handle, (p.images -> 0 ->> 'src'),
           p.product_type, p.vendor
$$;

CREATE OR REPLACE FUNCTION google_ads_variant_summary(
  p_feed_id      uuid,
  p_from         date,
  p_to           date,
  p_product_ref  text   DEFAULT NULL,
  p_roas_actions text[] DEFAULT NULL,
  p_poas_actions text[] DEFAULT NULL
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
  WITH rc AS (
    SELECT c.date, c.item_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_roas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id
  ),
  pc AS (
    SELECT c.date, c.item_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_poas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id
  ),
  agg AS (
    SELECT
      d.item_id,
      d.product_ref,
      d.variant_ref,
      sum(d.impressions)::bigint              AS impressions,
      sum(d.clicks)::bigint                   AS clicks,
      (sum(d.cost_micros)::numeric / 1000000) AS cost,
      sum(d.conversions)                      AS conversions,
      sum(d.conversions_value)                AS conversions_value,
      COALESCE(sum(rc.conversions), 0)        AS roas_conversions,
      COALESCE(sum(rc.conversions_value), 0)  AS roas_value,
      COALESCE(sum(pc.conversions), 0)        AS poas_conversions,
      COALESCE(sum(pc.conversions_value), 0)  AS poas_value
    FROM google_ads_product_daily d
    LEFT JOIN rc ON rc.date = d.date AND rc.item_id = d.item_id
    LEFT JOIN pc ON pc.date = d.date AND pc.item_id = d.item_id
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
  LEFT JOIN LATERAL (
    SELECT elem AS v
    FROM jsonb_array_elements(COALESCE(p.variants, '[]'::jsonb)) AS elem
    WHERE elem ->> 'id' = a.variant_ref
    LIMIT 1
  ) AS variant ON true
$$;

COMMIT;
