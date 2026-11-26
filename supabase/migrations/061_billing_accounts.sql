-- Billing and MCC accounts: the tables from docs/billing-data-model.md.
--
--   accounts            + type (mcc | user), billing_exempt, access_code,
--                         commission_rate
--   platform_admins     Gamoba staff who run the admin pages
--   platform_settings   platform-wide values (e.g. the default commission rate)
--   plans, plan_prices  public and custom plans; Stripe price ids per mode
--   stripe_customers    one Stripe customer per account and mode
--   subscriptions       kept in step with Stripe by the webhook
--   stripe_events       webhook idempotency: an event is handled once
--   mcc_signup_invites  one-time MCC signup links (token stored hashed)
--   referral_links      an MCC's ?ref= codes
--   access_grants       MCC access to a User's account or one feed
--   referrals           which MCC brought in which User (kickback)
--   commission_payouts  manual monthly payouts to MCCs
--   commissions         kickback ledger, one row per monthly part
--
-- Not here: feed_sku_usage. The SKU counting rule is under review.
--
-- Existing accounts: all become type 'user' with billing_exempt = true, so
-- nobody already using the app is asked to pay (decision A2). The backfill
-- runs only when the column is first added, so replaying this file never
-- exempts accounts created later.
--
-- Every table has RLS on and no policies: only the service role (the app's
-- server code) reads or writes them. Billing rows are never reachable with
-- the anon or user key.
--
-- Additive only: the app on master keeps working against the migrated
-- database. Nothing touches Shopify.
--
-- Idempotent: safe to replay via scripts/migrate.ts.
-- Rollback: supabase/rollback/rollback_061.sql

BEGIN;

