-- The campaign dimension, and the daily roll-up that makes trends possible.
--
-- Until now every Google Ads number in this app was product-shaped and
-- window-shaped: one row per item per day, folded to a single total. Two
-- questions could not be asked at all.
--
--   WHICH CAMPAIGN? "This product wasted 4.200 kr" is only actionable once you
--     know whether that was PMax, a branded Shopping campaign, or a test that
--     should have been paused. The same SKU commonly serves in several
--     campaigns at once, which is also the only way to see them bidding
--     against each other.
--
--   COMPARED TO WHEN? A ROAS of 3,1 is not a finding. A ROAS of 3,1 that was
--     4,8 last month is. The daily rows to answer this were always stored —
--     nothing ever read them at day grain.
--
-- ── THE HAZARD THIS MIGRATION MUST NOT REPEAT ──────────────────────────────
-- Migration 037 documents it exactly: the summary functions fold conversions
-- to one row per (date, item_id) in a CTE and then LEFT JOIN that onto
-- google_ads_product_daily, and the whole thing is only correct because
-- (feed_id, date, item_id) is UNIQUE on both sides. Adding a campaign grain
-- breaks that invariant in the most dangerous possible way: the daily table
-- gains N rows per item-day, each joins the SAME single conversion row, and
-- revenue silently multiplies by the number of campaigns. Nothing errors.
--
-- So the campaign column and the function rewrites are ONE migration. Every
-- fold and every join below carries campaign_id. Splitting this in two would
-- leave a window where the numbers are wrong and nothing says so.
--
-- ── WHY THE OLD ROWS ARE KEPT, NOT WIPED ───────────────────────────────────
-- Migration 033 dropped columns on the grounds that the table is "a
-- reproducible cache of the Google Ads API". That was true when the table was
-- empty. It is only half true now: the sync re-pulls a ROLLING WINDOW
-- (sync_window_days, default 90), so anything older than that window is no
-- longer reproducible — a wipe would silently shorten how far back the 365-day
-- view can see, and nothing in the UI would say why.
--
-- Instead, pre-campaign rows keep a SENTINEL campaign_id of '' meaning "synced
-- before campaigns were recorded". They still sum correctly into every product
-- total; they simply carry no campaign attribution. The sync deletes sentinel
-- rows for the window it just rewrote (lib/googleAdsSync.ts), so the sentinel
-- recedes as real data replaces it and the two can never double-count the same
-- item-day. An id Google reports as missing becomes 'unknown', never '', so a
-- genuine gap stays distinguishable from a pre-migration row.
--
-- Read-only towards Google. Idempotent: guards throughout.

BEGIN;

-- ── 1. Campaign grain on the fact tables ───────────────────────────────────

ALTER TABLE google_ads_product_daily
  ADD COLUMN IF NOT EXISTS campaign_id text NOT NULL DEFAULT '';

ALTER TABLE google_ads_product_conversions
  ADD COLUMN IF NOT EXISTS campaign_id text NOT NULL DEFAULT '';

-- The upsert targets have to move with the grain. The old constraints were
-- created inline by migration 031/033 and therefore carry generated names that
-- differ by how far Postgres truncated them, so they are located by their
-- COLUMN SET rather than by a name guessed here.
DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'u'
      AND c.conrelid IN (
        'google_ads_product_daily'::regclass,
        'google_ads_product_conversions'::regclass
      )
      -- Exactly the pre-campaign column set, in any order.
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM unnest(c.conkey) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) IN (
        ARRAY['date', 'feed_id', 'item_id'],
        ARRAY['conversion_action', 'date', 'feed_id', 'item_id']
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', con.tbl, con.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_ads_product_daily_grain_key'
  ) THEN
    ALTER TABLE google_ads_product_daily
      ADD CONSTRAINT google_ads_product_daily_grain_key
      UNIQUE (feed_id, date, item_id, campaign_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_ads_product_conversions_grain_key'
  ) THEN
    ALTER TABLE google_ads_product_conversions
      ADD CONSTRAINT google_ads_product_conversions_grain_key
      UNIQUE (feed_id, date, item_id, campaign_id, conversion_action);
  END IF;
END $$;

