// How many products a feed has, and how many pass its include/exclude rules,
// as last counted (table feed_counts, migration 060).
//
// Counting runs every rule over every active product (countFilteredProducts):
// up to ~3 s on a big catalogue. So pages show the stored count at once and
// recount in the background (countAndStore), which writes the new number back.
// Both are best effort: before migration 060 nothing is stored and pages wait
// for the live count as before.

import type { SupabaseClient } from '@supabase/supabase-js'
import { adminDb } from '@/lib/feeds'
import { countFilteredProducts } from '@/lib/feedGenerator'

export type FeedCount = { active: number; included: number; countedAt: string }

/** The stored counts for these feeds (missing = never counted). */
export async function storedCounts(db: SupabaseClient, feedIds: string[]): Promise<Map<string, FeedCount>> {
  if (!feedIds.length) return new Map()
  const { data, error } = await db.from('feed_counts').select('feed_id, active, included, counted_at').in('feed_id', feedIds)
  if (error) return new Map()
  return new Map(
    ((data ?? []) as { feed_id: string; active: number; included: number; counted_at: string }[]).map((r) => [
      r.feed_id,
      { active: r.active, included: r.included, countedAt: r.counted_at },
    ])
  )
}

export async function storedCount(db: SupabaseClient, feedId: string): Promise<FeedCount | null> {
  return (await storedCounts(db, [feedId])).get(feedId) ?? null
}

/** Counts live and stores the result for the next page load. */
export async function countAndStore(feedId: string): Promise<{ total: number; included: number }> {
  const counts = await countFilteredProducts(feedId)
  const { error } = await adminDb()
    .from('feed_counts')
    .upsert({ feed_id: feedId, active: counts.total, included: counts.included, counted_at: new Date().toISOString() }, { onConflict: 'feed_id' })
  if (error && error.code !== '42P01' && error.code !== 'PGRST205') {
    console.error('[feedCounts] storing the count failed:', error.message)
  }
  return counts
}
