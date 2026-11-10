-- Projects can take their products from an external feed URL instead of Shopify.
--
-- Some clients (e.g. sites on Umbraco) give us no backend access — only a public
-- product feed URL (typically Google Shopping RSS/XML). A project now has a
-- source_type: 'shopify' (the existing behaviour, credentials in the encrypted
-- token columns) or 'feed_url' (we GET the URL on sync and parse its items into
-- the same products / product_metafields rows, so mappings, filters, AI titles
-- and buckets work unchanged).
--
-- products.link stores a product's full storefront URL when the source provides
-- one. Shopify products leave it NULL and keep building links from
-- market_url/primary_domain + /products/<handle>; feed-URL products carry the
-- source feed's own <link>, since their URL scheme is not Shopify's.
--
-- Idempotent: IF NOT EXISTS / constraint lookup so migrate.ts can replay it.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'shopify';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_source_type_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_source_type_check
      CHECK (source_type IN ('shopify', 'feed_url'));
  END IF;
END $$;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS feed_url text;

COMMENT ON COLUMN projects.source_type IS
  'Where products come from: shopify (Admin API, encrypted token) or feed_url (public product feed at projects.feed_url).';
COMMENT ON COLUMN projects.feed_url IS
  'Source product feed URL (Google Shopping XML) for source_type = feed_url.';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS link text;

COMMENT ON COLUMN products.link IS
  'Full product URL from the source when it provides one (feed_url projects). NULL for Shopify products, whose links are built from the market URL + handle.';

COMMIT;
