import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { getOwnedFeed } from '@/lib/feeds'
import { getBucket, getBucketFilters } from '@/lib/optimizationBuckets'
import { BucketEditorClient } from '@/app/optimize/BucketEditorClient'

export default async function BucketEditorPage({
  params,
}: {
  params: Promise<{ feedId: string; bucketId: string }>
}) {
  const { feedId, bucketId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const bucket = await getBucket(feedId, bucketId)
  if (!bucket) notFound()

  const filters = await getBucketFilters(bucketId)

  return (
    <BucketEditorClient
      feedId={feedId}
      bucketId={bucket.id}
      bucketName={bucket.name}
      initialInclude={filters.include}
      initialExclude={filters.exclude}
    />
  )
}
