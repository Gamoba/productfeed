// Agency users: list, invite, change role and remove members of an account.
//
// Rules (who may do what):
//   - Every member may SEE the list.
//   - Owners and admins may invite, change roles and remove.
//   - Only an owner may grant or take away the owner role, or touch an owner.
//   - The last owner can't be demoted or removed: an account always has one.
//   - Nobody changes their own role or removes themselves here.
//   - Seats: accounts.seat_limit (migration 052) caps members, invited ones
//     included. NULL means no limit. How plans set it is still open
//     (GUIDELINES §8), so it is read, never hard-coded.
//
// Invites: self-service signup is closed (app/login/actions.ts), so an invite
// creates the login. generateLink returns the link instead of e-mailing it;
// the inviter sends it themself. Supabase's built-in mailer only reaches the
// project's own team addresses, so relying on it would fail silently for
// real customers. The link lands on /auth/invite, where a password is chosen.
//
// Takes the service-role client; callers check the session user first.

import type { SupabaseClient } from '@supabase/supabase-js'
import { AppError, dbError } from '@/lib/errors'
import { getAccountRole, type AccountRole } from '@/lib/accounts'
import { assertCanAddMember } from '@/lib/ops/limits'

export type MemberRow = {
  userId: string
  email: string
  name: string | null
  role: AccountRole
  joinedAt: string
  /** null = invited, has never signed in. */
  lastSignInAt: string | null
}

export type AccountUsers = {
  account: { id: string; name: string; seatLimit: number | null }
  myRole: AccountRole
  me: string
  members: MemberRow[]
}

export const ROLES: AccountRole[] = ['owner', 'admin', 'member']
export const isRole = (v: unknown): v is AccountRole => typeof v === 'string' && (ROLES as string[]).includes(v)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const canManage = (r: AccountRole | null) => r === 'owner' || r === 'admin'

async function requireRole(db: SupabaseClient, userId: string, accountId: string): Promise<AccountRole> {
  const role = await getAccountRole(db, userId, accountId)
  if (!role) throw new AppError('The account does not exist', 404)
  return role
}

export async function listAccountUsers(db: SupabaseClient, userId: string, accountId: string): Promise<AccountUsers> {
  const myRole = await requireRole(db, userId, accountId)
  const [{ data: account, error: aErr }, { data: rows, error: mErr }] = await Promise.all([
    db.from('accounts').select('id, name, seat_limit').eq('id', accountId).single(),
    db.rpc('account_member_profiles', { p_account_id: accountId }),
  ])
  if (aErr) dbError('listAccountUsers account', aErr)
  if (mErr) dbError('listAccountUsers members', mErr)
  const a = account as { id: string; name: string; seat_limit: number | null }
  return {
    account: { id: a.id, name: a.name, seatLimit: a.seat_limit },
    myRole,
    me: userId,
    members: ((rows ?? []) as Record<string, unknown>[]).map((r) => ({
      userId: String(r.user_id),
      email: String(r.email ?? ''),
      name: (r.full_name as string | null) ?? null,
      role: r.role as AccountRole,
      joinedAt: String(r.joined_at),
      lastSignInAt: (r.last_sign_in_at as string | null) ?? null,
    })),
  }
}

export type InviteResult =
  | { kind: 'added'; email: string }
  | { kind: 'invited'; email: string; link: string }

export async function inviteUser(
  db: SupabaseClient,
  actorId: string,
  accountId: string,
  input: { email: unknown; name?: unknown; role: unknown },
  redirectTo: string
): Promise<InviteResult> {
  const actorRole = await requireRole(db, actorId, accountId)
  if (!canManage(actorRole)) throw new AppError('Only owners and admins can invite users', 403)

  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  if (!EMAIL_RE.test(email)) throw new AppError('Enter a valid email address')
  if (!isRole(input.role)) throw new AppError('Invalid role')
  if (input.role === 'owner' && actorRole !== 'owner') throw new AppError('Only an owner can make others owner', 403)
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : ''

  const [{ data: acc, error: accErr }, { count, error: countErr }] = await Promise.all([
    db.from('accounts').select('seat_limit').eq('id', accountId).single(),
    db.from('account_members').select('user_id', { count: 'exact', head: true }).eq('account_id', accountId),
  ])
  if (accErr) dbError('inviteUser account', accErr)
  if (countErr) dbError('inviteUser count', countErr)
  const members = count ?? 0
  // The plan's user limit (lib/ops/limits.ts), then any manual seat_limit.
  await assertCanAddMember(db, accountId, members)
  const seatLimit = (acc as { seat_limit: number | null }).seat_limit
  if (seatLimit !== null && members >= seatLimit) {
    throw new AppError(`All ${seatLimit} seats are used. Remove a user or upgrade the plan.`)
  }

  const { data: existingId, error: lookupErr } = await db.rpc('auth_user_id_by_email', { p_email: email })
  if (lookupErr) dbError('inviteUser lookup', lookupErr)

  // Already has a login: add the membership; they see the account next time.
  if (existingId) {
    const { error } = await db
      .from('account_members')
      .insert({ account_id: accountId, user_id: existingId as string, role: input.role })
    if (error?.code === '23505') throw new AppError('The user already has access')
    if (error) dbError('inviteUser add existing', error)
    return { kind: 'added', email }
  }

  // New login: create it with an invite link and add the membership now, so
  // the seat is held and the row shows as "Inviteret" until they sign in.
  const { data: link, error: linkErr } = await db.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo, data: name ? { full_name: name } : undefined },
  })
  if (linkErr || !link?.user || !link.properties?.action_link) {
    console.error('[inviteUser] generateLink:', linkErr)
    throw new AppError('The invitation could not be created. Try again.')
  }
  const { error: memberErr } = await db
    .from('account_members')
    .insert({ account_id: accountId, user_id: link.user.id, role: input.role })
  if (memberErr) dbError('inviteUser add new', memberErr)
  return { kind: 'invited', email, link: link.properties.action_link }
}

