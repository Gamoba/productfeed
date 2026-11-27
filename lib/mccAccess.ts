// What a user reaches through an agency (MCC): the active access grants of
// every MCC account they're a member of (migration 061, access_grants).
//
//   scope 'account'  the client's whole account: every shop and feed, and new
//                    shops and feeds may be created there (on the client's plan)
//   scope 'feed'     one feed: that feed only
//
// Every member of an MCC reaches all of the MCC's clients (decision 3). The
// client account's own plan still decides whether its shops can be used
// (lib/entitlements.ts); the lookups in lib/feeds.ts check both.
//
// Takes the service-role client.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'

export type MccReach = {
  /** Client accounts reached whole (scope 'account'). */
  accountIds: string[]
  /** Single feeds reached (scope 'feed'), with the client account they belong to. */
  feeds: { feedId: string; accountId: string }[]
}

const EMPTY: MccReach = { accountIds: [], feeds: [] }

// The MCC accounts the user is a member of.
export async function mccAccountIdsOf(db: SupabaseClient, userId: string): Promise<string[]> {
  const { data, error } = await db
    .from('account_members')
    .select('account_id, accounts!inner(type)')
    .eq('user_id', userId)
    .eq('accounts.type', 'mcc')
  if (error) dbError('mccAccountIdsOf', error)
  return ((data ?? []) as { account_id: string }[]).map((r) => r.account_id)
}

// `onlyMcc`: just that agency's clients (the account the user is working in,
// lib/currentAccount.ts); nothing when the user isn't a member of it.
export async function getMccReach(db: SupabaseClient, userId: string, onlyMcc?: string): Promise<MccReach> {
  const all = await mccAccountIdsOf(db, userId)
  const mccIds = onlyMcc === undefined ? all : all.filter((id) => id === onlyMcc)
  if (mccIds.length === 0) return EMPTY
  const { data, error } = await db
    .from('access_grants')
    .select('user_account_id, scope, feed_id')
    .in('mcc_account_id', mccIds)
    .eq('status', 'active')
  if (error) dbError('getMccReach', error)
  const rows = (data ?? []) as { user_account_id: string; scope: 'account' | 'feed'; feed_id: string | null }[]
  const accountIds = [...new Set(rows.filter((r) => r.scope === 'account').map((r) => r.user_account_id))]
  const feeds = rows
    .filter((r) => r.scope === 'feed' && r.feed_id && !accountIds.includes(r.user_account_id))
    .map((r) => ({ feedId: r.feed_id!, accountId: r.user_account_id }))
  return { accountIds, feeds }
}

// Whether the user reaches a client account whole through an agency.
export async function mccReachesAccount(db: SupabaseClient, userId: string, accountId: string): Promise<boolean> {
  const mccIds = await mccAccountIdsOf(db, userId)
  if (mccIds.length === 0) return false
  const { count, error } = await db
    .from('access_grants')
    .select('id', { count: 'exact', head: true })
    .in('mcc_account_id', mccIds)
    .eq('user_account_id', accountId)
    .eq('scope', 'account')
    .eq('status', 'active')
  if (error) dbError('mccReachesAccount', error)
  return (count ?? 0) > 0
}

// Whether the user reaches a feed through an agency: the whole client account,
// or that one feed.
export async function mccReachesFeed(db: SupabaseClient, userId: string, accountId: string, feedId: string): Promise<boolean> {
  const mccIds = await mccAccountIdsOf(db, userId)
  if (mccIds.length === 0) return false
  const { data, error } = await db
    .from('access_grants')
    .select('scope, feed_id')
    .in('mcc_account_id', mccIds)
    .eq('user_account_id', accountId)
    .eq('status', 'active')
  if (error) dbError('mccReachesFeed', error)
  return ((data ?? []) as { scope: string; feed_id: string | null }[]).some(
    (g) => g.scope === 'account' || g.feed_id === feedId
  )
}
