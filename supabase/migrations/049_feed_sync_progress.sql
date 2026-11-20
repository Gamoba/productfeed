-- Live state of a feed's product sync: a lock against overlapping syncs, and
-- the progress the UI shows as a bar.
--
-- Every way a sync starts (Sync buttons, Save & sync, the new-feed wizard,
-- cron, connect-feed) goes through lib/sync.ts syncProducts(), which claims the
-- feed by flipping sync_status to 'running' in a single conditional UPDATE.
-- Only one request can win that; a second one gets "already running" instead
-- of fighting the first over the same rows (which ended in statement
-- timeouts on BWH).
--
-- A claim older than the stale window (lib/syncProgress.ts) is treated as dead
-- — a crashed or killed function never releases it — so a feed can't lock
-- itself forever.
--
-- Separate from last_auto_sync_*: those record the cron schedule's outcome;
-- these record whatever sync is (or was last) running, from any trigger.
--
-- Idempotent: IF NOT EXISTS so migrate.ts can replay it.

BEGIN;

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS sync_status text,
  ADD COLUMN IF NOT EXISTS sync_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_progress smallint,
  ADD COLUMN IF NOT EXISTS sync_phase text,
  ADD COLUMN IF NOT EXISTS sync_error text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feeds_sync_status_check') THEN
    ALTER TABLE feeds
      ADD CONSTRAINT feeds_sync_status_check
      CHECK (sync_status IS NULL OR sync_status IN ('running', 'ok', 'error'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feeds_sync_progress_check') THEN
    ALTER TABLE feeds
      ADD CONSTRAINT feeds_sync_progress_check
      CHECK (sync_progress IS NULL OR sync_progress BETWEEN 0 AND 100);
  END IF;
END $$;

COMMENT ON COLUMN feeds.sync_status IS
  'running | ok | error — state of the current or most recent product sync (any trigger).';
COMMENT ON COLUMN feeds.sync_progress IS
  'Weighted 0–100 progress of the running sync, for the progress bar.';
COMMENT ON COLUMN feeds.sync_phase IS
  'Human-readable step of the running sync, e.g. "Saving metafields".';
COMMENT ON COLUMN feeds.sync_error IS
  'Client-safe error message of the last failed sync.';

COMMIT;