-- Campaign-first, because the campaign view filters on it before anything else.
CREATE INDEX IF NOT EXISTS idx_google_ads_product_daily_feed_campaign
  ON google_ads_product_daily(feed_id, campaign_id, date);

-- ── 2. google_ads_campaigns — the dimension ────────────────────────────────
-- Names and types are attributes of the campaign, not of a day, so they are
-- stored ONCE rather than denormalised onto every fact row. A campaign can be
-- renamed; the latest name wins, and the id is what everything joins on.

CREATE TABLE IF NOT EXISTS google_ads_campaigns (
  feed_id       uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  campaign_id   text        NOT NULL,
  name          text,
  -- advertising_channel_type: SHOPPING, PERFORMANCE_MAX, SEARCH, …
  -- This is what makes the coverage gap below explicable rather than merely
  -- visible: a PMax campaign spends on placements that carry no product at all.
  channel_type  text,
  status        text,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_id, campaign_id)
);

ALTER TABLE google_ads_campaigns DISABLE ROW LEVEL SECURITY;

-- ── 3. google_ads_campaign_daily — the campaign's OWN totals ───────────────
-- Not a duplicate of google_ads_product_daily, and the difference is the point.
--
-- google_ads_product_daily comes from shopping_performance_view, which only
-- ever reports spend Google could attribute to a Merchant Center offer. This
-- table comes from the `campaign` resource: the campaign's REAL cost, all
-- placements included.
--
-- The gap between them is the number the waste report has been carrying as a
-- disclaimer since it was written ("PMax spend on non-shopping placements is
-- not counted, so these figures are lower than the account's total cost").
-- Storing both turns that sentence into a measured coverage figure.
--
-- Conversions here are the ACCOUNT DEFAULT (primary goals), same caveat as
-- google_ads_product_daily.conversions: kept for reconciling against the
-- Google Ads UI, never used for ROAS or POAS, which are always defined by the
-- chosen actions.

CREATE TABLE IF NOT EXISTS google_ads_campaign_daily (
  feed_id           uuid           NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  date              date           NOT NULL,
  campaign_id       text           NOT NULL,
  impressions       bigint         NOT NULL DEFAULT 0,
  clicks            bigint         NOT NULL DEFAULT 0,
  cost_micros       bigint         NOT NULL DEFAULT 0,
  conversions       numeric(18, 4) NOT NULL DEFAULT 0,
  conversions_value numeric(18, 4) NOT NULL DEFAULT 0,
  synced_at         timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_id, date, campaign_id)
);

ALTER TABLE google_ads_campaign_daily DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_daily_feed_date
  ON google_ads_campaign_daily(feed_id, date);

