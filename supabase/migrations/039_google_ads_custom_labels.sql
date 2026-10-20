-- Custom labels become the top-level object; buckets become their values.
--
-- ── WHAT WAS WRONG WITH 035 ────────────────────────────────────────────────
-- Migration 035 modelled a bucket as a thing that OPTIONALLY carries a custom
-- label: every bucket held its own custom_label_index, and one global
-- first-match-wins ordering gave each product exactly one bucket for the whole
-- feed. That is backwards, and the schema said so in two places:
--
--   UNIQUE (feed_id, ref)                              -- one label per product
--   UNIQUE INDEX ... (feed_id) WHERE is_fallback       -- one catch-all per feed
--
-- Google Shopping has FIVE independent custom label slots, each holding one
-- string per offer. A product is legitimately "high" on custom_label_1 and
-- "thin margin" on custom_label_2 at the same time. Under 035 those two
-- statements had to fight over the same product, and the slot number was a
-- free-for-all: nothing stopped two buckets in one ordering writing different
-- slots, or the same slot twice.
--
-- So the custom label is the DIMENSION and buckets are its mutually exclusive
-- VALUES. First match still wins — but within a label, not across the feed.
--
-- ── CLEAN REBUILD, NOT A CONVERSION ────────────────────────────────────────
-- The old tables are dropped rather than migrated. Every bucket in them is a
-- test bucket (confirmed with the operator), and the two shapes differ by more
-- than a column: an honest conversion would have to invent a parent label for
-- every distinct custom_label_index, and a home for the buckets that never had
-- one. Rebuilding states the new model plainly instead of leaving the old one
-- half-visible in the data.
--
-- NOTHING HERE REACHES THE FEED. emit_to_feed defaults false, it now lives on
-- the label because publishing a dimension is one decision rather than one per
-- value, and lib/feedGenerator.ts still reads none of these tables.
--
-- Read-only towards Shopify. Idempotent: IF [NOT] EXISTS / CREATE OR REPLACE.

BEGIN;

-- ── 1. Out with the old ────────────────────────────────────────────────────
-- Members first: it references buckets.

DROP TABLE IF EXISTS google_ads_bucket_members;
DROP TABLE IF EXISTS google_ads_buckets;
DROP FUNCTION IF EXISTS google_ads_replace_bucket_members(uuid, text, jsonb, timestamptz);

-- The set-level settings move onto the label, where they can differ per
-- dimension. Keeping them on the feed would force "performance over 30 days"
-- and "seasonality over 365 days" to share one window, which makes one of them
-- wrong by construction.
ALTER TABLE google_ads_feed_settings
  DROP COLUMN IF EXISTS bucket_level,
  DROP COLUMN IF EXISTS bucket_window_days,
  DROP COLUMN IF EXISTS buckets_computed_at;

-- ── 2. Custom labels ───────────────────────────────────────────────────────
-- Named google_ads_custom_labels, not google_ads_labels: Google Ads has its own
-- unrelated "labels" on campaigns and ad groups, and this table is the Merchant
-- Center custom_label_0..4 concept.

CREATE TABLE IF NOT EXISTS google_ads_custom_labels (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id      uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  -- Human name for the dimension ("Performance"). The strings Google receives
  -- are the buckets' values, not this.
  name         text        NOT NULL,
  -- Which of the five slots this dimension owns. NULLABLE: a dimension can be
  -- drafted before deciding where it lives, and since nothing publishes yet the
  -- slot is documentation. The five-slot ceiling therefore limits PUBLISHED
  -- labels, not how many can be defined.
  slot         smallint,
  -- Per label, because a dimension chooses what it is measuring. Two labels on
  -- the same feed may legitimately disagree on both.
  level        text        NOT NULL DEFAULT 'product',
  window_days  integer     NOT NULL DEFAULT 30,
  -- Feed output gate, at the level where the decision is actually made. FALSE
  -- means computed and visible, never written to the generated feed.
  emit_to_feed boolean     NOT NULL DEFAULT false,
  description  text,
  -- Stamped by google_ads_replace_label_members, per label: recomputing one
  -- dimension says nothing about how fresh the others are.
  computed_at  timestamptz,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE (feed_id, name)
);

