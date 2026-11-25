-- Master fields: a rule set up once on the shop and used by every feed.
--
-- A master field holds one mapping (type + config, the same shape as
-- feed_mappings) with a name. A feed uses it in two ways (lib/mappingEval):
--   - mapping type MASTER, config { "master": "<key>" }: the field takes the
--     master field's value, and its own Only-if/transforms still apply;
--   - as a source, `master:<key>`, anywhere a mapping reads a field (Field,
--     Combine, conditions...), like the `feed:` references.
-- `feed:` references inside a master field read the feed that uses it.
--
-- Additive only: nothing existing changes, so an app without this feature
-- keeps working against the migrated database. Nothing touches Shopify.
--
-- Idempotent: safe to replay via scripts/migrate.ts.
-- Rollback: supabase/rollback/rollback_058.sql

BEGIN;

CREATE TABLE IF NOT EXISTS master_fields (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Stable reference used in mappings (`master:<key>`); never renamed.
  key           text        NOT NULL CHECK (key ~ '^[a-z0-9_]{1,60}$'),
  name          text        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description   text,
  mapping_type  text        NOT NULL CHECK (mapping_type <> '' AND mapping_type NOT IN ('AI', 'MASTER')),
  config        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_master_fields_project ON master_fields (project_id);

-- The app reads and writes with the service role; this covers any future
-- anon/authed-key path, as for mcp_changes.
ALTER TABLE master_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their shops' master fields" ON master_fields;
CREATE POLICY "Members can read their shops' master fields"
  ON master_fields FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM projects p
    JOIN account_members m ON m.account_id = p.account_id
    WHERE p.id = master_fields.project_id AND m.user_id = auth.uid()
  ));

COMMIT;
