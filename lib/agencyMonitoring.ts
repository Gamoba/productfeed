// Agency › Monitoring: feed quality per customer and the problems that need
// someone to act, across every shop the user can reach. Read-only; one pass
// over projects → feeds → feed_cache / shop_settings (no per-shop requests).
//
// Returns data only; the page words it (so both language branches share this).
//
// Quality comes from each feed's latest validation, which checks a sample (the
// first products of the feed, see lib/feedValidator). Per feed: the share of
// checked products without an error or warning. A product with two problems
// is counted twice, so the figure errs low rather than high; a required field
// that isn't mapped makes every checked product count as affected.
//
// Critical (the same rules as the Monitoring badge in the sidebar):
//   - a Shopify shop whose connection fails,
//   - a feed with validation errors,
//   - a feed whose products haven't synced for too long (staleSyncDays),
//   - a feed whose last automatic sync failed.
// Feeds with warnings only are listed separately as not critical.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import { getUsableMemberships } from '@/lib/accounts'
import { staleSyncDays } from '@/lib/syncSchedule'
import type { ChannelId } from '@/lib/channels'
import type { ValidationIssue } from '@/lib/feedValidator'

/** The validator's sample size (generatePreview(feedId, 20) in lib/feedValidator). */
const VALIDATION_SAMPLE = 20

export type MonitoringCustomer = {
  id: string
  name: string
  accountName: string
  feeds: number
  /** Feeds that have been generated (and so validated). */
  checkedFeeds: number
  /** 0–1, or null when no feed has been checked yet. */
  quality: number | null
  critical: number
  warnings: number
}

export type MonitoringIssue = {
  key: string
  kind: 'connection' | 'feed_errors' | 'stale' | 'sync_failed' | 'feed_warnings'
  shopId: string
  shopName: string
  feedId: string | null
  feedName: string | null
  channel: ChannelId | null
  country: string | null
  /** errors / warnings for feed_errors / feed_warnings; days for stale. */
  count: number
  /** A client-safe message (sync_failed), or the first issue's message. */
  message: string | null
  at: string | null
}

export type AgencyMonitoring = {
  multipleAccounts: boolean
  customers: MonitoringCustomer[]
  critical: MonitoringIssue[]
  warnings: MonitoringIssue[]
  totals: { customers: number; feeds: number; critical: number; quality: number | null }
}

type FeedRow = {
  id: string
  project_id: string
  name: string
  channel?: string | null
  last_synced_at?: string | null
  last_auto_sync_status?: string | null
  last_auto_sync_error?: string | null
  last_auto_sync_at?: string | null
}

type CacheRow = {
  feed_id: string
  generated_at: string | null
  product_count: number | null
  validation_errors: ValidationIssue[] | null
}

/** Checked products and how many of them have a problem, for one feed. */
function feedSample(cache: CacheRow | undefined): { checked: number; affected: number } | null {
  if (!cache?.generated_at) return null
  const checked = Math.min(VALIDATION_SAMPLE, cache.product_count ?? 0)
  if (checked === 0) return null
  const issues = cache.validation_errors ?? []
  // A required field that isn't mapped (affectedCount 0) is missing everywhere.
  if (issues.some((i) => i.type === 'error' && !i.affectedCount)) return { checked, affected: checked }
  const affected = issues.reduce((n, i) => n + (i.affectedCount ?? 0), 0)
  return { checked, affected: Math.min(checked, affected) }
}

