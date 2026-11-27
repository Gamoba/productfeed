-- Rollback of 068_referral_review.sql. Referrals waiting for review then pay
-- out like any other.

BEGIN;

ALTER TABLE referrals DROP COLUMN IF EXISTS review_reason;
ALTER TABLE referrals DROP COLUMN IF EXISTS needs_review;
DELETE FROM schema_migrations WHERE filename = '068_referral_review.sql';

COMMIT;
