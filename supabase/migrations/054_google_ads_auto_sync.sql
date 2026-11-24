-- Scheduled Google Ads performance fetch per feed (Settings → Tidsplan).
--
-- Until now Google Ads numbers were only pulled when someone pressed "Hent tal"
-- on Performance, or once right after setup. The redesign puts "Hent
-- performance" next to "Generér feed" in feed Settings, each with its own
-- frequency and time. /api/cron/google-ads ticks with the product sync and
-- pulls each connected feed whose schedule is due.
--
-- Same shape and semantics as the product schedule on `feeds` (migration 031):
--
--   auto_sync_frequency   'off' | 'hourly' | '6h' | '12h' | 'daily'
--   auto_sync_time        'HH:MM' in Europe/Copenhagen
--   last_auto_sync_at     when the cron last CLAIMED this feed
--   last_auto_sync_status 'running' | 'ok' | 'error'
--   last_auto_sync_error  client-safe message
--
-- Lives on google_ads_feed_settings, because the schedule only means something
-- for a feed with a Google Ads account. Default: once a day at 05:00, which is
-- what the setup screen has always promised ("refresh daily").
--
-- The cron writes only these columns, never updated_at: the Labels page reads
-- updated_at > last_synced_at as "the settings changed after the label was
-- computed".
--
-- Read-only towards Google Ads: the cron runs the same syncGoogleAdsMetrics()
-- as the button. Idempotent.

BEGIN;

ALTER TABLE google_ads_feed_settings
  ADD COLUMN IF NOT EXISTS auto_sync_frequency   text        NOT NULL DEFAULT 'daily',
  ADD COLUMN IF NOT EXISTS auto_sync_time        text        NOT NULL DEFAULT '05:00',
  ADD COLUMN IF NOT EXISTS last_auto_sync_at     timestamptz,
  ADD COLUMN IF NOT EXISTS last_auto_sync_status text,
  ADD COLUMN IF NOT EXISTS last_auto_sync_error  text;

ALTER TABLE google_ads_feed_settings DROP CONSTRAINT IF EXISTS google_ads_feed_settings_auto_sync_frequency_check;
ALTER TABLE google_ads_feed_settings ADD CONSTRAINT google_ads_feed_settings_auto_sync_frequency_check
  CHECK (auto_sync_frequency IN ('off', 'hourly', '6h', '12h', 'daily'));

ALTER TABLE google_ads_feed_settings DROP CONSTRAINT IF EXISTS google_ads_feed_settings_auto_sync_time_check;
ALTER TABLE google_ads_feed_settings ADD CONSTRAINT google_ads_feed_settings_auto_sync_time_check
  CHECK (auto_sync_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

COMMIT;
