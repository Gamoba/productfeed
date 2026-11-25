import { redirect, notFound } from 'next/navigation'
import { createSupabaseServerClient, getSessionUser } from '@/lib/supabase-server'
import { adminDb, getOwnedFeed } from '@/lib/feeds'
import { getConnection, getFeedSettings } from '@/lib/feedGoogleAds'
import { getAvailableActions } from '@/lib/googleAdsAnalytics'
import {
  DEFAULT_ADS_SYNC_FREQUENCY,
  DEFAULT_ADS_SYNC_TIME,
  DEFAULT_AUTO_SYNC_FREQUENCY,
  DEFAULT_AUTO_SYNC_TIME,
  isAutoSyncFrequency,
} from '@/lib/syncSchedule'
import { SettingsClient, type ScheduleState } from './SettingsClient'

// Feed › Settings. Everything here applies to this feed only: where the data
// comes from, when it is fetched, which Google Ads account it is measured
// against, and which conversion actions count as revenue and profit.
export default async function FeedSettingsPage({
  params,
}: {
  params: Promise<{ feedId: string }>
}) {
  const { feedId } = await params

  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await getSessionUser(supabase)
  if (!user) redirect('/login')

  const feed = await getOwnedFeed(user.id, feedId)
  if (!feed) notFound()

  const db = adminDb()
  const [{ data: shop }, { data: feedSettings }, { data: project }, connection, ads, { data: adsSchedule }] =
    await Promise.all([
      db
        .from('shop_settings')
        .select('selected_market_id, selected_locale, selected_country, currency, market_url')
        .eq('feed_id', feedId)
        .maybeSingle(),
      db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
      feed.project_id
        ? db.from('projects').select('shop_url, source_type, feed_url').eq('id', feed.project_id).maybeSingle()
        : Promise.resolve({ data: null }),
      getConnection(db, feed.account_id),
      getFeedSettings(db, feedId),
      // Separate from getFeedSettings so a database without migration 054
      // still renders the page; the schedule row just reads as default.
      db
        .from('google_ads_feed_settings')
        .select('auto_sync_frequency, auto_sync_time, last_auto_sync_at, last_auto_sync_status, last_auto_sync_error')
        .eq('feed_id', feedId)
        .maybeSingle(),
    ])

  // Names as they are stored from the synced data, the same list Performance
  // offers, so a choice made here means the same thing there.
  const actions = ads?.customer_id ? await getAvailableActions(db, feedId, 90).catch(() => []) : []

  // getOwnedFeed selects *, so the schedule columns are already on the row.
  const row = feed as typeof feed & {
    auto_sync_frequency?: string
    auto_sync_time?: string
    last_auto_sync_at?: string | null
    last_auto_sync_status?: string | null
    last_auto_sync_error?: string | null
    last_synced_at?: string | null
  }

  const feedSchedule: ScheduleState = {
    frequency: isAutoSyncFrequency(row.auto_sync_frequency) ? row.auto_sync_frequency : DEFAULT_AUTO_SYNC_FREQUENCY,
    time: row.auto_sync_time ?? DEFAULT_AUTO_SYNC_TIME,
    lastRunAt: row.last_auto_sync_at ?? null,
    lastStatus: row.last_auto_sync_status ?? null,
    lastError: row.last_auto_sync_error ?? null,
  }
  const perfSchedule: ScheduleState = {
    frequency: isAutoSyncFrequency(adsSchedule?.auto_sync_frequency)
      ? adsSchedule.auto_sync_frequency
      : DEFAULT_ADS_SYNC_FREQUENCY,
    time: adsSchedule?.auto_sync_time ?? DEFAULT_ADS_SYNC_TIME,
    lastRunAt: adsSchedule?.last_auto_sync_at ?? null,
    lastStatus: adsSchedule?.last_auto_sync_status ?? null,
    lastError: adsSchedule?.last_auto_sync_error ?? null,
  }

  return (
    <SettingsClient
      feedId={feedId}
      projectId={feed.project_id}
      source={{
        type: project?.source_type === 'feed_url' ? 'feed_url' : 'shopify',
        // Shop domain for Shopify, the source URL for feed-URL projects.
        // Never the token: only status and address reach the client.
        address: (project?.source_type === 'feed_url' ? project?.feed_url : project?.shop_url) ?? null,
        lastSyncedAt: row.last_synced_at ?? null,
      }}
      initialShop={
        shop
          ? {
              selected_market_id: shop.selected_market_id ?? null,
              selected_locale: shop.selected_locale ?? 'en',
              selected_country: shop.selected_country ?? '',
              currency: shop.currency ?? 'USD',
              market_url: shop.market_url ?? null,
            }
          : null
      }
      initialFeedMode={(feedSettings?.feed_mode as 'product' | 'variant') ?? 'product'}
      feedSchedule={feedSchedule}
      perfSchedule={perfSchedule}
      ads={{
        hasConnection: !!connection,
        connectionError: connection?.status === 'error' ? (connection.last_error ?? 'Connection failing') : null,
        customerId: ads?.customer_id ?? null,
        customerName: ads?.customer_name ?? null,
        currencyCode: ads?.currency_code ?? null,
        feedLabel: ads?.feed_label ?? null,
        roas: ads?.roas_conversion_actions ?? [],
        poas: ads?.poas_conversion_actions ?? [],
        lastSyncedAt: ads?.last_synced_at ?? null,
        lastSyncError: ads?.last_sync_error ?? null,
      }}
      actions={actions.map((a) => ({ name: a.name, value: a.value, inWindow: a.inWindow }))}
    />
  )
}
