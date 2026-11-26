-- Close the public data API: only the app's server (service role) reads and
-- writes app tables.
--
-- Found 2026-11-26: 34 tables had no row-level security, and Supabase grants
-- the `anon` and `authenticated` roles full table privileges by default. So
-- anyone holding the public anon key (it ships to every browser) could read
-- and change those tables through /rest/v1 without signing in: feeds,
-- products, mappings, Google Ads connections, orders, rate-limit counters, …
-- And two policies (projects, shop_settings) let any signed-in user write
-- rows directly, past every check in the app (plan limits included).
--
-- The app never uses the anon key for data: every read and write goes through
-- the service role (adminDb), which bypasses RLS; the browser client is used
-- for sign-out only. Checked on this branch and on master, which production
-- runs against the same database. So:
--
--   1. RLS on for every public table that lacks it, with no policies: the
--      anon/authenticated roles see nothing, the service role is unaffected.
--   2. projects and shop_settings: the write-everything policies become
--      read-only (members can still read their own rows, as before).
--   3. App functions: EXECUTE taken from PUBLIC/anon/authenticated, given to
--      service_role. They are SECURITY INVOKER, so with (1) they could no
--      longer reach data anyway; this keeps them from being called at all.
--      Trigger functions and Supabase's own rls_auto_enable are left alone.
--
-- Nothing is dropped and no data changes. Idempotent: safe to replay.
-- Rollback: supabase/rollback/rollback_063.sql (restores the open state).

BEGIN;

-- ── 1. RLS on every public table ──────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ── 2. Read-only member policies ──────────────────────────────────────────

DROP POLICY IF EXISTS "Members can manage account projects" ON projects;
DROP POLICY IF EXISTS "Members can read account projects" ON projects;
CREATE POLICY "Members can read account projects"
  ON projects FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.account_id = projects.account_id AND m.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Users can manage own shop settings" ON shop_settings;
DROP POLICY IF EXISTS "Users can read own shop settings" ON shop_settings;
CREATE POLICY "Users can read own shop settings"
  ON shop_settings FOR SELECT
  USING (auth.uid() = user_id);

-- ── 3. App functions: service role only ───────────────────────────────────

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.prorettype <> 'trigger'::regtype
      AND p.prorettype <> 'event_trigger'::regtype
      AND p.proname <> 'rls_auto_enable'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;

COMMIT;
