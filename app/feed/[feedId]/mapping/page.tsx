import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import MappingClient from '@/app/mapping/MappingClient'
import { loadMasterFields } from '@/lib/masterFields'

// LAG 1 — server fetches saved mappings + feed mode (both single-row queries)
// so the user sees their existing mappings immediately. The expensive
// per-feed metafields scan and the market_url settings lookup move to LAG 2,
// fetched client-side from MappingClient after mount.
export default async function FeedMappingPage({
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

  const [mappingsRes, settingsRes, masters] = await Promise.all([
    db
      .from('feed_mappings')
      .select('google_field, mapping_type, config')
      .eq('feed_id', feedId),
    db
      .from('feed_settings')
      .select('feed_mode')
      .eq('feed_id', feedId)
      .maybeSingle(),
    feed.project_id ? loadMasterFields(db, feed.project_id) : Promise.resolve([]),
  ])

  if (mappingsRes.error) {
    console.error('Error loading mappings:', mappingsRes.error)
  }

  const feedMode = (settingsRes.data?.feed_mode as 'product' | 'variant') ?? 'product'

  return (
    <MappingClient
      feedId={feedId}
      feedMode={feedMode}
      initialMappings={mappingsRes.data ?? []}
      projectId={feed.project_id ?? ''}
      masters={masters.map((m) => ({ key: m.key, name: m.name, mapping_type: m.mapping_type, config: m.config }))}
    />
  )
}
