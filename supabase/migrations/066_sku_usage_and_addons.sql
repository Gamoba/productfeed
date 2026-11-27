-- Extra-SKU billing and add-ons (docs/billing-data-model.md).
--
--   shop_sku_usage   one row per shop per day: how many SKUs its feeds
--                    carried that day. A SKU is an item that goes out in one
--                    of the shop's feeds — a product in a product-mode feed,
--                    a variant in a variant-mode one — counted once per shop
--                    however many feeds it appears in (decisions 17–21,
--                    settled 2026-11-27).
--   sku_charges      one row per account per calendar month: the month's peak,
--                    what was above the plan, and what was billed for it.
--   addons           the add-on catalogue, made by platform admins: price per
--                    interval, optional quantity, and the limits it raises.
--   addon_prices     Stripe price ids per interval and mode, as plan_prices.
--   account_addons   which add-ons an account has, and the Stripe subscription
--                    item that bills each one (null = granted free by an admin).
--
--   shop_sku_usage_count(jsonb)
--                    counts a shop's SKUs in the database, so the daily job
--                    never reads the variants JSON over the wire. The spec is
--                    one entry per feed: {"feed_id": …, "mode": …, "ids":
--                    null} counts every active product of that feed, and a
--                    list of ids counts only those (the feed's include/exclude
--                    rules are evaluated in the app, as everywhere else).
--
-- Replaces the draft's feed_sku_usage: the count is per shop now, because the
-- same item in three feeds of the same shop is one SKU.
--
-- Every table has RLS on and no policies: service role only, as migrations
-- 061 and 063. Additive and idempotent. Nothing touches Shopify.
-- Rollback: supabase/rollback/rollback_066.sql

BEGIN;

-- ── 1. Daily SKU usage per shop ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shop_sku_usage (
  project_id     uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  measured_on    date        NOT NULL,
  -- The account owning the shop that day, so a shop moving between accounts
  -- doesn't change past figures.
  account_id     uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sku_count      integer     NOT NULL CHECK (sku_count >= 0),
  product_count  integer     NOT NULL CHECK (product_count >= 0),
  feed_count     integer     NOT NULL DEFAULT 0 CHECK (feed_count >= 0),
  measured_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, measured_on)
);

CREATE INDEX IF NOT EXISTS idx_shop_sku_usage_account ON shop_sku_usage(account_id, measured_on);

ALTER TABLE shop_sku_usage ENABLE ROW LEVEL SECURITY;

-- ── 2. What was billed for extra SKUs ─────────────────────────────────────
-- status: 'charged' = billed, 'none' = nothing above the plan, 'skipped' =
-- couldn't bill (no Stripe customer, no price on the plan…), see note.

CREATE TABLE IF NOT EXISTS sku_charges (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id              uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_month            date        NOT NULL,
  plan_id                 text        REFERENCES plans(id) ON DELETE SET NULL,
  interval                text        NOT NULL CHECK (interval IN ('month', 'year')),
  peak_skus               integer     NOT NULL CHECK (peak_skus >= 0),
  included_skus           integer     NOT NULL CHECK (included_skus >= 0),
  extra_thousands         integer     NOT NULL CHECK (extra_thousands >= 0),
  rate_per_1000_cents     integer     NOT NULL CHECK (rate_per_1000_cents >= 0),
  amount_cents            integer     NOT NULL CHECK (amount_cents >= 0),
  currency                text        NOT NULL DEFAULT 'eur',
  stripe_invoice_item_id  text,
  stripe_invoice_id       text,
  status                  text        NOT NULL DEFAULT 'charged'
                                      CHECK (status IN ('charged', 'none', 'skipped')),
  note                    text,
  livemode                boolean     NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, period_month, livemode)
);

ALTER TABLE sku_charges ENABLE ROW LEVEL SECURITY;

-- ── 3. Add-ons ────────────────────────────────────────────────────────────
-- A delta of 0 raises nothing. Deltas are per unit of quantity, so an add-on
-- with feed_delta 5 and quantity 2 gives 10 feeds.

