-- Per-variant cost of goods, read from Shopify's "Cost per item".
--
-- WHY A SEPARATE TABLE and not a field folded into products.variants: that jsonb
-- is the Shopify REST payload stored verbatim, and cost is not in it — it lives
-- on inventoryItem and only comes back over GraphQL. Merging the two would mean
-- products.variants was no longer "what Shopify returned", and would tie cost
-- refreshes to a full product sync. Cost changes on a different rhythm than the
-- catalogue, so it gets its own table and its own sync.
--
-- ── NULL IS NOT ZERO ───────────────────────────────────────────────────────
-- unit_cost is NULLABLE and stays that way to the UI. A merchant who has not
-- filled in cost has an UNKNOWN margin, not a 100% margin, and the difference
-- decides whether a product looks like the best or the worst thing in the
-- catalogue. Zero is also a legitimate entered value, so the two cannot share a
-- representation. Same rule as lib/googleAdsBuckets.ts.
--
-- Read-only towards Shopify: unitCost is reached with a GraphQL `query`.
-- Idempotent: IF [NOT] EXISTS / CREATE OR REPLACE.

BEGIN;

CREATE TABLE IF NOT EXISTS variant_costs (
  id          uuid           DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id     uuid           NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  -- Shopify ids as text, matching products.shopify_id and the variant ids inside
  -- products.variants, so joins need no casting.
  product_ref text           NOT NULL,
  variant_ref text           NOT NULL,
  unit_cost   numeric(18, 4),
  currency    text,
  synced_at   timestamptz    DEFAULT now(),
  UNIQUE (feed_id, variant_ref)
);

ALTER TABLE variant_costs DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_variant_costs_product
  ON variant_costs(feed_id, product_ref);

-- ── Product-level roll-up ──────────────────────────────────────────────────
-- Margin is deliberately NOT computed here. Ratios are derived in TypeScript
-- throughout this codebase (see migration 032) so that "no data" stays
-- distinguishable from "zero" — SQL would have to pick between NULL and 0, and 0
-- is the lie that would put every un-costed product in the wrong bucket.
--
-- The sums cover only variants where BOTH price and cost are known. That makes
-- the derived margin a price-weighted average across the priced, costed variants
-- rather than a naive mean, so a 2.000 kr variant does not count the same as a
-- 50 kr one. variants_total vs variants_costed is returned alongside so the UI
-- can say how much of the product the number actually covers.

CREATE OR REPLACE FUNCTION product_cost_summary(p_feed_id uuid)
RETURNS TABLE (
  product_ref     text,
  variants_total  bigint,
  variants_costed bigint,
  price_sum       numeric,
  cost_sum        numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH v AS (
    SELECT
      p.shopify_id AS product_ref,
      elem ->> 'id' AS variant_ref,
      NULLIF(elem ->> 'price', '')::numeric AS price
    FROM products p
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.variants, '[]'::jsonb)) AS elem
    WHERE p.feed_id = p_feed_id
  )
  SELECT
    v.product_ref,
    count(*)::bigint                                            AS variants_total,
    count(*) FILTER (
      WHERE c.unit_cost IS NOT NULL AND v.price IS NOT NULL
    )::bigint                                                   AS variants_costed,
    COALESCE(sum(v.price) FILTER (
      WHERE c.unit_cost IS NOT NULL AND v.price IS NOT NULL
    ), 0)                                                       AS price_sum,
    COALESCE(sum(c.unit_cost) FILTER (
      WHERE c.unit_cost IS NOT NULL AND v.price IS NOT NULL
    ), 0)                                                       AS cost_sum
  FROM v
  LEFT JOIN variant_costs c
         ON c.feed_id = p_feed_id
        AND c.variant_ref = v.variant_ref
  GROUP BY v.product_ref
$$;

COMMIT;