-- ── 4. The summary functions, campaign-aware ───────────────────────────────
-- Signatures are unchanged and so is every column they return: a product total
-- is still the sum over every campaign that served it. The ONLY change is that
-- the conversion folds and their joins now carry campaign_id, restoring the
-- at-most-one-matching-row invariant that migration 037 established.
--
-- Verifying this after a re-sync: product totals must be IDENTICAL to what the
-- same window reported before, for any account with a single campaign, and the
-- per-campaign rows must sum to the product row for any account with several.

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
  WITH rc AS (
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_roas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
  ),
  pc AS (
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_poas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
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
                                   AND rc.campaign_id = d.campaign_id
  LEFT JOIN pc ON pc.date = d.date AND pc.item_id = d.item_id
                                   AND pc.campaign_id = d.campaign_id
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
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_roas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
  ),
  pc AS (
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_poas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
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
                                     AND rc.campaign_id = d.campaign_id
    LEFT JOIN pc ON pc.date = d.date AND pc.item_id = d.item_id
                                     AND pc.campaign_id = d.campaign_id
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

-- ── 5. Per-campaign roll-up ────────────────────────────────────────────────
-- Two costs, deliberately side by side.
--
--   cost              what Google attributed to products in this feed
--   total_cost        what the campaign actually spent, every placement
--
-- They are equal for a Shopping campaign and can differ by a lot for PMax.
-- Returning both is what stops a campaign page quoting a confident ROAS
-- computed against a third of the real spend. A NULL total_cost means the
-- campaign resource has not been synced for these dates yet, which is not the
-- same as a total of zero.

CREATE OR REPLACE FUNCTION google_ads_campaign_summary(
  p_feed_id      uuid,
  p_from         date,
  p_to           date,
  p_roas_actions text[] DEFAULT NULL,
  p_poas_actions text[] DEFAULT NULL
)
RETURNS TABLE (
  campaign_id       text,
  name              text,
  channel_type      text,
  status            text,
  products          bigint,
  items             bigint,
  impressions       bigint,
  clicks            bigint,
  cost              numeric,
  conversions       numeric,
  conversions_value numeric,
  roas_conversions  numeric,
  roas_value        numeric,
  poas_conversions  numeric,
  poas_value        numeric,
  total_impressions bigint,
  total_clicks      bigint,
  total_cost        numeric,
  total_conversions numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH rc AS (
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_roas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
  ),
  pc AS (
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_poas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
  ),
  attributed AS (
    SELECT
      d.campaign_id,
      count(DISTINCT d.product_ref)           AS products,
      count(DISTINCT d.item_id)               AS items,
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
                                     AND rc.campaign_id = d.campaign_id
    LEFT JOIN pc ON pc.date = d.date AND pc.item_id = d.item_id
                                     AND pc.campaign_id = d.campaign_id
    WHERE d.feed_id = p_feed_id
      AND d.date BETWEEN p_from AND p_to
    GROUP BY d.campaign_id
  ),
  totals AS (
    SELECT
      cd.campaign_id,
      sum(cd.impressions)::bigint              AS impressions,
      sum(cd.clicks)::bigint                   AS clicks,
      (sum(cd.cost_micros)::numeric / 1000000) AS cost,
      sum(cd.conversions)                      AS conversions
    FROM google_ads_campaign_daily cd
    WHERE cd.feed_id = p_feed_id
      AND cd.date BETWEEN p_from AND p_to
    GROUP BY cd.campaign_id
  )
  -- FULL OUTER: a campaign can have real spend with nothing attributed to a
  -- product (pure PMax placements), and a sentinel-campaign row exists in the
  -- attributed side with no campaign resource behind it. Both must survive.
  SELECT
    COALESCE(a.campaign_id, t.campaign_id)   AS campaign_id,
    c.name,
    c.channel_type,
    c.status,
    COALESCE(a.products, 0)                  AS products,
    COALESCE(a.items, 0)                     AS items,
    COALESCE(a.impressions, 0)               AS impressions,
    COALESCE(a.clicks, 0)                    AS clicks,
    COALESCE(a.cost, 0)                      AS cost,
    COALESCE(a.conversions, 0)               AS conversions,
    COALESCE(a.conversions_value, 0)         AS conversions_value,
    COALESCE(a.roas_conversions, 0)          AS roas_conversions,
    COALESCE(a.roas_value, 0)                AS roas_value,
    COALESCE(a.poas_conversions, 0)          AS poas_conversions,
    COALESCE(a.poas_value, 0)                AS poas_value,
    -- NOT coalesced to zero: absent campaign totals mean "not synced", and a
    -- coverage bar computed against a fabricated zero would read as 100%.
    t.impressions                            AS total_impressions,
    t.clicks                                 AS total_clicks,
    t.cost                                   AS total_cost,
    t.conversions                            AS total_conversions
  FROM attributed a
  FULL OUTER JOIN totals t ON t.campaign_id = a.campaign_id
  LEFT JOIN google_ads_campaigns c
         ON c.feed_id = p_feed_id
        AND c.campaign_id = COALESCE(a.campaign_id, t.campaign_id)
$$;

-- ── 6. Which campaigns serve a product ─────────────────────────────────────
-- The cannibalisation view: one row per (product, campaign). With p_product_ref
-- NULL this is the whole feed, which is how the campaign count per product is
-- computed without a query per row.

CREATE OR REPLACE FUNCTION google_ads_product_campaigns(
  p_feed_id      uuid,
  p_from         date,
  p_to           date,
  p_product_ref  text   DEFAULT NULL,
  p_roas_actions text[] DEFAULT NULL,
  p_poas_actions text[] DEFAULT NULL
)
RETURNS TABLE (
  product_ref       text,
  campaign_id       text,
  name              text,
  channel_type      text,
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
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_roas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
  ),
  pc AS (
    SELECT c.date, c.item_id, c.campaign_id,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_poas_actions, ARRAY[]::text[]))
    GROUP BY c.date, c.item_id, c.campaign_id
  ),
  agg AS (
    SELECT
      d.product_ref,
      d.campaign_id,
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
                                     AND rc.campaign_id = d.campaign_id
    LEFT JOIN pc ON pc.date = d.date AND pc.item_id = d.item_id
                                     AND pc.campaign_id = d.campaign_id
    WHERE d.feed_id = p_feed_id
      AND d.date BETWEEN p_from AND p_to
      AND (p_product_ref IS NULL OR d.product_ref = p_product_ref)
    GROUP BY d.product_ref, d.campaign_id
  )
  SELECT
    a.product_ref,
    a.campaign_id,
    c.name,
    c.channel_type,
    a.impressions, a.clicks, a.cost,
    a.conversions, a.conversions_value,
    a.roas_conversions, a.roas_value,
    a.poas_conversions, a.poas_value
  FROM agg a
  LEFT JOIN google_ads_campaigns c
         ON c.feed_id = p_feed_id
        AND c.campaign_id = a.campaign_id
