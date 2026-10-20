-- Google Ads layer: per-feed product performance from the Google Ads API.
--
-- Read-only against Google (GAQL SELECT only). This is the data foundation for
-- two features: a product/variant performance view, and later a bucket engine
-- that labels products by ROAS/POAS. NOTHING here touches feed output — see the
-- note on emit gating at the bottom.
--
--   google_ads_connections    one OAuth grant (encrypted refresh token).
--                             Agency model: a single gamoba.dk grant reaches
--                             every client account through the MCC, so this
--                             hangs on the USER, not on a project.
--   google_ads_feed_settings  per feed: which Ads account, which conversion
--                             actions mean revenue/profit, how item ids map.
--   google_ads_product_daily  daily metrics per Merchant Center item id.
--
-- WHY DAILY ROWS: any window (7/30/90/365d) is then computable without
-- refetching. The sync re-pulls a rolling trailing window and upserts, because
-- Google attributes conversions RETROACTIVELY — appending yesterday only would
-- permanently understate older days.
--
-- WHY item_id IS THE KEY: Google reports per Merchant Center offer, which is
-- variant-level. Product-level buckets aggregate up; the variant view reads it
-- directly. Storing the raw id also means the exact string is available if
-- labels are ever emitted as a supplemental feed.
--
-- Idempotent: IF [NOT] EXISTS / DROP IF EXISTS guards throughout.

BEGIN;

-- ── 1. google_ads_connections ──────────────────────────────────────────────
-- Deliberately NOT UNIQUE per user: today one agency grant serves every client
-- (audience = Internal, so only @gamoba.dk may authorise), but if clients ever
-- connect their own accounts each grant becomes another row and feeds point at
-- the right one. No migration needed for that change.

CREATE TABLE IF NOT EXISTS google_ads_connections (
  id                        uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Human label for the grant, e.g. the authorising email.
  account_label             text,
  -- Encrypted OAuth refresh token (AES-256-GCM, lib/crypto.ts). All three parts
  -- are needed to decrypt. Never stored or transmitted in plaintext, never sent
  -- to the client, never logged — same contract as the Shopify token.
  refresh_token_ciphertext  text,
  refresh_token_iv          text,
  refresh_token_tag         text,
  -- The manager account every request is routed through (login-customer-id
  -- header). Not a secret.
  login_customer_id         text,
  status                    text        NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'connected', 'error')),
  last_verified_at          timestamptz,
  -- Last refresh/So-called auth failure, surfaced in the UI as "reconnect"
  -- rather than as a broken sync. Internal-audience refresh tokens do not expire
  -- on a timer, but they can still be revoked by an admin or a password change.
  last_error                text,
  created_at                timestamptz DEFAULT now(),
  updated_at                timestamptz DEFAULT now()
);

ALTER TABLE google_ads_connections DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_connections_user_id
  ON google_ads_connections(user_id);

-- ── 2. google_ads_feed_settings ────────────────────────────────────────────
-- One row per feed. A feed is already market-scoped (shop_settings.market_url),
-- which lines up with both a Google Ads account and a Merchant Center feed
-- label, so per-feed is the right grain — not per-project.

