import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { FiltersClient } from '@/app/filters/FiltersClient'
import { loadMasterFields } from '@/lib/masterFields'

export default async function FeedFiltersPage({
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

  const [{ data: filters }, masters] = await Promise.all([
    db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId),
    feed.project_id ? loadMasterFields(db, feed.project_id) : Promise.resolve([]),
  ])

  const includeRow = filters?.find((f) => f.filter_type === 'include')
  const excludeRow = filters?.find((f) => f.filter_type === 'exclude')

  return (
    <FiltersClient
      feedId={feedId}
      masters={masters.map((m) => ({ key: m.key, name: m.name }))}
      initialInclude={
        includeRow
          ? { operator: includeRow.operator as 'AND' | 'OR', rules: includeRow.rules ?? [] }
          : null
      }
      initialExclude={
        excludeRow
          ? { operator: excludeRow.operator as 'AND' | 'OR', rules: excludeRow.rules ?? [] }
          : null
      }
    />
  )
}
