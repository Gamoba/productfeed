-- Store a product's option DEFINITIONS ("Size", "Colour"), not just their values.
--
-- lib/sync.ts already receives this from Shopify — the REST product response
-- carries `options` and no field filter strips it — but it was discarded, and
-- lib/sync.ts:toShopifyData hardcoded `options: []`. So we have known the value
-- "Large" all along without knowing it means Size.
--
-- Needed by the Google Ads variant view and by variant-level buckets, which
-- otherwise can only render "Large · Black" with no idea what those words are.
--
-- Shape (Shopify REST): [{ id, name, position, values: [...] }]
--
-- Strictly additive. Verified before writing this migration:
--   · toShopifyData has exactly ONE caller (/api/products, the Products page)
--   · nothing anywhere reads ShopifyProduct.options
--   · 0 feed_mappings and 0 feed_filters reference a field named "options"
-- so no existing behaviour changes. Note that resolveField falls through to
-- product[field], meaning "options" becomes selectable as a source field after
-- this — additive, and unused today.
--
-- Existing rows default to '[]' and stay that way until the feed is re-synced.

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS options jsonb DEFAULT '[]'::jsonb;

COMMIT;