// A fresh link for someone invited who never signed in (links expire).
export async function newInviteLink(
  db: SupabaseClient,
  actorId: string,
  accountId: string,
  targetId: string,
  redirectTo: string
): Promise<string> {
  const target = await loadTarget(db, actorId, accountId, targetId)
  if (target.lastSignInAt) throw new AppError('The user has already signed in and does not need a link')
  // A magic link signs them in; /auth/invite then asks for a password.
  const { data, error } = await db.auth.admin.generateLink({
    type: 'magiclink',
    email: target.email,
    options: { redirectTo },
  })
  if (error || !data?.properties?.action_link) {
    console.error('[newInviteLink] generateLink:', error)
    throw new AppError('The link could not be created. Try again.')
  }
  return data.properties.action_link
}

export async function changeRole(
  db: SupabaseClient,
  actorId: string,
  accountId: string,
  targetId: string,
  role: unknown
): Promise<void> {
  if (!isRole(role)) throw new AppError('Invalid role')
  const target = await loadTarget(db, actorId, accountId, targetId)
  if (target.role === role) return
  if ((role === 'owner' || target.role === 'owner') && target.actorRole !== 'owner') {
    throw new AppError('Only an owner can change the owner role', 403)
  }
  if (target.role === 'owner') await assertNotLastOwner(db, accountId)
  const { error } = await db
    .from('account_members')
    .update({ role })
    .eq('account_id', accountId)
    .eq('user_id', targetId)
  if (error) dbError('changeRole', error)
}

export async function removeMember(
  db: SupabaseClient,
  actorId: string,
  accountId: string,
  targetId: string
): Promise<void> {
  const target = await loadTarget(db, actorId, accountId, targetId)
  if (target.role === 'owner') {
    if (target.actorRole !== 'owner') throw new AppError('Only an owner can remove an owner', 403)
    await assertNotLastOwner(db, accountId)
  }
  const { error } = await db.from('account_members').delete().eq('account_id', accountId).eq('user_id', targetId)
  if (error) dbError('removeMember', error)

  // An invite nobody accepted leaves a login with no password and no access.
  // Delete it, but only when it was never used and belongs to nothing else.
  if (!target.lastSignInAt) {
    const { count } = await db
      .from('account_members')
      .select('account_id', { count: 'exact', head: true })
      .eq('user_id', targetId)
    if (!count) {
      const { error: delErr } = await db.auth.admin.deleteUser(targetId)
      if (delErr) console.error('[removeMember] could not delete unused invite login:', delErr)
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadTarget(db: SupabaseClient, actorId: string, accountId: string, targetId: string) {
  const actorRole = await requireRole(db, actorId, accountId)
  if (!canManage(actorRole)) throw new AppError('Only owners and admins can change users', 403)
  if (targetId === actorId) throw new AppError('You cannot change your own access here')
  const { members } = await listAccountUsers(db, actorId, accountId)
  const t = members.find((m) => m.userId === targetId)
  if (!t) throw new AppError('The user is not on the account', 404)
  return { ...t, actorRole }
}

async function assertNotLastOwner(db: SupabaseClient, accountId: string) {
  const { count, error } = await db
    .from('account_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('role', 'owner')
  if (error) dbError('assertNotLastOwner', error)
  if ((count ?? 0) <= 1) throw new AppError('The account must have at least one owner')
}
