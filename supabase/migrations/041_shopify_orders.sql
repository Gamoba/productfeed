-- Orders, refunds and returns from Shopify, stored locally and permanently.
--
-- ── WHY THIS IS STORED AND NOT FETCHED ─────────────────────────────────────
-- Every other Shopify read in this codebase is a live fetch, because the
-- catalogue is always there to re-read. Orders are not. The app holds
-- `read_orders` but NOT `read_all_orders` — the scope is not offered on this
-- custom app — and Shopify makes only the last 60 days of orders visible under
-- that scope. An order that ages past 60 days is gone from the API for good.
--
-- So this table is not a cache. It is the archive, and it is the ONLY copy.
-- Two rules follow, and both are load-bearing:
--
--   1. The sync must never delete or truncate a stored order. A re-sync that
--      "starts clean" would destroy history that cannot be fetched again.
--      Every write in lib/shopifyOrders.ts is an upsert for this reason.
--
--   2. The sync must run more often than every 60 days, or a permanent hole
--      opens in the archive. A refund bumps the parent order's updated_at, so
--      an incremental sync on that watermark also picks up refunds landing on
--      orders synced earlier — but only while the order is still inside
--      Shopify's 60-day window.
--
-- The corollary shapes the column list: this schema stores MORE than today's
-- features read (return reasons, both money bases, restock types). Adding a
-- column later cannot backfill orders that have aged out, so anything
-- plausibly wanted later is captured on the first pass, while it still exists.
--
-- ── WHY PROJECT-SCOPED, NOT FEED-SCOPED ────────────────────────────────────
-- A Shopify connection belongs to a project (lib/projectShopify.ts); feeds are
-- market-scoped views onto that one catalogue. Orders arrive once per project
-- and are read per feed by filtering on country — the same country that a
-- feed already declares in shop_settings.selected_country, and the same one
-- embedded in a `shopify_<cc>_<product>_<variant>` item ID. Storing orders per
-- feed would re-fetch identical orders once per market and multiply the
-- archive by the number of feeds.
--
-- ── WHY BOTH MONEY BASES ───────────────────────────────────────────────────
-- Shopify reports money twice: shop money (the store's own currency) and
-- presentment money (what the customer actually paid, in their currency). A
-- market-scoped feed wants presentment — it is the number that pairs with that
-- market's ad spend. Reconciling a total against Shopify admin wants shop
-- money. Both are stored because neither derives from the other without an FX
-- rate we do not keep, and because of the archive rule above.
--
-- ── ABSENCE IS NOT ZERO ────────────────────────────────────────────────────
-- The house rule from migrations 038 and 040 holds here too. A refund line with
-- no return attached is not a return; a variant nobody has ordered does not
-- have a 0% return rate. Nullability below encodes the first, and
-- lib/returnsAnalytics.ts encodes the second.
--
-- Read-only towards Shopify: everything here is populated from GraphQL
-- queries. Idempotent: IF NOT EXISTS throughout.

BEGIN;

-- ── 1. Orders ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shopify_orders (
  -- Shopify's numeric order id, as text to match product_ref/variant_ref
  -- elsewhere in this schema and to avoid a bigint/text join.
  order_ref             text        NOT NULL,
  project_id            uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Human-facing order number ("#1234"), for reconciling against Shopify admin.
  name                  text,

  -- Shopify's own timestamps. created_at drives cohort maturity; updated_at is
  -- the sync watermark and moves when a refund lands.
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  processed_at          timestamptz,
  cancelled_at          timestamptz,

  -- The market key. Shipping country, falling back to billing, both of which
  -- can be absent on a digital order — hence nullable, and hence a feed's
  -- returns view must say how many orders it could not place in a market
  -- rather than silently dropping them.
  country_code          text,

  shop_currency         text,
  presentment_currency  text,

  total_price_shop          numeric(14, 2),
  total_price_presentment   numeric(14, 2),
  subtotal_price_shop       numeric(14, 2),
  subtotal_price_presentment numeric(14, 2),
  total_tax_shop            numeric(14, 2),
  total_tax_presentment     numeric(14, 2),
  total_discounts_shop      numeric(14, 2),
  total_discounts_presentment numeric(14, 2),

  -- Refunded totals as Shopify computes them. Kept alongside the per-line
  -- refund rows so a mismatch between the two is visible rather than assumed
  -- away: order-level refunds (shipping, goodwill) have no line items at all.
  total_refunded_shop        numeric(14, 2),
  total_refunded_presentment numeric(14, 2),

  financial_status      text,
  fulfillment_status    text,

  -- Test orders exist in real stores and would otherwise pollute return rates.
  test                  boolean     NOT NULL DEFAULT false,

  -- Ours, not Shopify's: when this row first entered the archive, and when it
  -- was last refreshed. first_seen_at is how we can tell an order that aged out
  -- of the API from one that never existed.
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  synced_at             timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (project_id, order_ref)
);

ALTER TABLE shopify_orders DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_project_created
  ON shopify_orders(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_project_country
  ON shopify_orders(project_id, country_code, created_at DESC);

-- ── 2. Order line items ────────────────────────────────────────────────────
-- The denominator. Units sold per variant is what a return rate divides by,
-- so this table exists even though no current feature reads a line item on
-- its own.

CREATE TABLE IF NOT EXISTS shopify_order_line_items (
  line_item_ref     text        NOT NULL,
  order_ref         text        NOT NULL,
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- The join to everything else. Null when the product has since been deleted
  -- from Shopify — the line item survives on the order, the reference does not.
  product_ref       text,
  variant_ref       text,
  sku               text,

  -- Denormalised titles: the product may be gone by the time anyone reads this,
  -- and "(deleted product)" is a worse answer than the name it was sold under.
  title             text,
  variant_title     text,

  quantity          integer     NOT NULL DEFAULT 0,

  price_shop            numeric(14, 2),
  price_presentment     numeric(14, 2),
  total_discount_shop        numeric(14, 2),
  total_discount_presentment numeric(14, 2),

  PRIMARY KEY (project_id, line_item_ref)
);

ALTER TABLE shopify_order_line_items DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_order
  ON shopify_order_line_items(project_id, order_ref);
CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_variant
  ON shopify_order_line_items(project_id, variant_ref);
CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_product
  ON shopify_order_line_items(project_id, product_ref);

-- ── 3. Refunds ─────────────────────────────────────────────────────────────
-- Money that went back out. NOT the same thing as a return: a cancelled order,
-- a goodwill gesture and a price match are all refunds with nothing shipped
-- back. return_ref is what separates them, and it is nullable precisely so the
-- two can be counted apart instead of being averaged into one misleading rate.

CREATE TABLE IF NOT EXISTS shopify_refunds (
  refund_ref    text        NOT NULL,
  order_ref     text        NOT NULL,
  project_id    uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  created_at    timestamptz NOT NULL,
  processed_at  timestamptz,

  -- NULL = this refund is not attached to a return. See above.
  return_ref    text,

  note          text,

  total_refunded_shop        numeric(14, 2),
  total_refunded_presentment numeric(14, 2),

  PRIMARY KEY (project_id, refund_ref)
);

ALTER TABLE shopify_refunds DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_shopify_refunds_order
  ON shopify_refunds(project_id, order_ref);
CREATE INDEX IF NOT EXISTS idx_shopify_refunds_created
  ON shopify_refunds(project_id, created_at DESC);

-- ── 4. Refund line items ───────────────────────────────────────────────────
-- Where the money attaches to a variant. This is the row that makes
-- variant-level return economics possible at all.

CREATE TABLE IF NOT EXISTS shopify_refund_line_items (
  refund_line_ref   text        NOT NULL,
  refund_ref        text        NOT NULL,
  order_ref         text        NOT NULL,
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  line_item_ref     text,
  product_ref       text,
  variant_ref       text,

  quantity          integer     NOT NULL DEFAULT 0,

  subtotal_shop           numeric(14, 2),
  subtotal_presentment    numeric(14, 2),
  total_tax_shop          numeric(14, 2),
  total_tax_presentment   numeric(14, 2),

  -- RETURN / CANCEL / LEGACY_RESTOCK / NO_RESTOCK. Whether the unit came back
  -- into stock is a different question from whether money went out, and
  -- "refunded but never restocked" is its own kind of loss.
  restock_type      text,

  PRIMARY KEY (project_id, refund_line_ref)
);

ALTER TABLE shopify_refund_line_items DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_shopify_refund_lines_refund
  ON shopify_refund_line_items(project_id, refund_ref);
CREATE INDEX IF NOT EXISTS idx_shopify_refund_lines_variant
  ON shopify_refund_line_items(project_id, variant_ref);
CREATE INDEX IF NOT EXISTS idx_shopify_refund_lines_product
  ON shopify_refund_line_items(project_id, product_ref);

-- ── 5. Returns ─────────────────────────────────────────────────────────────
-- The read_returns half. Nothing in the first release reads these two tables:
-- they exist now because return REASONS are the difference between "this
-- product is bad" and "this listing is lying", the archive rule means they
-- cannot be collected retroactively, and a return that is open — requested but
-- not yet refunded — is money already lost that no refund row reports yet.

CREATE TABLE IF NOT EXISTS shopify_returns (
  return_ref      text        NOT NULL,
  order_ref       text        NOT NULL,
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- OPEN / CLOSED / DECLINED / REQUESTED / CANCELED. An OPEN return is not yet
  -- a refund, so the two must never be summed together.
  status          text,
  name            text,

  created_at      timestamptz,
  closed_at       timestamptz,

  total_quantity  integer     NOT NULL DEFAULT 0,

  PRIMARY KEY (project_id, return_ref)
);

ALTER TABLE shopify_returns DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_shopify_returns_order
  ON shopify_returns(project_id, order_ref);

CREATE TABLE IF NOT EXISTS shopify_return_line_items (
  return_line_ref   text        NOT NULL,
  return_ref        text        NOT NULL,
  order_ref         text        NOT NULL,
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  line_item_ref     text,
  product_ref       text,
  variant_ref       text,

  quantity          integer     NOT NULL DEFAULT 0,

  -- SIZE_TOO_SMALL / SIZE_TOO_LARGE / NOT_AS_DESCRIBED / WRONG_ITEM /
  -- DEFECTIVE / UNWANTED / STYLE / COLOR / OTHER / UNKNOWN.
  return_reason     text,
  return_reason_note text,

  PRIMARY KEY (project_id, return_line_ref)
);

ALTER TABLE shopify_return_line_items DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_shopify_return_lines_return
  ON shopify_return_line_items(project_id, return_ref);
CREATE INDEX IF NOT EXISTS idx_shopify_return_lines_variant
  ON shopify_return_line_items(project_id, variant_ref);

-- ── 6. Sync state ──────────────────────────────────────────────────────────
-- One row per project. The watermark is what makes the sync incremental, and
-- the coverage fields are what let the UI say how deep the archive actually
-- goes — which matters more here than anywhere else in the schema, because a
-- thin archive produces confident-looking return rates from three orders.

CREATE TABLE IF NOT EXISTS shopify_order_sync_state (
  project_id        uuid        PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,

  -- Highest order updated_at successfully stored. The next run asks Shopify for
  -- everything at or after this, minus an overlap window (see
  -- lib/shopifyOrders.ts) so an order updated during a run is not skipped.
  watermark         timestamptz,

  -- Oldest and newest order created_at in the archive. The first is the honest
  -- answer to "how far back can this feature see".
  oldest_order_at   timestamptz,
  newest_order_at   timestamptz,

  last_run_at       timestamptz,
  last_run_orders   integer     NOT NULL DEFAULT 0,
  last_run_ms       integer,

  -- Set when a run fails, cleared when one succeeds. A stale archive is
  -- dangerous in a way a stale cache is not: it silently under-reports returns.
  last_error        text,
  last_error_at     timestamptz
);

ALTER TABLE shopify_order_sync_state DISABLE ROW LEVEL SECURITY;

COMMIT;

-- ── Feed output is untouched ───────────────────────────────────────────────
-- lib/feedGenerator.ts reads none of these tables. Nothing here reaches the
-- generated feed, and no custom label is derived from returns yet — that stays
-- an explicit, separate decision.
