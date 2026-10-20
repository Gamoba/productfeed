-- Reading the order archive: one aggregate per variant, per market.
--
-- ── WHY ONE FUNCTION AND NOT TWO ───────────────────────────────────────────
-- Every surface needs this at two grains — a product row in the Google Ads
-- table, and a variant row in its drill-down. Two functions would be two
-- places for the same definition of "returned", and they would drift. This
-- returns the variant grain only; lib/returnsAnalytics.ts rolls it up to
-- products in TypeScript, the same way getProductPerformance already sums its
-- own totals. One definition, two views, no possibility of them disagreeing.
--
-- ── TWO DATE BASES, ON PURPOSE ─────────────────────────────────────────────
-- The function takes two independent ranges because the feature asks two
-- questions that cannot share one:
--
--   COHORT (p_cohort_*) — of the units SOLD in this range, how many came back?
--     Ranges over order created_at. The caller passes a range that ends far
--     enough in the past for returns to have landed, so the rate is not
--     computed from orders whose return window is still open. This is the
--     stable per-variant property that corrects ROAS.
--
--   WINDOW (p_window_*) — how much money went back out in this range?
--     Ranges over refund created_at, regardless of when the order was placed.
--     This is a cash fact about the period, and it is deliberately NOT used as
--     a rate: most of it belongs to orders placed before the window started.
--
-- Mixing them is the classic error here — a 7-day "return rate" computed from
-- refunds that belong to orders from six weeks ago.
--
-- ── WHAT IS EXCLUDED FROM THE DENOMINATOR ──────────────────────────────────
-- Test orders (real stores have them, and they would distort small catalogues)
-- and cancelled orders (never shipped, so never returned — counting them as
-- sales understates every rate).
--
-- ── PRESENTMENT FIRST ──────────────────────────────────────────────────────
-- Money falls back presentment → shop → nothing. A market-scoped feed pairs
-- with what the customer actually paid in that market; shop money is the
-- fallback for rows where Shopify reported no presentment amount. The fallback
-- is a currency mix in principle, which is why the caller also gets the row
-- counts needed to notice it.
--
-- Returns-driven and other refunds are summed SEPARATELY throughout. A
-- cancellation is not a return, and folding the two together is what makes a
-- return rate quietly wrong.

BEGIN;

