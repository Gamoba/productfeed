import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedProject } from '@/lib/feeds'
import { loadFeedList } from '@/lib/feedList'
import { ShopFeedsClient } from './ShopFeedsClient'

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const project = await getOwnedProject(user.id, projectId)
  if (!project) notFound()

  // The list comes with the page (no second request from the browser). On a
  // failure the client fetches it itself, as before.
  const initialFeeds = await loadFeedList(adminDb(), [project.id]).catch(() => null)

  return (
    <ShopFeedsClient
      projectId={project.id}
      projectName={project.name}
      shopUrl={project.shop_url}
      sourceType={project.source_type ?? 'shopify'}
      feedUrl={project.feed_url}
      connectionStatus={project.connection_status}
      lastVerifiedAt={project.last_verified_at}
      initialFeeds={initialFeeds}
    />
  )
}
