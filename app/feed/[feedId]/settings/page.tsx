import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { SettingsClient } from '@/app/settings/SettingsClient'
import {
  DEFAULT_AUTO_SYNC_FREQUENCY,
  DEFAULT_AUTO_SYNC_TIME,
  isAutoSyncFrequency,
} from '@/lib/syncSchedule'

export default async function FeedSettingsPage({
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
  const [{ data: settings }, { data: feedSettings }] = await Promise.all([
    db
      .from('shop_settings')
      .select('selected_market_id, selected_locale, selected_country, currency, market_url')
      .eq('feed_id', feedId)
      .maybeSingle(),
    db
      .from('feed_settings')
      .select('feed_mode')
      .eq('feed_id', feedId)
      .maybeSingle(),
  ])

  // getOwnedFeed selects *, so the schedule columns are already on the row.
  const schedule = feed as typeof feed & {
    auto_sync_frequency?: string
    auto_sync_time?: string
    last_auto_sync_at?: string | null
    last_auto_sync_status?: string | null
    last_auto_sync_error?: string | null
  }

  const initialFeedMode = (feedSettings?.feed_mode as 'product' | 'variant') ?? 'product'

  return (
    <SettingsClient
      feedId={feedId}
      feedName={feed.name}
      projectId={feed.project_id}
      initialSettings={
        settings
          ? {
              selected_market_id: settings.selected_market_id ?? null,
              selected_locale: settings.selected_locale ?? 'en',
              selected_country: settings.selected_country ?? 'US',
              currency: settings.currency ?? 'USD',
              market_url: settings.market_url ?? null,
            }
          : null
      }
      initialFeedMode={initialFeedMode}
      initialAutoSync={{
        frequency: isAutoSyncFrequency(schedule.auto_sync_frequency)
          ? schedule.auto_sync_frequency
          : DEFAULT_AUTO_SYNC_FREQUENCY,
        time: schedule.auto_sync_time ?? DEFAULT_AUTO_SYNC_TIME,
        lastRunAt: schedule.last_auto_sync_at ?? null,
        lastStatus: schedule.last_auto_sync_status ?? null,
        lastError: schedule.last_auto_sync_error ?? null,
      }}
    />
  )
}
