-- Stock, as something the ads numbers can be read against.
--
-- Three independent pieces, one migration:
--
--   projects.shopify_locations   which locations a shop stocks from. DETECTED,
--                                never entered. Today it only lets the UI say
--                                "this quantity is the total across 3 places";
--                                it is also the picker data if per-location
--                                stock is ever built.
--   variant_stock_snapshots      what stock WAS, recorded on change. Nothing
--                                reads it yet — see the note below on why it
--                                exists anyway.
--   shopify_velocity_…           units leaving the shelf per variant, so
--                                "days of stock" can exist at all.
--
-- ── WHY A SNAPSHOT TABLE NOTHING READS ─────────────────────────────────────
-- Live stock answers "is this sellable right now", which is the useful
-- question and the only one being built today. It cannot answer "how much did
-- we spend WHILE it was unsellable", because that needs stock as it was on the
-- day the click happened. Every day this table is not collecting is a day that
-- question can never be asked about. It is small, it is written by a sync that
-- is already running, and starting it late costs history that cannot be
-- recovered — so it starts now and gets read later.
--
-- ── OBSERVED, NOT DAILY ────────────────────────────────────────────────────
-- Product sync is manual today (there is no cron in this repo). A row-per-day
-- table would therefore have holes, and every reader would have to guess
-- whether a missing day meant "no change" or "nobody synced". So the grain is
-- one row per OBSERVED CHANGE, carrying the moment it was observed. Gaps stay
-- visible as gaps, exactly as google_ads_daily_totals refuses to synthesise
-- days it never saw. When syncing becomes scheduled the rows simply get
-- denser; no migration is needed for that.
--
-- Read-only towards Shopify: locations are reached with a GraphQL `query`.
-- Idempotent: IF [NOT] EXISTS / CREATE OR REPLACE throughout.

BEGIN;

-- ── 1. Where a shop stocks from ────────────────────────────────────────────
-- On projects, not on shop_settings. A project IS one Shopify shop, and
-- locations are a property of the shop; shop_settings is per-FEED (migration
-- 010), so two feeds on one project would each hold their own copy and
-- whichever synced last would be the one that looked current.
--
-- The full list rather than a count: the count is derivable, and a later
-- per-location feature would otherwise have to re-fetch what was already here.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS shopify_locations   jsonb,
  ADD COLUMN IF NOT EXISTS locations_synced_at timestamptz;

COMMENT ON COLUMN projects.shopify_locations IS
  'Detected from Shopify: [{id, name, active, shipsInventory}]. NULL = never looked, '
  'which is not the same as "one location". Used to tell the operator when a variant '
  'quantity is a total across several places and therefore not per-market.';

-- ── 2. Stock as it was ─────────────────────────────────────────────────────
-- Feed-scoped, matching variant_costs. Stock is shop-wide TODAY, so this
-- duplicates across feeds on one project — accepted for the same reason 038
-- accepted it for cost, and it stops being duplication the moment stock is
-- resolved per market.

CREATE TABLE IF NOT EXISTS variant_stock_snapshots (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id     uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  product_ref text        NOT NULL,
  variant_ref text        NOT NULL,
  -- When this state was SEEN, not when it began. With manual syncing the two
  -- can be days apart, and pretending otherwise would invent precision.
  observed_at timestamptz NOT NULL,
  -- NULL when Shopify is not tracking this variant. Not 0 — an untracked
  -- variant is infinitely sellable, which is the opposite of out of stock.
  quantity    integer,
  tracked     boolean     NOT NULL,
  -- 'deny' | 'continue'. Under 'continue' the shop oversells, so hitting zero
  -- does not stop sales and stock is not a spend risk at all.
  policy      text,
  UNIQUE (feed_id, variant_ref, observed_at)
);

ALTER TABLE variant_stock_snapshots DISABLE ROW LEVEL SECURITY;

-- "What was this variant's stock at time T" — the only shape this table is
-- ever queried in. DESC so the latest row is the first one found.
CREATE INDEX IF NOT EXISTS idx_variant_stock_snapshots_variant
  ON variant_stock_snapshots(feed_id, variant_ref, observed_at DESC);

-- ── 3. Recording a snapshot, changes only ──────────────────────────────────
-- Server-side so the caller never has to pull the entire previous state into
-- memory to diff it. Returns how many rows were actually written, which is
-- what the sync reports rather than trusting the size of what it sent.
--
-- IS DISTINCT FROM, not <>: quantity is nullable, and `NULL <> NULL` is NULL,
-- which would make an untracked variant look unchanged forever — or, worse,
-- look changed on every sync depending on which side the NULL landed.

