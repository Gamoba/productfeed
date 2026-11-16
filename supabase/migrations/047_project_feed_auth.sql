-- Feed-URL sources behind HTTP Basic Auth (e.g. a ProfitMetrics feed endpoint).
--
-- The login is stored like the Shopify token: AES-256-GCM with
-- TOKEN_ENCRYPTION_KEY (lib/crypto.ts). The plaintext is a JSON object
-- {"username": "...", "password": "..."}; it is decrypted only server-side at
-- fetch time and sent as an Authorization header to the feed's own origin —
-- never on a redirect to another origin, never to the client, never logged.
--
-- All three columns are NULL when the feed needs no login.
--
-- Idempotent: IF NOT EXISTS so migrate.ts can replay it.

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS feed_auth_ciphertext text,
  ADD COLUMN IF NOT EXISTS feed_auth_iv text,
  ADD COLUMN IF NOT EXISTS feed_auth_tag text;

COMMENT ON COLUMN projects.feed_auth_ciphertext IS
  'Encrypted (AES-256-GCM) Basic Auth login for feed_url, JSON {username,password}. NULL = no login.';

COMMIT;
