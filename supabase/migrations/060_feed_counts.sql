-- The last counted number of products in each feed: active products, and how
-- many of them pass the include/exclude rules (lib/feedCounts).
--
-- Counting means reading every active product and running the rules: up to
-- ~3 s on an 11k catalogue. Pages show this stored count at once and recount
-- in the background; the new count is written back here.
--
-- Its own table (not columns on feeds) so a recount never touches the feed
-- row or its updated_at. Additive only; nothing touches Shopify.
--
-- Idempotent: safe to replay via scripts/migrate.ts.
-- Rollback: supabase/rollback/rollback_060.sql

BEGIN;

CREATE TABLE IF NOT EXISTS feed_counts (
  feed_id     uuid        PRIMARY KEY REFERENCES feeds(id) ON DELETE CASCADE,
  active      integer     NOT NULL CHECK (active >= 0),
  included    integer     NOT NULL CHECK (included >= 0),
  counted_at  timestamptz NOT NULL DEFAULT now()
);

-- The app reads and writes with the service role; this covers any future
-- anon/authed-key path, as for master_fields.
ALTER TABLE feed_counts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their feeds' counts" ON feed_counts;
CREATE POLICY "Members can read their feeds' counts"
  ON feed_counts FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM feeds f
    JOIN projects p ON p.id = f.project_id
    JOIN account_members m ON m.account_id = p.account_id
    WHERE f.id = feed_counts.feed_id AND m.user_id = auth.uid()
  ));

COMMIT;
