import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import { getOptimizationSettings } from '@/lib/titleOptimizationService'
import { listBuckets } from '@/lib/optimizationBuckets'
import { OptimizeClient } from '@/app/optimize/OptimizeClient'

export default async function FeedOptimizePage({
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

  const [settings, bucketList] = await Promise.all([
    getOptimizationSettings(feedId),
    listBuckets(feedId),
  ])

  return (
    <OptimizeClient
      feedId={feedId}
      initialSettings={settings}
      initialBuckets={bucketList}
    />
  )
}
