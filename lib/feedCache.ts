import { generateFeed } from '@/lib/feedGenerator'
import { validateFeed, type ValidationResult } from '@/lib/feedValidator'
import { adminDb } from '@/lib/feeds'
import { dbError } from '@/lib/errors'

export type RegeneratedFeed = {
  generated_at: string
  product_count: number
  validation_status: ValidationResult['status'] | null
  validation_errors: ValidationResult['issues'] | null
}

// Builds the feed XML from the synced products, validates it, and stores both
// in feed_cache — the row the public feed URL serves. Shared by the manual
// "regenerate" button and the scheduled sync, so the two can't drift.
export async function regenerateFeedCache(feedId: string): Promise<RegeneratedFeed> {
  const [{ xml, productCount }, validation] = await Promise.all([
    generateFeed(feedId),
    validateFeed(feedId).catch((err) => {
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