// `scope`: the account the user is working in (lib/currentAccount.ts).
export async function getAgencyMonitoring(db: SupabaseClient, userId: string, scope?: string): Promise<AgencyMonitoring> {
  const memberships = await getUsableMemberships(db, userId, scope)
  const accountIds = memberships.map((m) => m.account_id)
  const empty: AgencyMonitoring = {
    multipleAccounts: false,
    customers: [],
    critical: [],
    warnings: [],
    totals: { customers: 0, feeds: 0, critical: 0, quality: null },
  }
  if (!accountIds.length) return empty

  const [{ data: accounts, error: aErr }, { data: projects, error: pErr }] = await Promise.all([
    db.from('accounts').select('id, name').in('id', accountIds),
    db
      .from('projects')
      .select('id, account_id, name, source_type, connection_status')
      .in('account_id', accountIds)
      .order('created_at', { ascending: true }),
  ])
  if (aErr) dbError('getAgencyMonitoring accounts', aErr)
  if (pErr) dbError('getAgencyMonitoring projects', pErr)
  const projectRows = (projects ?? []) as { id: string; account_id: string; name: string; source_type: string | null; connection_status: string | null }[]
  const accountName = new Map(((accounts ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]))

  // select('*'): the auto-sync columns (migration 031) may be missing on an old schema.
  const { data: feedRows, error: fErr } = projectRows.length
    ? await db.from('feeds').select('*').in('project_id', projectRows.map((p) => p.id)).order('created_at', { ascending: true })
    : { data: [], error: null }
  if (fErr) dbError('getAgencyMonitoring feeds', fErr)
  const feeds = (feedRows ?? []) as FeedRow[]
  const feedIds = feeds.map((f) => f.id)

  // Small columns only: never xml_content.
  const [{ data: caches, error: cErr }, { data: markets, error: mErr }] = feedIds.length
    ? await Promise.all([
        db.from('feed_cache').select('feed_id, generated_at, product_count, validation_errors').in('feed_id', feedIds),
        db.from('shop_settings').select('feed_id, selected_country').in('feed_id', feedIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ]
  if (cErr) dbError('getAgencyMonitoring cache', cErr)
  if (mErr) dbError('getAgencyMonitoring markets', mErr)
  const cacheBy = new Map(((caches ?? []) as CacheRow[]).map((c) => [c.feed_id, c]))
  const countryBy = new Map(((markets ?? []) as { feed_id: string; selected_country: string | null }[]).map((m) => [m.feed_id, m.selected_country]))

  const critical: MonitoringIssue[] = []
  const warnings: MonitoringIssue[] = []
  let allChecked = 0
  let allGood = 0

  const customers: MonitoringCustomer[] = projectRows.map((p) => {
    const own = feeds.filter((f) => f.project_id === p.id)
    let checked = 0
    let good = 0
    let checkedFeeds = 0
    let crit = 0
    let warn = 0
    const base = { shopId: p.id, shopName: p.name }

    if (p.source_type !== 'feed_url' && p.connection_status === 'error') {
      critical.push({ ...base, key: `c:${p.id}`, kind: 'connection', feedId: null, feedName: null, channel: null, country: null, count: 0, message: null, at: null })
      crit++
    }

    for (const f of own) {
      const cache = cacheBy.get(f.id)
      const feedBase = {
        ...base,
        feedId: f.id,
        feedName: f.name,
        channel: (f.channel ?? null) as ChannelId | null,
        country: countryBy.get(f.id)?.toUpperCase() ?? null,
      }
      const sample = feedSample(cache)
      if (sample) {
        checkedFeeds++
        checked += sample.checked
        good += sample.checked - sample.affected
      }
      const issues = cache?.validation_errors ?? []
      const errors = issues.filter((i) => i.type === 'error')
      const warns = issues.filter((i) => i.type === 'warning')
      if (errors.length) {
        critical.push({ ...feedBase, key: `e:${f.id}`, kind: 'feed_errors', count: errors.length, message: errors[0].message, at: cache?.generated_at ?? null })
        crit++
      } else if (warns.length) {
        warnings.push({ ...feedBase, key: `w:${f.id}`, kind: 'feed_warnings', count: warns.length, message: warns[0].message, at: cache?.generated_at ?? null })
        warn++
      }
      const stale = staleSyncDays(f.last_synced_at ?? null)
      if (stale !== null) {
        critical.push({ ...feedBase, key: `s:${f.id}`, kind: 'stale', count: stale, message: null, at: f.last_synced_at ?? null })
        crit++
      }
      if (f.last_auto_sync_status === 'error') {
        critical.push({ ...feedBase, key: `f:${f.id}`, kind: 'sync_failed', count: 0, message: f.last_auto_sync_error ?? null, at: f.last_auto_sync_at ?? null })
        crit++
      }
    }

    allChecked += checked
    allGood += good
    return {
      id: p.id,
      name: p.name,
      accountName: accountName.get(p.account_id) ?? '',
      feeds: own.length,
      checkedFeeds,
      quality: checked ? good / checked : null,
      critical: crit,
      warnings: warn,
    }
  })

  // Worst first: the page is the morning's starting point.
  customers.sort((a, b) => {
    if ((a.critical > 0) !== (b.critical > 0)) return a.critical > 0 ? -1 : 1
    if ((a.quality === null) !== (b.quality === null)) return a.quality === null ? 1 : -1
    return (a.quality ?? 0) - (b.quality ?? 0) || a.name.localeCompare(b.name)
  })

  return {
    multipleAccounts: accountIds.length > 1,
    customers,
    critical,
    warnings,
    totals: {
      customers: customers.length,
      feeds: feeds.length,
      critical: critical.length,
      quality: allChecked ? allGood / allChecked : null,
    },
  }
}
