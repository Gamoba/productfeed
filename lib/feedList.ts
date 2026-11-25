// The feed list for one or more shops: each feed with its market, product
// count, last sync, generated feed and validation, and the stored include /
// exclude counts (lib/feedCounts). Shared by /api/feeds and the shop page,
// which renders the list with the page instead of fetching it afterwards.
// The caller checks access to the shops first.

import type { SupabaseClient } from '@supabase/supabase-js'
import { storedCounts } from '@/lib/feedCounts'
import type { ValidationIssue } from '@/lib/feedValidator'
import type { ChannelId } from '@/lib/channels'

export async function loadFeedList(db: SupabaseClient, projectIds: string[]) {
  const feedsQuery = db
    .from('feeds')
    .select('id, name, description, project_id, channel, created_at, updated_at, last_synced_at')
    .in('project_id', projectIds)

  const { data: feeds, error: feedsErr } = await feedsQuery.order('created_at', {
    ascending: true,
  })

  if (feedsErr) {
    throw new Error(feedsErr.message)
  }

  const feedIds = (feeds ?? []).map((f) => f.id)

  type CacheRow = {
    feed_id: string
    generated_at: string
    product_count: number
    validation_status: 'ok' | 'warnings' | 'errors' | null
    validation_errors: ValidationIssue[] | null
  }

  // LAG 1 — fast per-feed lookups: head:true count (products), single-row
  // cache + last-sync. The slow per-feed countFilteredProducts call moved
  // to /api/feeds/counts so it doesn't hold back the dashboard render.
  // Per-feed product count uses head:true so PostgREST returns just a count
  // header. Last-sync is feeds.last_synced_at (migration 051), already on the
  // feed rows above.
  type MarketRow = {
    feed_id: string
    selected_market_id: string | null
    selected_country: string | null
    selected_locale: string | null
    currency: string | null
  }

  const productCount = new Map<string, number>()
  let caches: CacheRow[] | null = []
  let markets: MarketRow[] = []
  let stored = new Map<string, { active: number; included: number }>()

  try {
    const [productCountResults, cacheResult, marketResult, counted] = await Promise.all([
      Promise.allSettled(
        feedIds.map(
          async (id) =>
            [
              id,
              await db
                .from('products')
                .select('id', { count: 'exact', head: true })
                .eq('feed_id', id),
            ] as const
        )
      ),
      feedIds.length
        ? db
            .from('feed_cache')
            .select('feed_id, generated_at, product_count, validation_status, validation_errors')
            .in('feed_id', feedIds)
        : Promise.resolve({ data: [] as CacheRow[] }),
      // The feed's market (shop_settings, one row per feed).
      feedIds.length
        ? db
            .from('shop_settings')
            .select('feed_id, selected_market_id, selected_country, selected_locale, currency')
            .in('feed_id', feedIds)
        : Promise.resolve({ data: [] as MarketRow[] }),
      storedCounts(db, feedIds),
    ])
    stored = counted

    for (const r of productCountResults) {
      if (r.status === 'fulfilled') {
        const [id, res] = r.value
        productCount.set(id, res.count ?? 0)
      } else {
        console.error('[/api/feeds] product count failed for one feed:', r.reason)
      }
    }

    caches = (cacheResult.data as CacheRow[] | null) ?? []
    markets = (marketResult.data as MarketRow[] | null) ?? []
  } catch (err) {
    throw err
  }

  const cacheByFeed = new Map<string, CacheRow>()
  for (const row of (caches ?? []) as CacheRow[]) {
    cacheByFeed.set(row.feed_id, row)
  }

  const marketByFeed = new Map(markets.map((m) => [m.feed_id, m] as const))

  const enriched = (feeds ?? []).map((f) => {
    const cache = cacheByFeed.get(f.id)
    const market = marketByFeed.get(f.id)
    return {
      id: f.id,
      name: f.name,
      description: f.description,
      project_id: f.project_id,
      channel: f.channel as ChannelId,
      market: market
        ? {
            marketId: market.selected_market_id,
            country: market.selected_country,
            locale: market.selected_locale,
            currency: market.currency,
          }
        : null,
      created_at: f.created_at,
      updated_at: f.updated_at,
      productCount: productCount.get(f.id) ?? 0,
      lastSynced: (f.last_synced_at as string | null) ?? null,
      feedGenerated: cache?.generated_at ?? null,
      feedProductCount: cache?.product_count ?? null,
      // The last stored count (lib/feedCounts); /api/feeds/counts recounts and
      // the page swaps in the live numbers. null = never counted yet.
      includedCount: stored.get(f.id)?.included ?? null,
      excludedCount: stored.has(f.id) ? Math.max(0, stored.get(f.id)!.active - stored.get(f.id)!.included) : null,
      validationStatus: cache?.validation_status ?? null,
      validationErrors: cache?.validation_errors ?? null,
    }
  })

  return enriched
}

export type FeedListItem = Awaited<ReturnType<typeof loadFeedList>>[number]
