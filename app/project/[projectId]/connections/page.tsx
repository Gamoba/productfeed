import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { getConnection } from '@/lib/feedGoogleAds'
import { ConnectionsClient, type ConnectionsState } from './ConnectionsClient'

// Shop › Connections. Everything the shop can be linked to. What works today
// carries its real status and action; the rest is listed as planned.
export default async function ConnectionsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  const db = adminDb()
  const [ads, { data: feeds }] = await Promise.all([
    getConnection(db, project.account_id),
    db.from('feeds').select('*').eq('project_id', projectId),
  ])

  // select('*') so a database without migration 053 (feeds.channel) still
  // renders; such feeds count as Google Shopping, as everywhere else.
  const feedRows = (feeds ?? []) as { id: string; channel?: string | null }[]
  const { data: adsFeeds } = feedRows.length
    ? await db
        .from('google_ads_feed_settings')
        .select('feed_id')
        .in('feed_id', feedRows.map((f) => f.id))
        .not('customer_id', 'is', null)
    : { data: [] }
  const channels: Record<string, number> = {}
  for (const f of feedRows) {
    const c = f.channel ?? 'google_shopping'
    channels[c] = (channels[c] ?? 0) + 1
  }

  const state: ConnectionsState = {
    projectId,
    source: project.source_type === 'feed_url' ? 'feed_url' : 'shopify',
    // Status and address only; the token never leaves the server.
    shopUrl: project.shop_url,
    feedUrl: project.feed_url,
    status: project.connection_status,
    lastVerifiedAt: project.last_verified_at,
    googleAds: ads ? { status: ads.status, label: ads.account_label } : null,
    adsFeeds: (adsFeeds ?? []).length,
    feeds: feedRows.length,
    channels,
  }

  return <ConnectionsClient initial={state} />
}