ALTER TABLE google_ads_custom_labels DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_custom_labels_feed
  ON google_ads_custom_labels(feed_id);

ALTER TABLE google_ads_custom_labels
  DROP CONSTRAINT IF EXISTS google_ads_custom_labels_slot_chk;
ALTER TABLE google_ads_custom_labels
  ADD CONSTRAINT google_ads_custom_labels_slot_chk
  CHECK (slot IS NULL OR slot BETWEEN 0 AND 4);

ALTER TABLE google_ads_custom_labels
  DROP CONSTRAINT IF EXISTS google_ads_custom_labels_level_chk;
ALTER TABLE google_ads_custom_labels
  ADD CONSTRAINT google_ads_custom_labels_level_chk
  CHECK (level IN ('product', 'variant'));

ALTER TABLE google_ads_custom_labels
  DROP CONSTRAINT IF EXISTS google_ads_custom_labels_window_chk;
ALTER TABLE google_ads_custom_labels
  ADD CONSTRAINT google_ads_custom_labels_window_chk
  CHECK (window_days BETWEEN 1 AND 730);

-- A slot holds one string per offer, so two dimensions cannot share one. The
-- partial index lets any number of unslotted drafts coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_custom_labels_one_per_slot
  ON google_ads_custom_labels(feed_id, slot) WHERE slot IS NOT NULL;

-- ── 3. Buckets — the values within one dimension ───────────────────────────

CREATE TABLE IF NOT EXISTS google_ads_buckets (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Denormalised from the label so ownership scoping and per-feed listing stay
  -- one query, as everywhere else in this schema.
  feed_id     uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  label_id    uuid        NOT NULL REFERENCES google_ads_custom_labels(id) ON DELETE CASCADE,
  -- Readable in the UI ("High performers — scale these").
  name        text        NOT NULL,
  -- What Google would actually receive ("high"). Kept apart from the name
  -- because Merchant Center values want to be terse and stable while the name
  -- wants to explain itself, and renaming the one must not silently relabel
  -- every product under the other.
  value       text        NOT NULL,
  -- Lower runs first, WITHIN THIS LABEL. First match wins, so the values read
  -- top to bottom as an if/else chain and a product gets exactly one of them.
  priority    integer     NOT NULL DEFAULT 100,
  match_type  text        NOT NULL DEFAULT 'ALL',
  -- [{ metric, operator, value, windowDays? }] — see lib/googleAdsBuckets.ts.
  rules       jsonb       NOT NULL DEFAULT '[]',
  -- The catch-all for this dimension. Optional per label: a product carrying no
  -- value for custom_label_2 is a normal outcome, not a gap to be filled.
  is_fallback boolean     NOT NULL DEFAULT false,
  description text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE (label_id, name)
);

ALTER TABLE google_ads_buckets DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_buckets_label
  ON google_ads_buckets(label_id, priority);
CREATE INDEX IF NOT EXISTS idx_google_ads_buckets_feed
  ON google_ads_buckets(feed_id);

ALTER TABLE google_ads_buckets
  DROP CONSTRAINT IF EXISTS google_ads_buckets_match_type_chk;
ALTER TABLE google_ads_buckets
  ADD CONSTRAINT google_ads_buckets_match_type_chk
  CHECK (match_type IN ('ALL', 'ANY'));

-- An empty emitted value would write custom_label_N = "" — indistinguishable in
-- Merchant Center from having no label at all.
ALTER TABLE google_ads_buckets
  DROP CONSTRAINT IF EXISTS google_ads_buckets_value_chk;
ALTER TABLE google_ads_buckets
  ADD CONSTRAINT google_ads_buckets_value_chk
  CHECK (value <> '');

-- Two catch-alls in one dimension would make assignment depend on the ordering
-- between them, which is the ambiguity a catch-all exists to remove. Scoped to
-- the label now, not the feed: every dimension may have its own.
CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_buckets_one_fallback
  ON google_ads_buckets(label_id) WHERE is_fallback;

-- NOTE: two buckets in one label MAY share a value. "Thin margin" and "Low
-- volume" both emitting "review" is a real setup, and Google has no rule
-- against it, so neither does this table.

