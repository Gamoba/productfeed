-- Feeds become market × channel.
--
-- Until now every feed was a Google Shopping feed, one per market. A feed now
-- also says which channel it is for. The market stays where it already is:
-- shop_settings (one row per feed: Shopify market, country, locale, currency).
--
--   google_shopping | meta_catalog | daisycon | microsoft_ads
--
-- The list of channels and which countries each one may be used in live in
-- lib/channels.ts; the CHECK below must list the same ids.
--
-- Every existing feed is a Google Shopping feed, so the default backfills them
-- correctly.
--
-- Idempotent: safe to replay via scripts/migrate.ts.

BEGIN;

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'google_shopping';

ALTER TABLE feeds DROP CONSTRAINT IF EXISTS feeds_channel_check;
ALTER TABLE feeds ADD CONSTRAINT feeds_channel_check
  CHECK (channel IN ('google_shopping', 'meta_catalog', 'daisycon', 'microsoft_ads'));

COMMIT;
