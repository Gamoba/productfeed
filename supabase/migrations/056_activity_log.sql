-- Activity log: who changed what in a shop, and when (Shop › Activity log).
--
-- One row per change, written by the app at the moment a setting is saved
-- (lib/activity.ts). Best effort: a failed log write never fails the change.
--
--   account_id   the account the change belongs to (always set)
--   project_id   the shop; NULL for account-wide events (users, invites), which
--                every shop in the account shows
--   feed_id      the feed, when the change was on one. No foreign key, so the
--                history of a deleted feed stays readable
--   feed_label   snapshot of the feed's name at the time ("Google Shopping ·
--                Tyskland"), for the same reason
--   user_id      who did it; NULL for the system (scheduled runs)
--   actor        snapshot of the name/e-mail, so the line survives the user
--                leaving the account
--   area         the page or part of FeedFlow ("Mapping", "Settings", "Feed")
--   action       what happened, in Danish, short
--   before/after the value before and after, as text; either may be NULL
--
-- Deleting a shop deletes its log (ON DELETE CASCADE): the log is about the
-- shop, not a separate audit archive.
--
-- Read through the service role in app code; RLS is defense-in-depth.
-- Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS activity_log (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id  uuid        REFERENCES projects(id) ON DELETE CASCADE,
  feed_id     uuid,
  feed_label  text,
  user_id     uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor       text        NOT NULL,
  area        text        NOT NULL,
  action      text        NOT NULL,
  before      text,
  after       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_project ON activity_log (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_account ON activity_log (account_id, created_at DESC);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their account's activity" ON activity_log;
CREATE POLICY "Members can read their account's activity"
  ON activity_log FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.account_id = activity_log.account_id AND m.user_id = auth.uid()
  ));

COMMIT;
