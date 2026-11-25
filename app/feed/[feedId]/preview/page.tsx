import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import type { PreviewData } from '@/lib/feedGenerator'
import { storedCount } from '@/lib/feedCounts'
import type { ValidationIssue } from '@/lib/feedValidator'
import { PreviewClient, type PipelineInfo } from '@/app/preview/PreviewClient'

export default async function FeedPreviewPage({
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

  // Only small, indexed reads here, so the page renders at once. The product
  // rows (the slow part: reading products with metafields and running every
  // mapping) come from /api/preview after mount; until then the pipeline uses
  // the last generated feed's count and the mapped fields.
  const [{ data: mappedRows }, { data: settings }, { data: cache }, { data: feedRow }, { data: project }, optimized, labels, counted] = await Promise.all([
    db.from('feed_mappings').select('google_field').eq('feed_id', feedId).neq('mapping_type', ''),
    db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
    db
      .from('feed_cache')
      .select('generated_at, product_count, validation_status, validation_errors')
      .eq('feed_id', feedId)
      .maybeSingle(),
    db.from('feeds').select('last_synced_at').eq('id', feedId).maybeSingle(),
    feed.project_id
      ? db.from('projects').select('source_type').eq('id', feed.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from('product_title_optimizations')
      .select('feed_id', { count: 'exact', head: true })
      .eq('feed_id', feedId)
      .not('optimized_title', 'is', null),
    db.from('google_ads_custom_labels').select('computed_at').eq('feed_id', feedId),
    storedCount(db, feedId),
  ])

  const issues = (cache?.validation_errors as ValidationIssue[] | null) ?? []
  const data: PreviewData = {
    feedMode: (settings?.feed_mode as 'product' | 'variant' | null) === 'variant' ? 'variant' : 'product',
    rows: [],
    googleFields: ((mappedRows ?? []) as { google_field: string }[]).map((m) => m.google_field),
    // The last stored count (else the generated feed's), recounted on the client.
    totalProducts: counted?.included ?? (cache?.product_count as number | null) ?? null,
  }
  const pipeline: PipelineInfo = {
    source: (project?.source_type as string | null) === 'feed_url' ? 'feed_url' : 'shopify',
    lastSynced: (feedRow?.last_synced_at as string | null) ?? null,
    optimizedTitles: optimized.count ?? 0,
    labels: ((labels.data ?? []) as { computed_at: string | null }[]).length,
    labelsComputed: ((labels.data ?? []) as { computed_at: string | null }[]).filter((l) => l.computed_at).length,
    generatedAt: (cache?.generated_at as string | null) ?? null,
    productCount: (cache?.product_count as number | null) ?? null,
    errors: issues.filter((i) => i.type === 'error').length,
    warnings: issues.filter((i) => i.type === 'warning').length,
    validated: !!cache?.validation_status,
  }

  return <PreviewClient feedId={feedId} channel={feed.channel} data={data} pipeline={pipeline} />
}
