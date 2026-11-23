-- Accounts: ownership moves from a single user to an account with members.
--
-- Until now every project, feed and Google Ads grant belonged to one auth user
-- (user_id = auth.uid()). The redesign needs an agency level: one account, many
-- users, all seeing the same shops. So:
--
--   accounts          one row per account (an agency, or a single user's own)
--   account_members   which users belong to which account, with a role
--   projects.account_id             the shop belongs to an account
--   google_ads_connections.account_id  the OAuth grant is shared by the account
--
-- Access is now "is the user a member of the project's account", checked in
-- app code by getOwnedProject()/getOwnedFeed() (lib/feeds.ts). user_id stays on
-- the old tables as "who created/last wrote this", nothing more.
--
-- Backfill: every existing auth user gets a personal account where they are
-- owner, and their projects and Google Ads grants move into it. Nobody loses or
-- gains access by running this.
--
-- user_id foreign keys are relaxed from ON DELETE CASCADE to ON DELETE SET NULL:
-- removing a member from the system must not delete the account's shops, feeds
-- or mappings that happen to carry their user_id.
--
-- seat_limit is the hook for plan limits (number of users). NULL = no limit.
-- How plans set it is not decided yet; nothing enforces it in this migration.
--
-- Idempotent: safe to replay via scripts/migrate.ts.

BEGIN;

-- ── 1. accounts + account_members ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name        text        NOT NULL,
  seat_limit  integer     CHECK (seat_limit IS NULL OR seat_limit > 0),
  created_by  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_members (
  account_id  uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text        NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_members_user_id ON account_members(user_id);

-- ── 2. Personal account for every user that has none ──────────────────────

INSERT INTO accounts (name, created_by)
SELECT COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), u.email, 'Konto'), u.id
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM account_members m WHERE m.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.created_by = u.id);

INSERT INTO account_members (account_id, user_id, role)
SELECT DISTINCT ON (a.created_by) a.id, a.created_by, 'owner'
FROM accounts a
WHERE a.created_by IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM account_members m WHERE m.user_id = a.created_by)
ORDER BY a.created_by, a.created_at
ON CONFLICT DO NOTHING;

-- ── 3. projects.account_id ────────────────────────────────────────────────
-- RESTRICT, not CASCADE: deleting an account must go through the app, which
-- purges large product tables in batches first (see purgeFeedProducts).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE RESTRICT;

UPDATE projects p
SET account_id = (
  SELECT m.account_id FROM account_members m
  WHERE m.user_id = p.user_id AND m.role = 'owner'
  ORDER BY m.created_at
  LIMIT 1
)
WHERE p.account_id IS NULL;

ALTER TABLE projects ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_account_id ON projects(account_id);

-- ── 4. google_ads_connections.account_id ──────────────────────────────────

ALTER TABLE google_ads_connections
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;

UPDATE google_ads_connections c
SET account_id = (
  SELECT m.account_id FROM account_members m
  WHERE m.user_id = c.user_id AND m.role = 'owner'
  ORDER BY m.created_at
  LIMIT 1
)
WHERE c.account_id IS NULL;

ALTER TABLE google_ads_connections ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_google_ads_connections_account_id
  ON google_ads_connections(account_id);

-- ── 5. Relax user_id: nullable, ON DELETE SET NULL ────────────────────────

DO $$
DECLARE
  t text;
  c text;
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

    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN user_id DROP NOT NULL', t);

    FOR c IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.contype = 'f'
        AND con.conrelid = format('public.%I', t)::regclass
        AND con.confrelid = 'auth.users'::regclass
        AND att.attname = 'user_id'
        AND con.confdeltype <> 'n'  -- already SET NULL → nothing to do
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL',
        t, c
      );
    END LOOP;
  END LOOP;
END $$;

-- ── 6. Row-Level Security (defense-in-depth) ──────────────────────────────
-- The app uses the service-role key, which bypasses RLS; primary isolation is
-- the membership check in app code. These policies cover any future
-- anon/authed-key access path.

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their accounts" ON accounts;
CREATE POLICY "Members can read their accounts"
  ON accounts FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.account_id = accounts.id AND m.user_id = auth.uid()
  ));

DROP POLICY IF EXISTS "Users can read own memberships" ON account_members;
CREATE POLICY "Users can read own memberships"
  ON account_members FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can manage own projects" ON projects;
DROP POLICY IF EXISTS "Members can manage account projects" ON projects;
CREATE POLICY "Members can manage account projects"
  ON projects FOR ALL
  USING (EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.account_id = projects.account_id AND m.user_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.account_id = projects.account_id AND m.user_id = auth.uid()
  ));

COMMIT;
