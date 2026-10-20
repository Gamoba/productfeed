-- Performance buckets: rule-based labelling of products (or variants) by how
-- they actually perform in Google Ads.
--
-- DELIBERATELY SEPARATE FROM optimization_buckets. That table is the AI-title
-- feature and has a different lifecycle: its membership is FROZEN and curated by
-- hand, and it emits custom_label_N from lib/feedGenerator.ts unconditionally.
-- Performance buckets are the opposite — membership is DERIVED and recomputed on
-- every sync — so sharing the table would have the two features fighting over
-- both membership (UNIQUE feed_id, product_ref) and label slots. There are 11
-- live AI-title buckets today, one already emitting custom_label_0.
--
-- NOTHING HERE REACHES THE FEED. emit_to_feed defaults false and no code in
-- lib/feedGenerator.ts reads these tables. Labels are computed and shown in the
-- UI; whether they are ever published is a separate, explicit decision.
--
-- Idempotent: IF [NOT] EXISTS / DROP IF EXISTS throughout.

BEGIN;

-- ── 1. Bucket-set settings, on the feed ────────────────────────────────────
-- The LEVEL belongs to the set, not to an individual bucket: mixing them would
-- let one product's variants land in contradictory buckets, leaving no single
-- answer to "what label does this product get".
--
-- The WINDOW is separate from whatever window someone is browsing on the page.
-- Bucket membership must not shift because a colleague clicked "7d".

ALTER TABLE google_ads_feed_settings
  ADD COLUMN IF NOT EXISTS bucket_level text NOT NULL DEFAULT 'product',
  ADD COLUMN IF NOT EXISTS bucket_window_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS buckets_computed_at timestamptz;

ALTER TABLE google_ads_feed_settings
  DROP CONSTRAINT IF EXISTS google_ads_feed_settings_bucket_level_chk;
ALTER TABLE google_ads_feed_settings
  ADD CONSTRAINT google_ads_feed_settings_bucket_level_chk
  CHECK (bucket_level IN ('product', 'variant'));

ALTER TABLE google_ads_feed_settings
  DROP CONSTRAINT IF EXISTS google_ads_feed_settings_bucket_window_chk;
ALTER TABLE google_ads_feed_settings
  ADD CONSTRAINT google_ads_feed_settings_bucket_window_chk
  CHECK (bucket_window_days BETWEEN 1 AND 730);

-- ── 2. Buckets ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS google_ads_buckets (
  id                 uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id            uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  name               text        NOT NULL,
  -- Lower runs first. Buckets are evaluated in order and the FIRST match wins,
  -- so a product is never in two buckets and the rules stay readable top to
  -- bottom ("if it's a zombie, stop; otherwise if it's a hero, stop; ...").
  priority           integer     NOT NULL DEFAULT 100,
  match_type         text        NOT NULL DEFAULT 'ALL',
  -- [{ metric, operator, value, windowDays? }] — see lib/googleAdsBuckets.ts.
  -- windowDays is stored per rule but defaults to the set-level window, so
  -- per-rule windows can be exposed later without a migration.
  rules              jsonb       NOT NULL DEFAULT '[]',
  -- The catch-all. Matches anything the ordered buckets did not, so "everything
  -- else" is an explicit, nameable bucket rather than an invisible remainder.
  is_fallback        boolean     NOT NULL DEFAULT false,
  -- Google Shopping custom label, if this bucket is ever published.
  custom_label_index smallint,
  custom_label_value text,
  -- Feed output gate. FALSE means computed and visible, but never written to the
  -- generated feed. Nothing flips this implicitly.
  emit_to_feed       boolean     NOT NULL DEFAULT false,
  description        text,
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now(),
  UNIQUE (feed_id, name)
);

ALTER TABLE google_ads_buckets DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_buckets_feed
  ON google_ads_buckets(feed_id, priority);

ALTER TABLE google_ads_buckets
  DROP CONSTRAINT IF EXISTS google_ads_buckets_match_type_chk;
ALTER TABLE google_ads_buckets
  ADD CONSTRAINT google_ads_buckets_match_type_chk
  CHECK (match_type IN ('ALL', 'ANY'));

-- Same rules as migration 027: index 0..4, and set together or not at all, so
-- "value present" is the single source of truth for "this bucket has a label".
ALTER TABLE google_ads_buckets
  DROP CONSTRAINT IF EXISTS google_ads_buckets_custom_label_index_chk;
ALTER TABLE google_ads_buckets
  ADD CONSTRAINT google_ads_buckets_custom_label_index_chk
  CHECK (custom_label_index IS NULL OR custom_label_index BETWEEN 0 AND 4);

ALTER TABLE google_ads_buckets
  DROP CONSTRAINT IF EXISTS google_ads_buckets_custom_label_pair_chk;
ALTER TABLE google_ads_buckets
  ADD CONSTRAINT google_ads_buckets_custom_label_pair_chk
  CHECK (
    (custom_label_index IS NULL AND (custom_label_value IS NULL OR custom_label_value = ''))
    OR (custom_label_index IS NOT NULL AND custom_label_value IS NOT NULL AND custom_label_value <> '')
  );

-- At most one fallback per feed — two catch-alls would make assignment depend on
-- ordering between them, which is exactly the ambiguity a fallback removes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_buckets_one_fallback
  ON google_ads_buckets(feed_id) WHERE is_fallback;

-- ── 3. Membership ──────────────────────────────────────────────────────────
-- Derived, not curated: every row is rewritten when buckets are recomputed.
--
-- `ref` is the product_ref at product level and the Merchant Center item_id at
-- variant level. One column rather than two nullable ones, because a row is only
-- ever one of the two and the level is a property of the whole set.

CREATE TABLE IF NOT EXISTS google_ads_bucket_members (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id     uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  bucket_id   uuid        NOT NULL REFERENCES google_ads_buckets(id) ON DELETE CASCADE,
  ref         text        NOT NULL,
  level       text        NOT NULL,
  -- Denormalised so the members table can be listed and exported without
  -- re-running the aggregation that produced it.
  product_ref text,
  computed_at timestamptz DEFAULT now(),
  -- One bucket per entity, whichever level the set is using.
  UNIQUE (feed_id, ref)
);

ALTER TABLE google_ads_bucket_members DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_bucket_members_bucket
  ON google_ads_bucket_members(bucket_id);
CREATE INDEX IF NOT EXISTS idx_google_ads_bucket_members_product
  ON google_ads_bucket_members(feed_id, product_ref);

ALTER TABLE google_ads_bucket_members
  DROP CONSTRAINT IF EXISTS google_ads_bucket_members_level_chk;
ALTER TABLE google_ads_bucket_members
  ADD CONSTRAINT google_ads_bucket_members_level_chk
  CHECK (level IN ('product', 'variant'));

COMMIT;

-- ── Feed output is still untouched ─────────────────────────────────────────
-- lib/feedGenerator.ts reads neither of these tables. Generated feed XML is
-- byte-identical to before this migration, and stays that way until publishing
-- is deliberately built on top of emit_to_feed.
