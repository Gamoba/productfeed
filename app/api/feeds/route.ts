import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { getAccessibleProjectIds } from '@/lib/accounts'
import { errorResponse } from '@/lib/errors'
import { storedCounts } from '@/lib/feedCounts'
import { logActivity } from '@/lib/activity'
import { channelOf } from '@/lib/channels'
import type { ValidationIssue } from '@/lib/feedValidator'
import { channelAvailability, isChannelId, type ChannelId } from '@/lib/channels'

export async function GET(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = adminDb()

  // Optional ?projectId scopes the list to one project (project home page).
  // Always limited to projects in the user's accounts, so the project filter
  // only narrows further.
  const projectId = new URL(req.url).searchParams.get('projectId')
  let projectIds: string[]
  try {
    projectIds = await getAccessibleProjectIds(db, user.id)
  } catch (err) {
    return errorResponse(err, 'GET /api/feeds projects')
  }
  if (projectId) projectIds = projectIds.filter((id) => id === projectId)
  if (projectIds.length === 0) return NextResponse.json({ feeds: [] })

  const feedsQuery = db
    .from('feeds')
    .select('id, name, description, project_id, channel, created_at, updated_at, last_synced_at')
    .in('project_id', projectIds)

  const { data: feeds, error: feedsErr } = await feedsQuery.order('created_at', {
    ascending: true,
  })

  if (feedsErr) {
    return NextResponse.json({ error: feedsErr.message }, { status: 500 })
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
    return errorResponse(err, 'GET /api/feeds dashboard data')
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

  return NextResponse.json({ feeds: enriched })
}

export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    name?: string
    description?: string
    project_id?: string
    // Which channel the feed is for (lib/channels.ts). Defaults to Google
    // Shopping, which is what every feed was before channels existed.
    channel?: string
    // The market's country, when known, to check the channel may be used there.
    country?: string | null
  }
  const name = (body.name ?? '').trim()
  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  const channel = body.channel ?? 'google_shopping'
  if (!isChannelId(channel)) {
    return NextResponse.json({ error: 'Ukendt kanal' }, { status: 400 })
  }
  const availability = channelAvailability(channel, body.country)
  if (!availability.available) {
    return NextResponse.json({ error: availability.reason }, { status: 400 })
  }

  // A feed hangs on a project — project_id is required and must be owned.
  if (!body.project_id) {
    return NextResponse.json({ error: 'project_id er påkrævet' }, { status: 400 })
  }
  const owned = await getOwnedProject(user.id, body.project_id)
  if (!owned) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  const projectId = owned.id

  const db = adminDb()
  const { data, error } = await db
    .from('feeds')
    .insert({
      user_id: user.id,
      name,
      description: body.description?.trim() || null,
      project_id: projectId,
      channel,
    })
    .select('id, name, description, project_id, channel, created_at, updated_at')
    .single()

  if (error) return errorResponse(error, 'POST /api/feeds')

  await logActivity(db, { user, feedId: data.id, area: 'Feed', action: 'Feed oprettet', after: `${channelOf(channel).label} · ${name}` })
  return NextResponse.json({ feed: data })
}
