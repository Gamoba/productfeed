import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { FeedClient } from '@/app/feed/FeedClient'
import { REQUIRED_GOOGLE_FIELDS, type ValidationIssue, type ValidationResult } from '@/lib/feedValidator'
import { storedCount } from '@/lib/feedCounts'

// Total Google Shopping fields the mapping UI exposes ("X / TOTAL fields mapped").
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
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const db = adminDb()

  const [
    { data: settingsData },
    { data: cacheInfo },
    { data: mappedRows },
    { data: lastSyncRow },
    { data: marketRow },
    counted,
  ] = await Promise.all([
    db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
    db
      .from('feed_cache')
      .select('generated_at, product_count, validation_status, validation_errors')
      .eq('feed_id', feedId)
      .maybeSingle(),
    // Which Google fields are mapped: the count, and which required ones are not.
    db.from('feed_mappings').select('google_field').eq('feed_id', feedId).neq('mapping_type', ''),
    // Set when a sync succeeds (migration 051) — max(products.synced_at) no
    // longer moves for products that didn't change.
    db.from('feeds').select('last_synced_at').eq('id', feedId).maybeSingle(),
    // The feed's market, for the lede ("Google Shopping · Tyskland").
    db.from('shop_settings').select('selected_country').eq('feed_id', feedId).maybeSingle(),
    // The last stored included / excluded count, shown until the live recount.
    storedCount(db, feedId),
  ])

  const mapped = new Set(((mappedRows ?? []) as { google_field: string }[]).map((m) => m.google_field))
  const missingRequired = REQUIRED_GOOGLE_FIELDS.filter((f) => !mapped.has(f))

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
  // isn't persisted, so it reads as 0 here; the Overview treats that as
  // "loaded from cache" and says so under the issue list.
  const cachedStatus = cacheInfo?.validation_status as ValidationResult['status'] | null | undefined
  const cachedIssues = cacheInfo?.validation_errors as ValidationIssue[] | null | undefined
  const initialValidation: ValidationResult | null =
    cachedStatus && cachedIssues
      ? { status: cachedStatus, issues: cachedIssues, productsChecked: 0 }
      : null

  return (
    <FeedClient
      feedId={feedId}
      channel={feed.channel}
      country={(marketRow?.selected_country as string | null) ?? null}
      initialCacheInfo={cacheInfo ?? null}
      initialValidation={initialValidation}
      mappingCount={mapped.size}
      totalFields={TOTAL_GOOGLE_FIELDS}
      missingRequired={missingRequired}
      lastSynced={(lastSyncRow?.last_synced_at as string | null) ?? null}
      initialCounts={counted ? { included: counted.included, excluded: Math.max(0, counted.active - counted.included) } : null}
    />
  )
}
