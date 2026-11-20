-- Give server-side (service_role) requests their own statement timeout.
--
-- PostgREST runs every request as `authenticator`, then switches to the role
-- in the JWT. anon (3 s) and authenticated (8 s) carry their own timeouts;
-- service_role carries none, so it inherited authenticator's 8 s.
--
-- 8 s is a sensible guard for browser traffic but too tight for our
-- server-only batch reads: feed generation, validation and counts each page
-- through a whole feed with metafields embedded, often in parallel. On BWH
-- (~2.6k products, ~23 metafields each) a page took 3–8 s on its own and hit
-- "canceling statement due to statement timeout" under concurrency → 500s.
--
-- Only service_role changes. It is used exclusively server-side (adminDb /
-- adminClient); the browser-facing roles keep their limits. 60 s still stops
-- a runaway query well inside the 300 s route ceiling.
--
-- Idempotent: ALTER ROLE ... SET simply overwrites, so migrate.ts can replay it.

ALTER ROLE service_role SET statement_timeout = '60s';

-- PostgREST caches role settings; tell it to reload them.
NOTIFY pgrst, 'reload config';
