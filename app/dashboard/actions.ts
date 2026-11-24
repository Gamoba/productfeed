'use server'

import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { clientMessage } from '@/lib/errors'
import { AUTO_SYNC_LABELS, isAutoSyncFrequency, isAutoSyncTime, type AutoSyncFrequency } from '@/lib/syncSchedule'
import { logActivity } from '@/lib/activity'

const MODE_LABEL = { product: 'Pr. vare', variant: 'Pr. variant' } as const
const schedule = (f: string | null | undefined, t: string | null | undefined) =>
  f ? (f === 'off' ? AUTO_SYNC_LABELS.off : `${AUTO_SYNC_LABELS[f as AutoSyncFrequency] ?? f} kl. ${t ?? '?'}`) : null

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
  const { data: prev } = await db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle()
  const { error } = await db
    .from('feed_settings')
    .upsert(
      { feed_id: feedId, user_id: user.id, feed_mode: mode },
      { onConflict: 'feed_id' }
    )

  if (error) return { error: error.message }
  const before = (prev?.feed_mode as 'product' | 'variant' | undefined) ?? 'product'
  if (before !== mode) {
    await logActivity(db, { user, feedId, area: 'Settings', action: 'Niveau ændret', before: MODE_LABEL[before], after: MODE_LABEL[mode] })
  }
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

  const db = adminDb()
  const { error } = await db
    .from('feeds')
    .update({ auto_sync_frequency: frequency, auto_sync_time: time })
    .eq('id', feedId)

  if (error) return { error: clientMessage(error, 'saveAutoSyncSchedule') }
  const o = owned as { auto_sync_frequency?: string; auto_sync_time?: string }
  await logActivity(db, {
    user,
    feedId,
    area: 'Settings',
    action: 'Tidsplan for feedet ændret',
    before: schedule(o.auto_sync_frequency, o.auto_sync_time),
    after: schedule(frequency, time),
  })
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

  const db = adminDb()
  const { data: prev } = await db
    .from('google_ads_feed_settings')
    .select('auto_sync_frequency, auto_sync_time')
    .eq('feed_id', feedId)
    .maybeSingle()
  const { data, error } = await db
    .from('google_ads_feed_settings')
    .update({ auto_sync_frequency: frequency, auto_sync_time: time })
    .eq('feed_id', feedId)
    .select('feed_id')

  if (error) return { error: clientMessage(error, 'saveGoogleAdsSchedule') }
  if (!data?.length) return { error: 'Vælg en Google Ads-konto først' }
  await logActivity(db, {
    user,
    feedId,
    area: 'Settings',
    action: 'Tidsplan for performance ændret',
    before: schedule(prev?.auto_sync_frequency, prev?.auto_sync_time),
    after: schedule(frequency, time),
  })
  return {}
}
