// Agency dashboard: every shop the user can reach, rolled up for one table.
//
// One pass over projects → feeds → feed_cache/shop_settings, so the page needs
// no per-shop requests. "Fejl" counts what needs someone to act, the same way
// the shop Feeds page labels a feed: validation issues of type error, plus a
// feed whose product sync has gone stale (staleSyncDays).

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import { getMemberships } from '@/lib/accounts'
import { staleSyncDays } from '@/lib/syncSchedule'
import type { ValidationIssue } from '@/lib/feedValidator'

export type AgencyShop = {
  id: string
  name: string
  description: string | null
  accountName: string
  /** Shopify admin domain, or the storefront host for feed-URL shops. */
  address: string | null
  source: 'shopify' | 'feed_url'
  /** Shopify connection: connected | unverified | error. Feed-URL shops: null. */
  connection: string | null
  countries: string[]
  feeds: number
  liveFeeds: number
  errors: number
}

export type AgencyOverview = {
  multipleAccounts: boolean
  shops: AgencyShop[]
}

const hostOf = (url: string | null): string | null => {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export async function getAgencyOverview(db: SupabaseClient, userId: string): Promise<AgencyOverview> {
  const memberships = await getMemberships(db, userId)
  const accountIds = memberships.map((m) => m.account_id)
  if (!accountIds.length) return { multipleAccounts: false, shops: [] }

  const [{ data: accounts, error: aErr }, { data: projects, error: pErr }] = await Promise.all([
    db.from('accounts').select('id, name').in('id', accountIds),
    db
      .from('projects')
      .select('id, account_id, name, description, shop_url, source_type, feed_url, primary_domain, connection_status')
      .in('account_id', accountIds)
      .order('created_at', { ascending: true }),
  ])
  if (aErr) dbError('getAgencyOverview accounts', aErr)
  if (pErr) dbError('getAgencyOverview projects', pErr)

  const projectRows = (projects ?? []) as {
    id: string
    account_id: string
    name: string
    description: string | null
    shop_url: string | null
    source_type: string | null
    feed_url: string | null
    primary_domain: string | null
    connection_status: string | null
  }[]
  const accountName = new Map(((accounts ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]))

  const { data: feedRows, error: fErr } = projectRows.length
    ? await db.from('feeds').select('id, project_id, last_synced_at').in('project_id', projectRows.map((p) => p.id))
    : { data: [], error: null }
  if (fErr) dbError('getAgencyOverview feeds', fErr)
  const feeds = (feedRows ?? []) as { id: string; project_id: string; last_synced_at: string | null }[]
  const feedIds = feeds.map((f) => f.id)

  const [{ data: caches, error: cErr }, { data: markets, error: mErr }] = feedIds.length
    ? await Promise.all([
        db.from('feed_cache').select('feed_id, validation_status, validation_errors').in('feed_id', feedIds),
        db.from('shop_settings').select('feed_id, selected_country').in('feed_id', feedIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ]
  if (cErr) dbError('getAgencyOverview cache', cErr)
  if (mErr) dbError('getAgencyOverview markets', mErr)

  const cacheBy = new Map(
    ((caches ?? []) as { feed_id: string; validation_status: string | null; validation_errors: ValidationIssue[] | null }[]).map(
      (c) => [c.feed_id, c]
    )
  )
  const countryBy = new Map(
    ((markets ?? []) as { feed_id: string; selected_country: string | null }[]).map((m) => [m.feed_id, m.selected_country])
  )

  const shops: AgencyShop[] = projectRows.map((p) => {
    const own = feeds.filter((f) => f.project_id === p.id)
    let errors = 0
    let liveFeeds = 0
    const countries = new Set<string>()
    for (const f of own) {
      const c = countryBy.get(f.id)
      if (c) countries.add(c.toUpperCase())
      const cache = cacheBy.get(f.id)
      const stale = staleSyncDays(f.last_synced_at) != null
      if (cache && !stale) liveFeeds++
      if (stale) errors++
      if (cache?.validation_status === 'errors') {
        const n = (cache.validation_errors ?? []).filter((i) => i.type === 'error').length
        errors += n || 1
      }
    }
    const feedUrl = p.source_type === 'feed_url'
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      accountName: accountName.get(p.account_id) ?? '',
      address: feedUrl ? hostOf(p.primary_domain ?? p.feed_url) : p.shop_url,
      source: feedUrl ? 'feed_url' : 'shopify',
      connection: feedUrl ? null : (p.connection_status ?? 'unverified'),
      countries: [...countries].sort(),
      feeds: own.length,
      liveFeeds,
      errors,
    }
  })

  return { multipleAccounts: accountIds.length > 1, shops }
}
