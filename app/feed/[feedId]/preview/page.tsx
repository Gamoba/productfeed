import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { generatePreview } from '@/lib/feedGenerator'
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

  // LAG 1 — the first 20 preview rows, so the user sees content fast.
  // PreviewClient upgrades to a 100-row sample via /api/preview after mount.
  // Alongside: the small facts the "Fra kilde til kanal" pipeline shows.
  const [data, { data: cache }, { data: feedRow }, { data: project }, optimized, labels] = await Promise.all([
    generatePreview(feedId, 20),
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
  ])

  const issues = (cache?.validation_errors as ValidationIssue[] | null) ?? []
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
