// Accounts and memberships (migration 052).
//
// A project (shop) belongs to an account, and users reach it by being members
// of that account. This is the access model for every project/feed lookup —
// lib/feeds.ts getOwnedProject()/getOwnedFeed() are built on it.
//
// Takes the db client as a parameter (always the service-role adminDb()), so
// this module has no dependency on lib/feeds.ts.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'

export type AccountRole = 'owner' | 'admin' | 'member'

export type AccountMembership = {
  account_id: string
  role: AccountRole
  created_at: string
}

// Every account the user is a member of, oldest membership first.
export async function getMemberships(
  db: SupabaseClient,
  userId: string
): Promise<AccountMembership[]> {
  const { data, error } = await db
    .from('account_members')
    .select('account_id, role, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) dbError('getMemberships', error)
  return (data as AccountMembership[] | null) ?? []
}

export async function getAccessibleAccountIds(
  db: SupabaseClient,
  userId: string
): Promise<string[]> {
  return (await getMemberships(db, userId)).map((m) => m.account_id)
}

// The user's role in one account, or null when they are not a member.
export async function getAccountRole(
  db: SupabaseClient,
  userId: string,
  accountId: string
): Promise<AccountRole | null> {
  const { data, error } = await db
    .from('account_members')
    .select('role')
    .eq('user_id', userId)
    .eq('account_id', accountId)
    .maybeSingle<{ role: AccountRole }>()
  if (error) dbError('getAccountRole', error)
  return data?.role ?? null
}

// Project ids in every account the user belongs to.
export async function getAccessibleProjectIds(
  db: SupabaseClient,
  userId: string
): Promise<string[]> {
  const accountIds = await getAccessibleAccountIds(db, userId)
  if (accountIds.length === 0) return []
  const { data, error } = await db.from('projects').select('id').in('account_id', accountIds)
  if (error) dbError('getAccessibleProjectIds', error)
  return ((data ?? []) as { id: string }[]).map((p) => p.id)
}

// Creates a personal account with the user as owner. For users who signed up
// after migration 052 and have no membership yet.
export async function createPersonalAccount(
  db: SupabaseClient,
  user: { id: string; email?: string | null }
): Promise<string> {
  const { data, error } = await db
    .from('accounts')
    .insert({ name: user.email || 'Konto', created_by: user.id })
    .select('id')
    .single<{ id: string }>()
  if (error) dbError('createPersonalAccount', error)
  if (!data) throw new Error('Kontoen kunne ikke oprettes')
  const { error: memberErr } = await db
    .from('account_members')
    .insert({ account_id: data.id, user_id: user.id, role: 'owner' })
  if (memberErr) dbError('createPersonalAccount member', memberErr)
  return data.id
}

// Which account a new project goes into.
//
// - `requested` given: the user must be a member of it, else null.
// - otherwise: the user's oldest membership, creating a personal account when
//   they have none.
//
// Any member may create projects for now; roles get teeth when agency user
// management is built.
export async function resolveAccountForNewProject(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
  requested?: string | null
): Promise<string | null> {
  if (requested) {
    return (await getAccountRole(db, user.id, requested)) ? requested : null
  }
  const memberships = await getMemberships(db, user.id)
  if (memberships.length > 0) return memberships[0].account_id
  return createPersonalAccount(db, user)
}
