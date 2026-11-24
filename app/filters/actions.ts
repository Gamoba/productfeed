'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { applyFilters, type FilterConfig, type FilterRule } from '@/lib/ops/feedConfig'
import { getFeedMetafields as getFeedMetafieldsLib, type FeedMetafield } from '@/lib/optimizationBuckets'

export type { FilterConfig, FilterRule }

// The feed's metafields (namespace.key + product count + resolved definition
// name) so the Filters rule editor can offer a pick-list with readable names
// instead of mangled keys — same data the AI-Titles Scope tab already uses.
export async function getFeedMetafields(
  feedId: string
): Promise<{ data: FeedMetafield[] } | { error: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed not found' }

  return { data: await getFeedMetafieldsLib(feedId) }
}

export async function saveFilters(
  feedId: string,
  include: FilterConfig,
  exclude: FilterConfig
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed not found' }

  return applyFilters(adminDb(), { user }, feedId, include, exclude)
}
