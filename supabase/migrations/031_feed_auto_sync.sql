-- Scheduled (automatic) product sync per feed.
--
-- Until now products were only pulled from Shopify when someone pressed Sync,
-- so the feed silently drifted from the shop — a price change or a new sale
-- never reached Google until a manual sync. A Vercel cron (/api/cron/sync)
-- now ticks every few minutes and syncs each feed whose schedule is due.
--
-- The schedule lives on `feeds` itself (not a side table) so every feed —
-- including ones created after this migration — has a schedule by default,
-- with no row to forget to create.
--
--   auto_sync_frequency   'off' | 'hourly' | '6h' | '12h' | 'daily'
--   auto_sync_time        'HH:MM' in Europe/Copenhagen. For 'daily' it is the
--                         time of day; for the interval options it is the
--                         anchor the intervals count from.
--   last_auto_sync_at     when the cron last CLAIMED this feed. Set before the
--                         sync runs, so overlapping ticks can't double-sync it.
--   last_auto_sync_status 'running' | 'ok' | 'error'
--   last_auto_sync_error  client-safe message (never raw DB/Shopify detail).
--
-- Default: once a day at 00:01.
--
-- Idempotent: IF NOT EXISTS so the migrate.ts runner can replay it safely.

BEGIN;

ALTER TABLE feeds
  ADD COLUMN IF NOT EXISTS auto_sync_frequency   text        NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS auto_sync_time        text        NOT NULL DEFAULT '00:01',
  ADD COLUMN IF NOT EXISTS last_auto_sync_at     timestamptz,
  ADD COLUMN IF NOT EXISTS last_auto_sync_status text,
  ADD COLUMN IF NOT EXISTS last_auto_sync_error  text;

ALTER TABLE feeds DROP CONSTRAINT IF EXISTS feeds_auto_sync_frequency_check;
ALTER TABLE feeds ADD CONSTRAINT feeds_auto_sync_frequency_check
  CHECK (auto_sync_frequency IN ('off', 'hourly', '6h', '12h', 'daily'));

ALTER TABLE feeds DROP CONSTRAINT IF EXISTS feeds_auto_sync_time_check;
ALTER TABLE feeds ADD CONSTRAINT feeds_auto_sync_time_check
  CHECK (auto_sync_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

COMMIT;
