-- Possible self-referrals (security review, 27 Nov 2026): a referral whose
-- new user shares an email domain with the referring agency's members is
-- flagged when it's recorded (lib/signup.ts). Its kickback is still written
-- (lib/commissions.ts), but not paid out until a platform admin approves it
-- in Admin › Referrals.
--
--   needs_review   true while waiting for that approval
--   review_reason  why it was flagged, shown in Admin
--
-- Additive, defaults keep every existing referral as it is. Idempotent.
-- Rollback: supabase/rollback/rollback_068.sql

BEGIN;

ALTER TABLE referrals ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS review_reason text;

COMMIT;
