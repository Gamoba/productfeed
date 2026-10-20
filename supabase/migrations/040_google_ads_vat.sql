-- VAT, so the catalogue margin stops mixing two price bases.
--
-- ── THE BUG THIS FIXES ─────────────────────────────────────────────────────
-- product_cost_summary (migration 038) computes (price − cost) / price, where
-- `price` is products.variants[].price — stored verbatim from Shopify — and
-- `cost` is inventoryItem.unitCost. On a Danish B2C store the first INCLUDES
-- moms and the second does not, so the margin is overstated by
--
--     0.2 × (1 − true margin)     at 25%
--
-- which is 8 points at a true 60% margin and 16 points at a true 20%. The
-- distortion is largest exactly where the decision is tightest, and it flows
-- into every cogs_margin rule in the custom-label engine.
--
-- ── WHY THE RATE IS ENTERED, NOT DETECTED ──────────────────────────────────
-- Shopify's shop.taxes_included says whether prices are gross; it does not say
-- by how much. The rate varies by market, and per-product tax overrides can
-- change it within one catalogue. A detected rate would be authoritative-looking
-- and sometimes wrong, which is worse than an empty field. A feed already maps
-- to one market, so the rate belongs on the feed.
--
-- ── NULL MEANS UNANSWERED ──────────────────────────────────────────────────
-- prices_include_vat is a NULLABLE boolean on purpose. NULL is "nobody has told
-- us", which is different from FALSE, "prices are already net". Only NULL makes
-- the UI say the basis is unverified; FALSE is a complete, correct answer that
-- needs no rate at all. Same rule as unit_cost in migration 038 and as every
-- ratio in this schema: absence is not a value.
--
-- Read-only towards Shopify. Idempotent: IF NOT EXISTS / DROP … ADD.

BEGIN;

ALTER TABLE google_ads_feed_settings
  -- NULL = unanswered · TRUE = prices carry VAT · FALSE = prices are already net
  ADD COLUMN IF NOT EXISTS prices_include_vat boolean,
  -- Percent, not a fraction: 25 rather than 0.25. It is typed by a human and
  -- read back by one, and "25" is what a Danish merchant would say out loud.
  ADD COLUMN IF NOT EXISTS vat_rate numeric(5, 2);

-- 0 is allowed — some catalogues genuinely sell at 0% — but 100 is not, since
-- netting by (1 + rate/100) would still be finite while meaning nothing.
ALTER TABLE google_ads_feed_settings
  DROP CONSTRAINT IF EXISTS google_ads_feed_settings_vat_rate_chk;
ALTER TABLE google_ads_feed_settings
  ADD CONSTRAINT google_ads_feed_settings_vat_rate_chk
  CHECK (vat_rate IS NULL OR (vat_rate >= 0 AND vat_rate < 100));

COMMIT;

-- ── Feed output is untouched ───────────────────────────────────────────────
-- lib/feedGenerator.ts does not read google_ads_feed_settings at all. Prices in
-- the generated feed still come straight from Shopify, on whatever basis the
-- store stores them, exactly as before.
