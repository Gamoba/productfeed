'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { clientMessage } from '@/lib/errors'
import { isAutoSyncFrequency, isAutoSyncTime } from '@/lib/syncSchedule'

export async function saveFeedMode(
  feedId: string,
  mode: 'product' | 'variant'
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed ikke fundet' }

  const db = adminDb()
  const { error } = await db
    .from('feed_settings')
    .upsert(
      { feed_id: feedId, user_id: user.id, feed_mode: mode },
      { onConflict: 'feed_id' }
    )

  if (error) return { error: error.message }
  return {}
}

export async function saveAutoSyncSchedule(
  feedId: string,
  frequency: string,
  time: string
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  if (!isAutoSyncFrequency(frequency)) return { error: 'Ugyldig frekvens' }
  if (!isAutoSyncTime(time)) return { error: 'Ugyldigt tidspunkt (HH:MM)' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed ikke fundet' }

  const { error } = await adminDb()
    .from('feeds')
    .update({ auto_sync_frequency: frequency, auto_sync_time: time })
    .eq('id', feedId)

  if (error) return { error: clientMessage(error, 'saveAutoSyncSchedule') }
  return {}
}

// Settings → Tidsplan → Hent performance (migration 054). Only for a feed that
// already has a Google Ads row: without an account there is nothing to fetch.
// Writes the schedule only — updated_at stays, since the Labels page reads it
// as "the measuring settings changed".
export async function saveGoogleAdsSchedule(
  feedId: string,
  frequency: string,
  time: string
): Promise<{ error?: string }> {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { error: 'Unauthorized' }

  if (!isAutoSyncFrequency(frequency)) return { error: 'Ugyldig frekvens' }
  if (!isAutoSyncTime(time)) return { error: 'Ugyldigt tidspunkt (HH:MM)' }

  const owned = await getOwnedFeed(user.id, feedId)
  if (!owned) return { error: 'Feed ikke fundet' }

  const { data, error } = await adminDb()
    .from('google_ads_feed_settings')
    .update({ auto_sync_frequency: frequency, auto_sync_time: time })
    .eq('feed_id', feedId)
    .select('feed_id')

  if (error) return { error: clientMessage(error, 'saveGoogleAdsSchedule') }
  if (!data?.length) return { error: 'Vælg en Google Ads-konto først' }
  return {}
}