CREATE TABLE IF NOT EXISTS google_ads_feed_settings (
  id                     uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id                uuid        NOT NULL UNIQUE REFERENCES feeds(id) ON DELETE CASCADE,
  connection_id          uuid        REFERENCES google_ads_connections(id) ON DELETE SET NULL,
  -- Client account queried, digits only (no dashes).
  customer_id            text,
  customer_name          text,
  -- Account currency. cost_micros is denominated in it, so it must be recorded
  -- alongside the numbers rather than assumed to be DKK.
  currency_code          text,
  -- Optional segments.product_feed_label filter, so one Ads account serving
  -- several markets can still be split per feed.
  feed_label             text,

  -- WHICH CONVERSION ACTION MEANS WHAT.
  -- metrics.conversions_value only sums actions flagged primary_for_goal, so its
  -- meaning varies per account — revenue in one, gross profit in another (a
  -- ProfitMetrics "PM Gross Profit" action set as primary), or call/lead actions
  -- carrying no monetary value. Worse, the highest-value action in an account is
  -- often a view_item tracker whose "value" is just the product price. There is
  -- no safe heuristic, so the action is chosen explicitly and stored by NAME
  -- (ids differ per account; the name is what a human recognises).
  roas_conversion_action text,
  poas_conversion_action text,

  -- How a Merchant Center item id maps back to a Shopify product/variant:
  --   auto            detect from the data on first sync
  --   shopify_channel shopify_<cc>_<productId>_<variantId>
  --                   (Shopify's own Google & YouTube channel app)
  --   own_product     <productId>          — this app's feed, product mode
  --   own_variant     <productId>_<variantId> — this app's feed, variant mode
  -- Bidirectional by design: the same pattern that PARSES ids from Google can
  -- GENERATE them for products that have never served, which is what makes a
  -- "no traffic" bucket possible at all.
  id_pattern             text        NOT NULL DEFAULT 'auto'
    CHECK (id_pattern IN ('auto', 'shopify_channel', 'own_product', 'own_variant')),
  -- Country code used when generating shopify_channel ids (the <cc> segment).
  id_pattern_country     text,

  sync_window_days       integer     NOT NULL DEFAULT 90
    CHECK (sync_window_days BETWEEN 1 AND 730),
  last_synced_at         timestamptz,
  last_sync_error        text,
  created_at             timestamptz DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

ALTER TABLE google_ads_feed_settings DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_google_ads_feed_settings_connection_id
  ON google_ads_feed_settings(connection_id);

-- ── 3. google_ads_product_daily ────────────────────────────────────────────
-- Metrics are stored as Google reports them; every derived figure (ROAS, POAS,
-- CTR, CPC) is computed on read. Storing derived values would freeze them
-- against whichever conversion action was selected at sync time.

CREATE TABLE IF NOT EXISTS google_ads_product_daily (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  feed_id           uuid        NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  date              date        NOT NULL,
  -- Raw offer id exactly as Google reports it (lowercased by the API).
  item_id           text        NOT NULL,
  -- Resolved via id_pattern. product_ref joins products.shopify_id. Both are
  -- nullable: an id that no longer parses (pattern changed, or a stray item)
  -- must still be storable rather than silently dropped.
  product_ref       text,
  variant_ref       text,

  impressions       bigint      NOT NULL DEFAULT 0,
  clicks            bigint      NOT NULL DEFAULT 0,
  -- Micros of the account currency; divide by 1e6. Kept as the integer Google
  -- returns to avoid float drift when summing a window.
  cost_micros       bigint      NOT NULL DEFAULT 0,

  -- Account-default conversions (primary goals only). Kept for reference and
  -- for reconciling against the Google Ads UI, NOT used for ROAS/POAS.
  conversions       numeric(18, 4) NOT NULL DEFAULT 0,
  conversions_value numeric(18, 4) NOT NULL DEFAULT 0,

  -- The two explicitly selected actions. Only these are synced: storing every
  -- action would multiply row count by ~20 for data nothing queries. Changing
  -- the selection requires a re-sync of the window, which is cheap.
  roas_conversions  numeric(18, 4) NOT NULL DEFAULT 0,
  roas_value        numeric(18, 4) NOT NULL DEFAULT 0,
  poas_conversions  numeric(18, 4) NOT NULL DEFAULT 0,
  poas_value        numeric(18, 4) NOT NULL DEFAULT 0,

  synced_at         timestamptz DEFAULT now(),

  -- The upsert target for the rolling re-sync.
  UNIQUE (feed_id, date, item_id)
);

ALTER TABLE google_ads_product_daily DISABLE ROW LEVEL SECURITY;

-- Window aggregation always filters feed + date range.
CREATE INDEX IF NOT EXISTS idx_google_ads_product_daily_feed_date
  ON google_ads_product_daily(feed_id, date);

-- Product-level roll-up joins on product_ref.
CREATE INDEX IF NOT EXISTS idx_google_ads_product_daily_feed_product
  ON google_ads_product_daily(feed_id, product_ref);

COMMIT;

-- ── Feed output is NOT touched ─────────────────────────────────────────────
-- No column here is read by lib/feedGenerator.ts, so generated feed XML is
-- byte-identical to before this migration. When bucket labels are added later
-- they get their own table with an explicit emit flag defaulting to false —
-- deliberately NOT reusing optimization_buckets.custom_label_*, which
-- feedGenerator already emits unconditionally (migration 027).
