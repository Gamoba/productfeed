-- Whether the conversion action's VALUE carries VAT, so break-even ROAS stops
-- comparing two different price bases.
--
-- ── THE BUG THIS FIXES ─────────────────────────────────────────────────────
-- Break-even ROAS is 1 ÷ margin: gross profit is revenue × margin, and you
-- break even where that equals the ad cost. That identity only holds when the
-- margin and the revenue are on the SAME basis.
--
-- Migration 040 put the margin on net prices. But the revenue half comes from
-- whatever Google reports as conversion value, and Shopify's standard Google
-- Ads tracking sends the order total INCLUDING moms. Dividing a gross revenue
-- by a net margin understates the threshold by exactly the VAT factor:
--
--     shown  = 1 ÷ m          true = (1 + v) ÷ m
--
-- At 25% that is a break-even 20% lower than reality — and it errs OPTIMISTIC,
-- marking products as clearing a bar they are actually under. That is the worst
-- direction for a number whose entire job is to say "stop bidding on this".
--
-- ── WHY IT IS A SECOND COLUMN AND NOT DERIVED FROM prices_include_vat ──────
-- The two are genuinely independent. A store can hold net prices in Shopify
-- (prices_include_vat = false) while its checkout adds moms and the conversion
-- value reports the gross total. Deriving one from the other would be right in
-- the common case and silently wrong in the rest, which is how a plausible
-- default outlives anyone's memory of having guessed.
--
-- ── ONE RATE, TWO BASES ────────────────────────────────────────────────────
-- vat_rate stays a single column. The rate is a property of the market, not of
-- either basis, so both questions read the same number. What changes is when it
-- may be cleared: migration 040's route dropped the rate whenever prices were
-- net, which would now discard a rate the conversion-value side still needs.
-- The rate is therefore kept while EITHER basis carries VAT — see the route.
--
-- ── NULL MEANS UNANSWERED ──────────────────────────────────────────────────
-- Same contract as 040 and as unit_cost in 038. NULL is "nobody has told us",
-- which is not FALSE, "the value is already net". The UI shows the column on
-- the net assumption and says in amber that it is unverified, rather than
-- blanking a number the operator can still read directionally.
--
-- Read-only towards Shopify. Idempotent: IF NOT EXISTS.

BEGIN;

ALTER TABLE google_ads_feed_settings
  -- NULL = unanswered · TRUE = conversion value carries VAT · FALSE = it is net
  ADD COLUMN IF NOT EXISTS conversion_value_includes_vat boolean;

COMMENT ON COLUMN google_ads_feed_settings.conversion_value_includes_vat IS
  'Whether the value reported by the chosen revenue conversion action includes VAT. '
  'Read with vat_rate to put reported revenue on the same basis as the net catalogue '
  'margin before deriving break-even ROAS. NULL = unanswered, not FALSE.';

COMMIT;

-- ── Feed output is untouched ───────────────────────────────────────────────
-- lib/feedGenerator.ts does not read google_ads_feed_settings at all. Nothing
-- here reaches the generated feed, and no Shopify write exists anywhere in it.
