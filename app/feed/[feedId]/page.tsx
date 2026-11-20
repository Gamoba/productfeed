import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { FeedClient } from '@/app/feed/FeedClient'
import type { ValidationIssue, ValidationResult } from '@/lib/feedValidator'

// Total Google Shopping fields the mapping UI exposes. Drives the progress
// bar in the status overview ("X of TOTAL_GOOGLE_FIELDS fields mapped").
const TOTAL_GOOGLE_FIELDS = 39

// LAG 1 — server fetches everything except the slow paginated
// countFilteredProducts call. Per-feed included/excluded counts are
// computed client-side via /api/feeds/[feedId]/counts so the overview
// renders immediately.
export default async function FeedDetailPage({
  params,
}: {
  params: Promise<{ feedId: string }>
}) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const db = adminDb()

  const [
    { data: settingsData },
    { data: cacheInfo },
    mappingsCountRes,
    { data: lastSyncRow },
    optimizedCountRes,
  ] = await Promise.all([
    db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
    db
      .from('feed_cache')
      .select('generated_at, product_count, validation_status, validation_errors')
      .eq('feed_id', feedId)
      .maybeSingle(),
    db
      .from('feed_mappings')
      .select('feed_id', { count: 'exact', head: true })
      .eq('feed_id', feedId)
      .neq('mapping_type', ''),
    // Set when a sync succeeds (migration 051) — max(products.synced_at) no
    // longer moves for products that didn't change.
    db.from('feeds').select('last_synced_at').eq('id', feedId).maybeSingle(),
    // Optimized-title count for the AI Titles card (rows with an applied title).
    db
      .from('product_title_optimizations')
      .select('feed_id', { count: 'exact', head: true })
      .eq('feed_id', feedId)
      .not('optimized_title', 'is', null),
  ])

  // Auto-insert default feed_settings row if missing — keeps the invariant
  // that every feed has a settings row before downstream pages need it.
  if (!settingsData) {
    await db.from('feed_settings').insert({
      feed_id: feedId,
      user_id: user.id,
      feed_mode: 'product',
    })
  }

  // Reconstruct a ValidationResult from the cached columns. productsChecked
  // isn't persisted, so it reads as 0 here; FeedValidation treats that as
  // "loaded from cache" and adjusts its subtitle accordingly.
  const cachedStatus = cacheInfo?.validation_status as ValidationResult['status'] | null | undefined
  const cachedIssues = cacheInfo?.validation_errors as ValidationIssue[] | null | undefined
  const initialValidation: ValidationResult | null =
    cachedStatus && cachedIssues
      ? { status: cachedStatus, issues: cachedIssues, productsChecked: 0 }
      : null

  return (
    <FeedClient
      feedId={feedId}
      feedName={feed.name}
      initialCacheInfo={cacheInfo ?? null}
      initialValidation={initialValidation}
      mappingCount={mappingsCountRes.count ?? 0}
      totalFields={TOTAL_GOOGLE_FIELDS}
      lastSynced={(lastSyncRow?.last_synced_at as string | null) ?? null}
      optimizedCount={optimizedCountRes.count ?? 0}
    />
  )
}
