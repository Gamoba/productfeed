'use server'

import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { validateFeed, type ValidationResult } from '@/lib/feedValidator'
import { adminDb, getOwnedFeed } from '@/lib/feeds'

export async function runFeedValidation(
  feedId: string
): Promise<ValidationResult | { error: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)

  if (!user) return { error: 'Not signed in' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed not found' }

  try {
    const result = await validateFeed(feedId)

    // Persist so the dashboard badge reflects the current state. Use UPDATE
    // (not upsert) — feed_cache.xml_content is NOT NULL, so we can't insert
    // a row from here. If the feed has never been generated there's nothing
    // to update, which is correct: the dashboard already shows "Ikke
    // genereret" in that case.
    const { error: updateErr } = await adminDb()
      .from('feed_cache')
      .update({
        validation_status: result.status,
        validation_errors: result.issues,
      })
      .eq('feed_id', feedId)
    if (updateErr) {
      console.error('Kunne ikke gemme validation i feed_cache:', updateErr)
    }

    return result
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown error during validation' }
  }
}