CREATE TABLE IF NOT EXISTS addons (
  id                text        PRIMARY KEY,
  name              text        NOT NULL,
  description       text,
  active            boolean     NOT NULL DEFAULT true,
  -- false: only a platform admin can put it on an account.
  self_serve        boolean     NOT NULL DEFAULT true,
  quantity_enabled  boolean     NOT NULL DEFAULT false,
  max_quantity      integer     CHECK (max_quantity IS NULL OR max_quantity > 0),
  feed_delta        integer     NOT NULL DEFAULT 0 CHECK (feed_delta >= 0),
  shop_delta        integer     NOT NULL DEFAULT 0 CHECK (shop_delta >= 0),
  user_delta        integer     NOT NULL DEFAULT 0 CHECK (user_delta >= 0),
  sku_delta         integer     NOT NULL DEFAULT 0 CHECK (sku_delta >= 0),
  sort_order        integer     NOT NULL DEFAULT 0,
  created_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE addons ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS addon_prices (
  addon_id         text        NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  interval         text        NOT NULL CHECK (interval IN ('month', 'year')),
  livemode         boolean     NOT NULL,
  amount_cents     integer     NOT NULL CHECK (amount_cents >= 0),
  currency         text        NOT NULL DEFAULT 'eur',
  stripe_price_id  text        UNIQUE,
  PRIMARY KEY (addon_id, interval, livemode)
);

ALTER TABLE addon_prices ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS account_addons (
  id                           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id                   uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  addon_id                     text        NOT NULL REFERENCES addons(id) ON DELETE RESTRICT,
  quantity                     integer     NOT NULL DEFAULT 1 CHECK (quantity > 0),
  interval                     text        CHECK (interval IS NULL OR interval IN ('month', 'year')),
  status                       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  -- true: an admin gave it, with no Stripe item and nothing billed.
  free                         boolean     NOT NULL DEFAULT false,
  granted_by                   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  note                         text,
  stripe_subscription_id       text,
  stripe_subscription_item_id  text        UNIQUE,
  livemode                     boolean     NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  removed_at                   timestamptz,
  CONSTRAINT account_addons_free_has_no_item
    CHECK (NOT free OR stripe_subscription_item_id IS NULL)
);

-- One live row per account and add-on; removed ones are kept as history.
CREATE UNIQUE INDEX IF NOT EXISTS account_addons_one_active
  ON account_addons(account_id, addon_id, livemode) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_account_addons_account
  ON account_addons(account_id, livemode) WHERE status = 'active';

ALTER TABLE account_addons ENABLE ROW LEVEL SECURITY;

-- ── 4. Counting a shop's SKUs in the database ─────────────────────────────
-- The variants JSON stays in Postgres: only two numbers come back.
--
-- A SKU is an item a feed sends out, so it depends on the feed's level
-- (feed_settings.feed_mode): a product-mode feed sends one item per product,
-- a variant-mode feed one per variant. Products are de-duplicated by
-- shopify_id, and a product in several of the shop's feeds counts as the most
-- any one of them sends out — so a shop never pays twice for the same product,
-- and pays for its variants only where a feed really lists them.
--
-- Each spec entry carries the feed's mode: {"feed_id": …, "mode": "variant",
-- "ids": null}. Anything but "variant" counts as product mode.
-- Called with the service role (RLS is on, no policies).

CREATE OR REPLACE FUNCTION public.shop_sku_usage_count(p_spec jsonb)
RETURNS TABLE (product_count bigint, sku_count bigint)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH spec AS (
    SELECT
      (e->>'feed_id')::uuid AS feed_id,
      coalesce(e->>'mode', 'product') AS mode,
      CASE
        WHEN e->'ids' IS NULL OR jsonb_typeof(e->'ids') <> 'array' THEN NULL
        ELSE ARRAY(SELECT jsonb_array_elements_text(e->'ids'))
      END AS ids
    FROM jsonb_array_elements(coalesce(p_spec, '[]'::jsonb)) e
  ), inc AS (
    SELECT p.shopify_id,
           max(
             CASE
               WHEN s.mode = 'variant' THEN jsonb_array_length(coalesce(p.variants, '[]'::jsonb))
               ELSE 1
             END
           ) AS items
    FROM public.products p
    JOIN spec s ON s.feed_id = p.feed_id
    WHERE p.status = 'active'
      AND (s.ids IS NULL OR p.shopify_id = ANY(s.ids))
    GROUP BY p.shopify_id
  )
  SELECT count(*)::bigint, coalesce(sum(items), 0)::bigint FROM inc;
$$;

COMMIT;