DROP FUNCTION IF EXISTS shopify_returns_variant_summary(uuid, text, timestamptz, timestamptz, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION shopify_returns_variant_summary(
  p_project_id  uuid,
  -- NULL means every market. A feed passes its shop_settings.selected_country.
  p_country     text,
  p_cohort_from timestamptz,
  p_cohort_to   timestamptz,
  p_window_from timestamptz,
  p_window_to   timestamptz
)
RETURNS TABLE (
  product_ref                  text,
  variant_ref                  text,
  cohort_orders                bigint,
  cohort_units_sold            bigint,
  cohort_gross_value           numeric,
  cohort_units_returned        bigint,
  cohort_returned_value        numeric,
  cohort_other_refunded_value  numeric,
  window_units_returned        bigint,
  window_returned_value        numeric,
  window_other_refunded_value  numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH eligible AS (
    SELECT o.order_ref, o.created_at
    FROM shopify_orders o
    WHERE o.project_id = p_project_id
      AND o.test = false
      AND o.cancelled_at IS NULL
      AND (p_country IS NULL OR o.country_code = p_country)
  ),
  cohort AS (
    SELECT order_ref
    FROM eligible
    WHERE created_at >= p_cohort_from
      AND created_at <  p_cohort_to
  ),
  sold AS (
    SELECT
      li.product_ref,
      li.variant_ref,
      COUNT(DISTINCT li.order_ref)::bigint AS orders,
      SUM(li.quantity)::bigint             AS units,
      -- Unit price × quantity, less the line's discount. The same basis the
      -- refund subtotal uses, so the two are comparable.
      SUM(
        COALESCE(li.price_presentment, li.price_shop, 0) * li.quantity
        - COALESCE(li.total_discount_presentment, li.total_discount_shop, 0)
      )                                    AS gross
    FROM shopify_order_line_items li
    JOIN cohort c ON c.order_ref = li.order_ref
    WHERE li.project_id = p_project_id
      AND li.product_ref IS NOT NULL
    GROUP BY li.product_ref, li.variant_ref
  ),
  cohort_refunds AS (
    SELECT
      rli.product_ref,
      rli.variant_ref,
      SUM(CASE WHEN r.return_ref IS NOT NULL THEN rli.quantity ELSE 0 END)::bigint AS ret_units,
      SUM(CASE WHEN r.return_ref IS NOT NULL
               THEN COALESCE(rli.subtotal_presentment, rli.subtotal_shop, 0)
               ELSE 0 END)                                                          AS ret_value,
      SUM(CASE WHEN r.return_ref IS NULL
               THEN COALESCE(rli.subtotal_presentment, rli.subtotal_shop, 0)
               ELSE 0 END)                                                          AS other_value
    FROM shopify_refund_line_items rli
    JOIN shopify_refunds r
      ON r.project_id = rli.project_id
     AND r.refund_ref = rli.refund_ref
    JOIN cohort c ON c.order_ref = rli.order_ref
    WHERE rli.project_id = p_project_id
      AND rli.product_ref IS NOT NULL
    GROUP BY rli.product_ref, rli.variant_ref
  ),
  window_refunds AS (
    SELECT
      rli.product_ref,
      rli.variant_ref,
      SUM(CASE WHEN r.return_ref IS NOT NULL THEN rli.quantity ELSE 0 END)::bigint AS ret_units,
      SUM(CASE WHEN r.return_ref IS NOT NULL
               THEN COALESCE(rli.subtotal_presentment, rli.subtotal_shop, 0)
               ELSE 0 END)                                                          AS ret_value,
      SUM(CASE WHEN r.return_ref IS NULL
               THEN COALESCE(rli.subtotal_presentment, rli.subtotal_shop, 0)
               ELSE 0 END)                                                          AS other_value
    FROM shopify_refund_line_items rli
    JOIN shopify_refunds r
      ON r.project_id = rli.project_id
     AND r.refund_ref = rli.refund_ref
    -- Joined to eligible, NOT to cohort: this counts money leaving in the
    -- window whatever the order's age, which is the whole point of it.
    JOIN eligible e ON e.order_ref = rli.order_ref
    WHERE rli.project_id = p_project_id
      AND rli.product_ref IS NOT NULL
      AND r.created_at >= p_window_from
      AND r.created_at <  p_window_to
    GROUP BY rli.product_ref, rli.variant_ref
  ),
  -- A variant can appear in the refund sets without appearing in `sold`: its
  -- order was placed before the cohort started. Dropping those would hide real
  -- refunded money, so the key set is the union of all three.
  keys AS (
    SELECT product_ref, variant_ref FROM sold
    UNION
    SELECT product_ref, variant_ref FROM cohort_refunds
    UNION
    SELECT product_ref, variant_ref FROM window_refunds
  )
  SELECT
    k.product_ref,
    k.variant_ref,
    COALESCE(s.orders, 0)::bigint,
    COALESCE(s.units, 0)::bigint,
    COALESCE(s.gross, 0)::numeric,
    COALESCE(cr.ret_units, 0)::bigint,
    COALESCE(cr.ret_value, 0)::numeric,
    COALESCE(cr.other_value, 0)::numeric,
    COALESCE(wr.ret_units, 0)::bigint,
    COALESCE(wr.ret_value, 0)::numeric,
    COALESCE(wr.other_value, 0)::numeric
  FROM keys k
  LEFT JOIN sold s
    ON s.product_ref = k.product_ref
   AND s.variant_ref IS NOT DISTINCT FROM k.variant_ref
  LEFT JOIN cohort_refunds cr
    ON cr.product_ref = k.product_ref
   AND cr.variant_ref IS NOT DISTINCT FROM k.variant_ref
  LEFT JOIN window_refunds wr
    ON wr.product_ref = k.product_ref
   AND wr.variant_ref IS NOT DISTINCT FROM k.variant_ref;
$$;

COMMIT;

-- ── Zeroes here are real, nulls are added later ────────────────────────────
-- Every COALESCE above turns "no rows matched" into 0, which is correct for a
-- SUM: no refund rows genuinely means no money moved. It is NOT correct for a
-- RATE — three units sold and one returned is not a 33% return rate, it is an
-- unknown one. That judgement lives in lib/returnsAnalytics.ts, where the
-- minimum-sample rule can be stated once and applied to both grains.
