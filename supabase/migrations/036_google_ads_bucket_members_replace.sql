-- Atomic replacement of derived bucket membership.
--
-- THE PROBLEM THIS FIXES: recomputeBuckets used to DELETE every member row and
-- then INSERT the new ones in chunks of 500 — separate round-trips, so a failure
-- partway through left the feed with a partially wiped membership, no
-- buckets_computed_at stamp, and a Buckets page whose counts and share bars were
-- not stale but WRONG. Membership is derived, so there was nothing to recover
-- from except running the recompute again and hoping.
--
-- A plpgsql function body is a single transaction: the delete, the insert and
-- the stamp either all land or none do. That is the whole reason this is SQL
-- and not three PostgREST calls — atomicity cannot be assembled client-side.
--
-- Consequence worth knowing: the entire membership now travels as ONE jsonb
-- payload instead of N chunked requests. Rows are kept narrow for that reason —
-- `level` is a set-level property so it rides as a scalar parameter rather than
-- being repeated per row.
--
-- Read-only towards Shopify; touches only tables this app owns.
-- Idempotent: CREATE OR REPLACE.

BEGIN;

-- Returns the number of member rows written, which the caller uses as the
-- authoritative "assigned" count rather than trusting its own array length.
CREATE OR REPLACE FUNCTION google_ads_replace_bucket_members(
  p_feed_id     uuid,
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
  -- Mirrors google_ads_bucket_members_level_chk. Checked up front so a bad level
  -- fails before the delete rather than after it, even though the transaction
  -- would roll the delete back either way.
  IF p_level NOT IN ('product', 'variant') THEN
    RAISE EXCEPTION 'invalid bucket level: %', p_level;
  END IF;

  DELETE FROM google_ads_bucket_members WHERE feed_id = p_feed_id;

  -- A bucket deleted between assignment and this call violates the foreign key,
  -- which aborts the function and restores the previous membership. That is the
  -- intended outcome: better the old labels than half of the new ones.
  INSERT INTO google_ads_bucket_members
    (feed_id, bucket_id, ref, level, product_ref, computed_at)
  SELECT
    p_feed_id,
    (m ->> 'bucket_id')::uuid,
    m ->> 'ref',
    p_level,
    NULLIF(m ->> 'product_ref', ''),
    p_computed_at
  FROM jsonb_array_elements(COALESCE(p_members, '[]'::jsonb)) AS m;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Inside the same transaction, so the stamp can never claim a recompute that
  -- did not fully land.
  UPDATE google_ads_feed_settings
     SET buckets_computed_at = p_computed_at,
         updated_at          = p_computed_at
   WHERE feed_id = p_feed_id;

  RETURN v_inserted;
END;
$$;

COMMIT;
