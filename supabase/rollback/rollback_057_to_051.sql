-- ROLLBACK: undo migrations 052–057 and return the schema to 051.
--
-- Only for an emergency after running 052–057 in production, when the old app
-- (master before the redesign) has to run on its own again. It lives outside
-- supabase/migrations on purpose, so scripts/migrate.ts never runs it.
--
-- Run by hand, in one transaction:
--   psql "$DATABASE_URL" -f supabase/rollback/rollback_057_to_051.sql
-- Take a pg_dump first.
--
-- What is lost (it did not exist before 052):
--   accounts, account_members and every invited user's membership
--   activity_log, mcp_changes (Claude's proposed changes)
--   feeds.channel (non-Google channels fall back to Google Shopping)
--   the Google Ads schedules from 054 (back to the fixed cron)
-- Nothing in projects, feeds, products, mappings, filters or Google Ads
-- grants is deleted. Who created each row (user_id) was kept by 052, which is
-- what the old app reads.
--
-- user_id goes back to NOT NULL and ON DELETE CASCADE, as before 052. If a
-- user was deleted in the meantime, their rows have user_id = NULL; those
-- tables keep user_id nullable (a NOTICE names them) instead of deleting the
-- shops, so nothing is removed without a person deciding it.

BEGIN;

-- ── 057 ───────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS mcp_changes;

-- ── 056 ───────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS activity_log;

-- ── 055 ───────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS account_member_profiles(uuid);
DROP FUNCTION IF EXISTS auth_user_id_by_email(text);

-- ── 054 ───────────────────────────────────────────────────────────────────
ALTER TABLE google_ads_feed_settings
  DROP CONSTRAINT IF EXISTS google_ads_feed_settings_auto_sync_frequency_check,
  DROP CONSTRAINT IF EXISTS google_ads_feed_settings_auto_sync_time_check,
  DROP COLUMN IF EXISTS auto_sync_frequency,
  DROP COLUMN IF EXISTS auto_sync_time,
  DROP COLUMN IF EXISTS last_auto_sync_at,
  DROP COLUMN IF EXISTS last_auto_sync_status,
  DROP COLUMN IF EXISTS last_auto_sync_error;

-- ── 053 ───────────────────────────────────────────────────────────────────
ALTER TABLE feeds
  DROP CONSTRAINT IF EXISTS feeds_channel_check,
  DROP COLUMN IF EXISTS channel;

-- ── 052 ───────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS projects_fill_account_id ON projects;
DROP TRIGGER IF EXISTS google_ads_connections_fill_account_id ON google_ads_connections;
DROP FUNCTION IF EXISTS fill_account_id_from_user();

-- Projects policy back to the 019 version.
DROP POLICY IF EXISTS "Members can manage account projects" ON projects;
DROP POLICY IF EXISTS "Users can manage own projects" ON projects;
CREATE POLICY "Users can manage own projects"
  ON projects FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- user_id: ON DELETE CASCADE and NOT NULL again.
DO $$
DECLARE
  t text;
  c text;
  has_null boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'feeds', 'feed_mappings', 'feed_settings', 'feed_filters',
    'shop_settings', 'google_ads_connections'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'user_id'
    ) THEN
      CONTINUE;
    END IF;

    FOR c IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'f'
        AND con.conrelid = format('public.%I', t)::regclass
        AND con.confrelid = 'auth.users'::regclass
        AND att.attname = 'user_id'
        AND con.confdeltype <> 'c'
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE',
        t, c
      );
    END LOOP;

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE user_id IS NULL)', t) INTO has_null;
    IF has_null THEN
      RAISE NOTICE '% has rows without user_id (their user was deleted); user_id stays nullable', t;
    ELSE
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id SET NOT NULL', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE projects DROP COLUMN IF EXISTS account_id;
ALTER TABLE google_ads_connections DROP COLUMN IF EXISTS account_id;

-- One statement: the policy on accounts refers to account_members.
DROP TABLE IF EXISTS account_members, accounts;

-- So 052–057 can be run again later.
DELETE FROM schema_migrations
WHERE filename IN (
  '052_accounts.sql', '053_feed_channel.sql', '054_google_ads_auto_sync.sql',
  '055_account_member_profiles.sql', '056_activity_log.sql', '057_mcp_changes.sql'
);

COMMIT;
