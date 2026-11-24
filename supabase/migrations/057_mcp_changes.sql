-- MCP (Claude connector): changes an assistant asks for, and the agency
-- setting that lets them through without approval.
--
-- Every write an MCP client makes (mapping, include/exclude rules, feed
-- settings) is stored here first as a proposed change with a readable summary
-- and before/after. Shop › API / MCP lists the pending ones for approval. When
-- accounts.mcp_auto_apply is on, the change is applied at once and stored as
-- 'applied', so there is still a record of what the assistant did.
--
-- Nothing here touches Shopify: the changes are FeedFlow's own configuration.
--
-- Idempotent: safe to replay via scripts/migrate.ts.

BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS mcp_auto_apply boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS mcp_changes (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id         uuid        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id         uuid        REFERENCES projects(id) ON DELETE CASCADE,
  feed_id            uuid        REFERENCES feeds(id) ON DELETE CASCADE,
  feed_label         text,
  kind               text        NOT NULL,
  payload            jsonb       NOT NULL,
  summary            text        NOT NULL,
  -- [{ "label": "...", "before": "...", "after": "..." }] for the approval list
  details            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status             text        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'applied', 'rejected', 'failed')),
  error              text,
  requested_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_name  text        NOT NULL,
  client_name        text,
  decided_by         uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by_name    text,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_changes_project ON mcp_changes (project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_changes_account ON mcp_changes (account_id, status, created_at DESC);

-- The app reads and writes with the service role; this covers any future
-- anon/authed-key path, as for activity_log.
ALTER TABLE mcp_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their account's MCP changes" ON mcp_changes;
CREATE POLICY "Members can read their account's MCP changes"
  ON mcp_changes FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM account_members m
    WHERE m.account_id = mcp_changes.account_id AND m.user_id = auth.uid()
  ));

COMMIT;