CREATE OR REPLACE FUNCTION record_variant_stock(
  p_feed_id     uuid,
  p_observed_at timestamptz,
  p_rows        jsonb
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted integer;
BEGIN
  WITH incoming AS (
    SELECT
      r ->> 'product_ref'                      AS product_ref,
      r ->> 'variant_ref'                      AS variant_ref,
      NULLIF(r ->> 'quantity', '')::integer    AS quantity,
      COALESCE((r ->> 'tracked')::boolean, false) AS tracked,
      NULLIF(r ->> 'policy', '')               AS policy
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS r
    WHERE COALESCE(r ->> 'variant_ref', '') <> ''
  ),
  latest AS (
    SELECT DISTINCT ON (s.variant_ref)
           s.variant_ref, s.quantity, s.tracked, s.policy
    FROM variant_stock_snapshots s
    WHERE s.feed_id = p_feed_id
    ORDER BY s.variant_ref, s.observed_at DESC
  ),
  changed AS (
    SELECT i.*
    FROM incoming i
    LEFT JOIN latest l ON l.variant_ref = i.variant_ref
    WHERE l.variant_ref IS NULL
       OR l.quantity IS DISTINCT FROM i.quantity
       OR l.tracked  IS DISTINCT FROM i.tracked
       OR l.policy   IS DISTINCT FROM i.policy
  )
  INSERT INTO variant_stock_snapshots
    (feed_id, product_ref, variant_ref, observed_at, quantity, tracked, policy)
  SELECT p_feed_id, c.product_ref, c.variant_ref, p_observed_at, c.quantity, c.tracked, c.policy
  FROM changed c
  -- Two syncs in the same instant would collide on the unique key. The second
  -- one has nothing new to say, so it is dropped rather than raised.
  ON CONFLICT (feed_id, variant_ref, observed_at) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

-- ── 4. How fast stock leaves ───────────────────────────────────────────────
-- Units sold per variant over a window, from the order archive. Sibling of
-- shopify_returns_variant_summary and deliberately the same shape: same
-- eligibility rules, same variant grain, ratios derived in TypeScript.
--
-- ── p_country IS EXPECTED TO BE NULL, AND THAT IS NOT AN OVERSIGHT ─────────
-- The returns function is market-scoped because return behaviour is a property
-- of a market. Velocity is not, because the thing it will be divided into is
-- variants[].inventory_quantity — a total across every location, feeding every
-- market at once. A DK-only numerator over an all-markets denominator would
-- overstate days of stock by exactly the share of units sold elsewhere, and it
-- would do so silently.
--
-- Numerator and denominator on the same basis, the same rule migration 043
-- applied to VAT. The parameter exists so that per-market velocity is available
-- the day stock itself becomes per-market, and not before.
--
-- ── GROSS UNITS, NOT NET OF RETURNS ────────────────────────────────────────
-- A returned unit that is restocked goes back on the shelf, so in principle
-- depletion is net. It is left gross because restocking is neither immediate
-- nor certain, because inventory_quantity ALREADY reflects the restocks that
-- have happened, and because the error points the safe way: gross velocity
-- slightly overstates how fast stock runs out, so low stock is flagged early
-- rather than late. On a metric whose job is to stop wasted spend, early is
-- the direction to be wrong in.
--
-- ── DAYS ARE NOT RETURNED ──────────────────────────────────────────────────
-- Velocity is units ÷ ELAPSED days, not ÷ days-that-had-an-order: a variant
-- selling five units on three days of a thirty-day window moves 5/30 per day,
-- not 5/3. The caller knows the window length it asked for, so it divides —
-- and the ratio stays in TypeScript, where null and zero remain distinct.

DROP FUNCTION IF EXISTS shopify_velocity_variant_summary(uuid, text, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION shopify_velocity_variant_summary(
  p_project_id uuid,
  -- NULL means every market, which is what a shared-stock denominator needs.
  p_country    text,
  p_from       timestamptz,
  p_to         timestamptz
)
RETURNS TABLE (
  product_ref text,
  variant_ref text,
  units_sold  bigint,
  orders      bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH eligible AS (
    SELECT o.order_ref
    FROM shopify_orders o
    WHERE o.project_id = p_project_id
      -- Same exclusions as the returns function: a test order was never real
      -- and a cancelled one never shipped, so neither took stock off a shelf.
      AND o.test = false
      AND o.cancelled_at IS NULL
      AND (p_country IS NULL OR o.country_code = p_country)
      AND o.created_at >= p_from
      AND o.created_at <  p_to
  )
  SELECT
    li.product_ref,
    li.variant_ref,
    SUM(li.quantity)::bigint             AS units_sold,
    COUNT(DISTINCT li.order_ref)::bigint AS orders
  FROM shopify_order_line_items li
  JOIN eligible e ON e.order_ref = li.order_ref
  WHERE li.project_id = p_project_id
    AND li.product_ref IS NOT NULL
  GROUP BY li.product_ref, li.variant_ref
$$;

COMMIT;

-- ── Feed output is untouched ───────────────────────────────────────────────
-- No table or column added here is read by lib/feedGenerator.ts, and none of
-- the columns it DOES read has changed. Every read of `projects` in the
-- codebase names its columns explicitly (primary_domain in feedGenerator, the
-- four credential columns in projectShopify), so the two columns added above
-- are invisible to them. Generated feed XML is byte-identical to before this
-- migration, and `availability` still comes from variants[].inventory_quantity
-- exactly as it did.