$$;

-- ── 7. Daily totals — the time dimension ───────────────────────────────────
-- One row per day in the range, for the trend chart and for spotting the day
-- something changed.
--
-- The conversion folds here are aggregated to DATE independently and joined on
-- date alone, so the fan-out hazard cannot arise: both sides are already one
-- row per day before they meet.
--
-- Days with no data are NOT synthesised. A gap in this series is a real fact
-- about the account (or about the sync), and filling it with zeroes would draw
-- a confident line through a hole. The caller decides how to render absence.

CREATE OR REPLACE FUNCTION google_ads_daily_totals(
  p_feed_id      uuid,
  p_from         date,
  p_to           date,
  p_roas_actions text[] DEFAULT NULL,
  p_poas_actions text[] DEFAULT NULL
)
RETURNS TABLE (
  date              date,
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
  WITH d AS (
    SELECT
      x.date,
      sum(x.impressions)::bigint              AS impressions,
      sum(x.clicks)::bigint                   AS clicks,
      (sum(x.cost_micros)::numeric / 1000000) AS cost,
      sum(x.conversions)                      AS conversions,
      sum(x.conversions_value)                AS conversions_value
    FROM google_ads_product_daily x
    WHERE x.feed_id = p_feed_id
      AND x.date BETWEEN p_from AND p_to
    GROUP BY x.date
  ),
  rc AS (
    SELECT c.date,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_roas_actions, ARRAY[]::text[]))
    GROUP BY c.date
  ),
  pc AS (
    SELECT c.date,
           sum(c.conversions)       AS conversions,
           sum(c.conversions_value) AS conversions_value
    FROM google_ads_product_conversions c
    WHERE c.feed_id = p_feed_id
      AND c.date BETWEEN p_from AND p_to
      AND c.conversion_action = ANY(COALESCE(p_poas_actions, ARRAY[]::text[]))
    GROUP BY c.date
  )
  SELECT
    d.date,
    d.impressions,
    d.clicks,
    d.cost,
    d.conversions,
    d.conversions_value,
    COALESCE(rc.conversions, 0)       AS roas_conversions,
    COALESCE(rc.conversions_value, 0) AS roas_value,
    COALESCE(pc.conversions, 0)       AS poas_conversions,
    COALESCE(pc.conversions_value, 0) AS poas_value
  FROM d
  LEFT JOIN rc ON rc.date = d.date
  LEFT JOIN pc ON pc.date = d.date
  ORDER BY d.date
$$;

-- ── 8. How far back the data actually goes ─────────────────────────────────
-- A comparison against "the previous 30 days" is a lie if only 40 days have
-- ever been synced: the earlier window is partly empty, so every metric looks
-- like it grew. The UI needs to be able to say so, and that requires knowing
-- the real extent of the archive rather than assuming sync_window_days was
-- always in force.

CREATE OR REPLACE FUNCTION google_ads_synced_range(p_feed_id uuid)
RETURNS TABLE (first_date date, last_date date, days bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    min(d.date) AS first_date,
    max(d.date) AS last_date,
    count(DISTINCT d.date) AS days
  FROM google_ads_product_daily d
  WHERE d.feed_id = p_feed_id
$$;

COMMIT;
