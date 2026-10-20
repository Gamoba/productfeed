-- Store EVERY conversion action per product, and choose which one means
-- "revenue" and which means "profit" at DISPLAY time instead of at setup time.
--
-- WHY THE CHANGE: metrics.conversions_value mixes whatever an account flags as a
-- primary goal, so the meaning differs per account. Migration 031 solved that by
-- making the user pick two actions up front and syncing only those. That works,
-- but it freezes the decision: changing your mind means re-syncing, and you can
-- never compare two definitions side by side.
--
-- A real account makes the point. CoffeeTools reports the same orders three ways
-- over 90 days:
--     Google Shopping App View Item     230.246 DKK   (a view tracker!)
--     PM Revenue - All customers         25.237 DKK   (actual revenue)
--     PM Gross Profit - All customers     4.195 DKK   (actual gross profit)
-- ROAS is 34, 3,7 or 0,6 depending purely on that choice. Storing all three lets
-- a user switch between them and see the difference, which is far more useful
-- than being asked to commit before they have seen any numbers.
--
-- VOLUME: the new table is SPARSE — Google only returns action/item/day
-- combinations that actually have conversions, which is a small fraction of the
-- catalogue (13-18 of 76 items for CoffeeTools). It is nonetheless the table
-- most likely to grow on a large advertiser, hence the index below and the
-- retention note.
--
-- google_ads_product_daily keeps cost/clicks/impressions; its roas_*/poas_*
-- columns are dropped because they are now derivable. Safe: the table is empty,
-- and every value in it is a reproducible cache of the Google Ads API.
--
-- Idempotent: IF [NOT] EXISTS / DROP IF EXISTS throughout.

BEGIN;

-- ── 1. Per-action conversions ──────────────────────────────────────────────
-- Deliberately NOT denormalising product_ref: it already lives on
-- google_ads_product_daily under the same (feed_id, date, item_id) key, and
-- duplicating it invites the two tables to disagree.

CREATE TABLE IF NOT EXISTS google_ads_product_conversions (
  id                uuid           DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id           uuid           NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  date              date           NOT NULL,
  item_id           text           NOT NULL,
  -- The action NAME, as shown in Google Ads. Names are what a human recognises,
  -- and ids are not stable across accounts.
  conversion_action text           NOT NULL,
  -- all_conversions / all_conversions_value: segments.conversion_action_name is
  -- only valid alongside these, never with metrics.conversions.
  conversions       numeric(18, 4) NOT NULL DEFAULT 0,
  conversions_value numeric(18, 4) NOT NULL DEFAULT 0,
  synced_at         timestamptz    DEFAULT now(),
  UNIQUE (feed_id, date, item_id, conversion_action)
);

ALTER TABLE google_ads_product_conversions DISABLE ROW LEVEL SECURITY;

-- The join in the summary functions is on (feed_id, date, item_id) filtered by
-- one action name; the UNIQUE constraint above already covers that prefix.
CREATE INDEX IF NOT EXISTS idx_google_ads_product_conversions_feed_action
  ON google_ads_product_conversions(feed_id, conversion_action, date);

-- ── 2. Drop the now-derivable columns ──────────────────────────────────────

ALTER TABLE google_ads_product_daily
  DROP COLUMN IF EXISTS roas_conversions,
  DROP COLUMN IF EXISTS roas_value,
  DROP COLUMN IF EXISTS poas_conversions,
  DROP COLUMN IF EXISTS poas_value;

-- ── 3. Which actions exist, and how big they are ───────────────────────────
-- Powers the display-time picker. Showing each action's magnitude next to its
-- name is what makes the view-tracker trap visible: an action reporting ten
-- times the account's real revenue is self-evidently not revenue.

CREATE OR REPLACE FUNCTION google_ads_conversion_actions(
  p_feed_id uuid,
  p_from    date,
  p_to      date
)
RETURNS TABLE (
  conversion_action text,
  conversions       numeric,
  conversions_value numeric,
  items             bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT c.conversion_action,
         sum(c.conversions)                AS conversions,
         sum(c.conversions_value)          AS conversions_value,
         count(DISTINCT c.item_id)::bigint AS items
  FROM google_ads_product_conversions c
  WHERE c.feed_id = p_feed_id
    AND c.date BETWEEN p_from AND p_to
  GROUP BY c.conversion_action
  ORDER BY sum(c.conversions_value) DESC
$$;

-- ── 4. Summaries, now parameterised by the two chosen actions ──────────────
-- The old 3-argument versions must be dropped explicitly: adding parameters with
-- defaults would leave both signatures resolvable and make the call ambiguous.

DROP FUNCTION IF EXISTS google_ads_product_summary(uuid, date, date);
DROP FUNCTION IF EXISTS google_ads_variant_summary(uuid, date, date, text);

CREATE OR REPLACE FUNCTION google_ads_product_summary(
  p_feed_id     uuid,
  p_from        date,
  p_to          date,
  p_roas_action text DEFAULT NULL,
  p_poas_action text DEFAULT NULL
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
  -- At most one row each, thanks to UNIQUE(feed_id, date, item_id, action) —
  -- so these joins cannot fan out and inflate the cost/click sums above.
  LEFT JOIN google_ads_product_conversions rc
         ON p_roas_action IS NOT NULL
        AND rc.feed_id = d.feed_id AND rc.date = d.date AND rc.item_id = d.item_id
        AND rc.conversion_action = p_roas_action
  LEFT JOIN google_ads_product_conversions pc
         ON p_poas_action IS NOT NULL
        AND pc.feed_id = d.feed_id AND pc.date = d.date AND pc.item_id = d.item_id
        AND pc.conversion_action = p_poas_action
  WHERE d.feed_id = p_feed_id
    AND d.date BETWEEN p_from AND p_to
  GROUP BY d.product_ref, p.title, p.handle, (p.images -> 0 ->> 'src'),
           p.product_type, p.vendor
$$;

CREATE OR REPLACE FUNCTION google_ads_variant_summary(
  p_feed_id     uuid,
  p_from        date,
  p_to          date,
  p_product_ref text DEFAULT NULL,
  p_roas_action text DEFAULT NULL,
  p_poas_action text DEFAULT NULL
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
      COALESCE(sum(rc.conversions), 0)        AS roas_conversions,
      COALESCE(sum(rc.conversions_value), 0)  AS roas_value,
      COALESCE(sum(pc.conversions), 0)        AS poas_conversions,
      COALESCE(sum(pc.conversions_value), 0)  AS poas_value
    FROM google_ads_product_daily d
    LEFT JOIN google_ads_product_conversions rc
           ON p_roas_action IS NOT NULL
          AND rc.feed_id = d.feed_id AND rc.date = d.date AND rc.item_id = d.item_id
          AND rc.conversion_action = p_roas_action
    LEFT JOIN google_ads_product_conversions pc
           ON p_poas_action IS NOT NULL
          AND pc.feed_id = d.feed_id AND pc.date = d.date AND pc.item_id = d.item_id
          AND pc.conversion_action = p_poas_action
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