-- ── 1. accounts: type and billing columns ─────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'billing_exempt'
  ) THEN
    ALTER TABLE accounts ADD COLUMN billing_exempt boolean NOT NULL DEFAULT false;
    -- Everyone already here stays free.
    UPDATE accounts SET billing_exempt = true;
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS access_code text,
  ADD COLUMN IF NOT EXISTS commission_rate numeric(5,4);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_type_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_type_check CHECK (type IN ('mcc', 'user'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_commission_rate_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_commission_rate_check
      CHECK (commission_rate IS NULL OR (commission_rate >= 0 AND commission_rate <= 1));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS accounts_access_code_key ON accounts(access_code);

-- ── 2. Platform admins and settings ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id     uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key         text        PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 3. Plans and prices ───────────────────────────────────────────────────
-- NULL in a limit means unlimited. account_id is set only on custom plans.

CREATE TABLE IF NOT EXISTS plans (
  id                    text        PRIMARY KEY,
  name                  text        NOT NULL,
  is_custom             boolean     NOT NULL DEFAULT false,
  account_id            uuid        REFERENCES accounts(id) ON DELETE CASCADE,
  self_serve            boolean     NOT NULL DEFAULT true,
  active                boolean     NOT NULL DEFAULT true,
  sort_order            integer     NOT NULL DEFAULT 0,
  included_skus         integer     CHECK (included_skus IS NULL OR included_skus >= 0),
  extra_per_1000_cents  integer     CHECK (extra_per_1000_cents IS NULL OR extra_per_1000_cents >= 0),
  feed_limit            integer     CHECK (feed_limit IS NULL OR feed_limit >= 0),
  shop_limit            integer     CHECK (shop_limit IS NULL OR shop_limit >= 0),
  user_limit            integer     CHECK (user_limit IS NULL OR user_limit > 0),
  syncs_per_day         integer     CHECK (syncs_per_day IS NULL OR syncs_per_day > 0),
  created_by            uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_custom_account CHECK (is_custom = (account_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_plans_account_id ON plans(account_id) WHERE account_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan_prices (
  plan_id          text        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  interval         text        NOT NULL CHECK (interval IN ('month', 'year')),
  livemode         boolean     NOT NULL,
  amount_cents     integer     NOT NULL CHECK (amount_cents >= 0),
  currency         text        NOT NULL DEFAULT 'eur',
  stripe_price_id  text        UNIQUE,
  PRIMARY KEY (plan_id, interval, livemode)
);

-- Public plans (docs/billing-brief.md §2). Enterprise is quoted, not bought
-- in the app (self_serve = false, no prices).
INSERT INTO plans (id, name, self_serve, sort_order, included_skus, extra_per_1000_cents,
                   feed_limit, shop_limit, user_limit, syncs_per_day)
VALUES
  ('standard',   'Standard',   true,  1, 1000,  380, 3,    1,    1,    1),
  ('advanced',   'Advanced',   true,  2, 5000,  270, 10,   2,    3,    2),
  ('pro',        'Pro',        true,  3, 25000, 203, 150,  NULL, NULL, 5),
  ('enterprise', 'Enterprise', false, 4, NULL,  NULL, NULL, NULL, NULL, 5)
ON CONFLICT (id) DO NOTHING;

-- Test-mode amounts. stripe_price_id is filled by scripts/stripe-setup.ts.
INSERT INTO plan_prices (plan_id, interval, livemode, amount_cents)
VALUES
  ('standard', 'month', false,   4900),
  ('standard', 'year',  false,  49000),
  ('advanced', 'month', false,   6700),
  ('advanced', 'year',  false,  67000),
  ('pro',      'month', false,  19700),
  ('pro',      'year',  false, 197000)
ON CONFLICT (plan_id, interval, livemode) DO NOTHING;

-- ── 4. Stripe customers, subscriptions, events ────────────────────────────

CREATE TABLE IF NOT EXISTS stripe_customers (
  account_id          uuid        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  livemode            boolean     NOT NULL,
  stripe_customer_id  text        NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, livemode)
);

-- kind 'extra_skus' is for annual plans whose extra SKUs bill monthly; a
-- monthly account may have both kinds on the same Stripe subscription.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id              uuid        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  plan_id                 text        NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  kind                    text        NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan', 'extra_skus')),
  interval                text        NOT NULL CHECK (interval IN ('month', 'year')),
  status                  text        NOT NULL,
  stripe_subscription_id  text        NOT NULL,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean     NOT NULL DEFAULT false,
  livemode                boolean     NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(account_id, livemode);

CREATE TABLE IF NOT EXISTS stripe_events (
  id            text        PRIMARY KEY,
  type          text        NOT NULL,
  livemode      boolean     NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 5. MCC signup, referrals, access ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS mcc_signup_invites (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  email           text        NOT NULL,
  token_hash      text        NOT NULL UNIQUE,
  created_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  mcc_account_id  uuid        REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS referral_links (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  mcc_account_id  uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code            text        NOT NULL UNIQUE,
  active          boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_links_mcc ON referral_links(mcc_account_id);

-- Revoked and declined grants are kept: they are the history Gamoba reads
-- when deciding a kickback override.
CREATE TABLE IF NOT EXISTS access_grants (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_account_id  uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mcc_account_id   uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope            text        NOT NULL DEFAULT 'account' CHECK (scope IN ('account', 'feed')),
  feed_id          uuid        REFERENCES feeds(id) ON DELETE CASCADE,
  source           text        NOT NULL CHECK (source IN ('referral', 'access_code')),
  status           text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'declined', 'revoked')),
  requested_by     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  CONSTRAINT access_grants_feed_scope CHECK ((scope = 'feed') = (feed_id IS NOT NULL)),
  CONSTRAINT access_grants_not_self CHECK (user_account_id <> mcc_account_id)
);

-- At most one open (pending or active) grant per User, MCC and scope target.
CREATE UNIQUE INDEX IF NOT EXISTS access_grants_open_key
  ON access_grants (user_account_id, mcc_account_id, COALESCE(feed_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS idx_access_grants_mcc ON access_grants(mcc_account_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS referrals (
  id                 uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  mcc_account_id     uuid         NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  user_account_id    uuid         NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE RESTRICT,
  referral_link_id   uuid         REFERENCES referral_links(id) ON DELETE SET NULL,
  access_grant_id    uuid         REFERENCES access_grants(id) ON DELETE SET NULL,
  commission_rate    numeric(5,4) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 1),
  status             text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'stopped')),
  signed_up_at       timestamptz  NOT NULL DEFAULT now(),
  first_paid_at      timestamptz,
  stopped_at         timestamptz,
  stop_reason        text,
  kickback_override  boolean      NOT NULL DEFAULT false,
  override_by        uuid         REFERENCES auth.users(id) ON DELETE SET NULL,
  override_at        timestamptz,
  override_note      text
);

CREATE INDEX IF NOT EXISTS idx_referrals_mcc ON referrals(mcc_account_id);

-- ── 6. Commissions ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS commission_payouts (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  mcc_account_id  uuid        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  period_month    date        NOT NULL,
  total_cents     integer     NOT NULL,
  currency        text        NOT NULL DEFAULT 'eur',
  reference       text,
  marked_paid_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  paid_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_payouts_mcc ON commission_payouts(mcc_account_id);

-- One row per monthly part: 1 for a monthly invoice, 12 for a yearly one.
-- A refund adds a negative 'reversed' row; undue yearly parts become 'dropped'.
CREATE TABLE IF NOT EXISTS commissions (
  id                    uuid         DEFAULT gen_random_uuid() PRIMARY KEY,
  referral_id           uuid         NOT NULL REFERENCES referrals(id) ON DELETE RESTRICT,
  subscription_id       uuid         REFERENCES subscriptions(id) ON DELETE SET NULL,
  payout_id             uuid         REFERENCES commission_payouts(id) ON DELETE SET NULL,
  stripe_invoice_id     text         NOT NULL,
  installment           integer      NOT NULL DEFAULT 1 CHECK (installment BETWEEN 1 AND 12),
  invoice_amount_cents  integer      NOT NULL,
  rate                  numeric(5,4) NOT NULL,
  commission_cents      integer      NOT NULL,
  currency              text         NOT NULL DEFAULT 'eur',
  payable_on            date         NOT NULL,
  status                text         NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'dropped', 'reversed')),
  created_at            timestamptz  NOT NULL DEFAULT now(),
  livemode              boolean      NOT NULL
);

-- An invoice's parts are written once; a replayed webhook can't double them.
CREATE UNIQUE INDEX IF NOT EXISTS commissions_invoice_part_key
  ON commissions (stripe_invoice_id, installment) WHERE status <> 'reversed';
CREATE INDEX IF NOT EXISTS idx_commissions_payable
  ON commissions (payable_on) WHERE payout_id IS NULL AND status = 'scheduled';

-- ── 7. RLS: service role only ─────────────────────────────────────────────

ALTER TABLE platform_admins     ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans               ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_prices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_customers    ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcc_signup_invites  ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_links      ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grants       ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payouts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions         ENABLE ROW LEVEL SECURITY;

COMMIT;
