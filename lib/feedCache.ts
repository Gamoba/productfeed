import { generateFeed, loadFeedProducts } from '@/lib/feedGenerator'
import { validateFeed, type ValidationResult } from '@/lib/feedValidator'
import { adminDb } from '@/lib/feeds'
import { dbError } from '@/lib/errors'

export type RegeneratedFeed = {
  generated_at: string
  product_count: number
  validation_status: ValidationResult['status'] | null
  validation_errors: ValidationResult['issues'] | null
}

/**
 * How long the public feed URL serves a stored XML before building it again
 * (app/api/feed/generate/[feedId]). Building a big feed takes the better part
 * of a minute, so the cache is what Merchant Center actually reads.
 */
export const FEED_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * When the scheduled sync rebuilds a cache it hasn't had to touch. Shorter
 * than the TTL, so the stored XML is renewed by a background run instead of
 * by Merchant Center waiting for one.
 */
export const FEED_CACHE_REFRESH_MS = 5 * 60 * 60 * 1000

/** How old the stored XML is, or null when there is none. */
export async function feedCacheAgeMs(feedId: string): Promise<number | null> {
  const { data, error } = await adminDb()
    .from('feed_cache')
    .select('generated_at')
    .eq('feed_id', feedId)
    .maybeSingle<{ generated_at: string | null }>()
  if (error) {
    // Treat a lookup failure as "no cache": rebuilding is the safe answer.
    console.error('[feedCache] could not read the cache age:', error.message)
    return null
  }
  if (!data?.generated_at) return null
  return Date.now() - new Date(data.generated_at).getTime()
}

// Builds the feed XML from the synced products, validates it, and stores both
// in feed_cache — the row the public feed URL serves. Shared by the manual
// "regenerate" button and the scheduled sync, so the two can't drift.
export async function regenerateFeedCache(feedId: string): Promise<RegeneratedFeed> {
  // One catalogue read shared by both — they used to load it separately.
  const products = await loadFeedProducts(feedId)
  const [{ xml, productCount }, validation] = await Promise.all([
    generateFeed(feedId, { products }),
    validateFeed(feedId, { products }).catch((err) => {
      console.error('Validation failed during feed regeneration:', err)
      return null as ValidationResult | null
    }),
  ])
  const generatedAt = new Date().toISOString()

  const result: RegeneratedFeed = {
    generated_at: generatedAt,
    product_count: productCount,
    validation_status: validation?.status ?? null,
    validation_errors: validation?.issues ?? null,
  }

  const { error } = await adminDb()
    .from('feed_cache')
    .upsert({ feed_id: feedId, xml_content: xml, ...result }, { onConflict: 'feed_id' })
  if (error) dbError('regenerateFeedCache upsert', error)

  return result
}
