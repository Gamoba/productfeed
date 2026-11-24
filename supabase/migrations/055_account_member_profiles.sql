-- Agency users: read helpers over auth.users for the members page.
--
-- account_members only holds user ids. The Agency users page needs each
-- member's e-mail, name and whether they have signed in yet (an invited user
-- who never opened the link shows as "Inviteret"), and inviting needs to know
-- whether an e-mail already has a login. Both live in auth.users, which the API
-- can't select from directly, so two SECURITY DEFINER functions expose exactly
-- those columns.
--
-- Callable by the service role only (the app's adminDb()). Revoked from anon and
-- authenticated so no client key can enumerate users or e-mails.
--
-- Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION account_member_profiles(p_account_id uuid)
RETURNS TABLE (
  user_id         uuid,
  email           text,
  full_name       text,
  role            text,
  joined_at       timestamptz,
  last_sign_in_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT m.user_id,
         u.email::text,
         NULLIF(COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'), ''),
         m.role,
         m.created_at,
         u.last_sign_in_at
  FROM account_members m
  JOIN auth.users u ON u.id = m.user_id
  WHERE m.account_id = p_account_id
  ORDER BY m.created_at;
$$;

CREATE OR REPLACE FUNCTION auth_user_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(trim(p_email)) LIMIT 1;
$$;

REVOKE ALL ON FUNCTION account_member_profiles(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION auth_user_id_by_email(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION account_member_profiles(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION auth_user_id_by_email(text) TO service_role;

COMMIT;