-- ── 4. Membership ──────────────────────────────────────────────────────────
-- Derived, never curated: rewritten in full every time a label is recomputed.
--
-- `ref` is the product_ref at product level and the Merchant Center item_id at
-- variant level. `level` is per ROW because it is now per label — two labels on
-- one feed can measure different things.

CREATE TABLE IF NOT EXISTS google_ads_bucket_members (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id     uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  label_id    uuid        NOT NULL REFERENCES google_ads_custom_labels(id) ON DELETE CASCADE,
  bucket_id   uuid        NOT NULL REFERENCES google_ads_buckets(id) ON DELETE CASCADE,
  ref         text        NOT NULL,
  level       text        NOT NULL,
  -- Denormalised so membership can be listed and exported without re-running
  -- the aggregation that produced it.
  product_ref text,
  computed_at timestamptz DEFAULT now(),
  -- One value per dimension per entity — the whole point of the rework. The old
  -- UNIQUE (feed_id, ref) allowed one label per product for the entire feed.
  UNIQUE (feed_id, label_id, ref)
);

ALTER TABLE google_ads_bucket_members DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_bucket_members_label
  ON google_ads_bucket_members(label_id);
CREATE INDEX IF NOT EXISTS idx_google_ads_bucket_members_bucket
  ON google_ads_bucket_members(bucket_id);
-- Drives the verification table: every label a given product carries.
CREATE INDEX IF NOT EXISTS idx_google_ads_bucket_members_product
  ON google_ads_bucket_members(feed_id, product_ref);

ALTER TABLE google_ads_bucket_members
  DROP CONSTRAINT IF EXISTS google_ads_bucket_members_level_chk;
ALTER TABLE google_ads_bucket_members
  ADD CONSTRAINT google_ads_bucket_members_level_chk
  CHECK (level IN ('product', 'variant'));

-- ── 5. Atomic replacement, per label ───────────────────────────────────────
-- One label at a time, and that is deliberate. Labels are independent analyses:
-- if the second of five fails, the first is still whole and correctly stamped,
-- which is more useful than rolling all five back — and far better than the
-- half-written state a client-side delete-then-insert leaves behind (the reason
-- migration 036 existed at all).
--
-- Returns the number of rows written, which the caller reports instead of
-- trusting the length of the array it sent.

CREATE OR REPLACE FUNCTION google_ads_replace_label_members(
  p_feed_id     uuid,
  p_label_id    uuid,
  p_level       text,
  p_members     jsonb,
  p_computed_at timestamptz
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_inserted integer;
BEGIN
  IF p_level NOT IN ('product', 'variant') THEN
    RAISE EXCEPTION 'invalid bucket level: %', p_level;
  END IF;

  -- feed_id as well as label_id: a label id from another feed must not be able
  -- to clear this feed's membership.
  DELETE FROM google_ads_bucket_members
   WHERE feed_id = p_feed_id AND label_id = p_label_id;

  -- A bucket deleted between assignment and this call violates the foreign key,
  -- which aborts the function and restores the previous membership for this
  -- label. Better the old values than half the new ones.
  INSERT INTO google_ads_bucket_members
    (feed_id, label_id, bucket_id, ref, level, product_ref, computed_at)
  SELECT
    p_feed_id,
    p_label_id,
    (m ->> 'bucket_id')::uuid,
    m ->> 'ref',
    p_level,
    NULLIF(m ->> 'product_ref', ''),
    p_computed_at
  FROM jsonb_array_elements(COALESCE(p_members, '[]'::jsonb)) AS m;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Inside the same transaction, so the stamp cannot claim a recompute that did
  -- not fully land.
  UPDATE google_ads_custom_labels
     SET computed_at = p_computed_at,
         updated_at  = p_computed_at
   WHERE id = p_label_id AND feed_id = p_feed_id;

  RETURN v_inserted;
END;
$$;

COMMIT;

-- ── Feed output is still untouched ─────────────────────────────────────────
-- lib/feedGenerator.ts reads none of these tables. Generated feed XML is
-- byte-identical to before this migration, and stays that way until publishing
-- is deliberately built on top of google_ads_custom_labels.emit_to_feed.
