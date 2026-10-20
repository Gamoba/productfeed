
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createGoogleAdsClientForFeed,
  markConnectionError,
  type GoogleAdsFeedSettings,
} from '@/lib/feedGoogleAds'
import { metricNumber, gaqlDate, type GoogleAdsClient, type GoogleAdsRow } from '@/lib/googleAds'
import { detectIdPattern, parseItemId, type IdPattern } from '@/lib/googleAdsIds'
import { AppError } from '@/lib/errors'

const UPSERT_CHUNK = 500

export type SyncResult = {
  feedId: string
  from: string
  to: string
  rows: number
  conversionRows: number
  actions: string[]
  itemIds: number
  products: number
  campaigns: number
  campaignDays: number
  unmatched: number
  pattern: IdPattern | null
  patternConfidence: number
  durationMs: number
  warnings: string[]
}

type Bucket = {
  impressions: number
  clicks: number
  cost_micros: number
  conversions: number
  conversions_value: number
}

const emptyBucket = (): Bucket => ({
  impressions: 0,
  clicks: 0,
  cost_micros: 0,
  conversions: 0,
  conversions_value: 0,
})

const UNKNOWN_CAMPAIGN = 'unknown'

const SEP = '\u0000'

// ── Window ───────────────────────────────────────────────────────────────────

export function syncWindow(days: number, now = new Date()): { from: string; to: string } {
  const DAY = 86_400_000
  const to = new Date(now.getTime() - DAY)
  const from = new Date(to.getTime() - (Math.max(1, days) - 1) * DAY)
  return { from: gaqlDate(from), to: gaqlDate(to) }
}

// ── Queries ──────────────────────────────────────────────────────────────────

function feedLabelParts(feedLabel: string | null): { select: string; where: string } {
  if (!feedLabel) return { select: '', where: '' }
  const escaped = feedLabel.replace(/'/g, "\\'")
  return {
    select: ', segments.product_feed_label',
    where: ` AND segments.product_feed_label = '${escaped}'`,
  }
}

async function fetchBaseMetrics(
  client: GoogleAdsClient,
  from: string,
  to: string,
  feedLabel: string | null
): Promise<GoogleAdsRow[]> {
  const label = feedLabelParts(feedLabel)
  return client.query(
    `SELECT segments.date, segments.product_item_id,
            campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status,
            metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.conversions, metrics.conversions_value${label.select}
     FROM shopping_performance_view
     WHERE segments.date BETWEEN '${from}' AND '${to}'${label.where}`
  )
}


async function fetchCampaignTotals(
  client: GoogleAdsClient,
  from: string,
  to: string
): Promise<GoogleAdsRow[]> {
  return client.query(
    `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, campaign.status,
            segments.date,
            metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.conversions, metrics.conversions_value
     FROM campaign
     WHERE segments.date BETWEEN '${from}' AND '${to}'`
  )
}

async function fetchAllActionMetrics(
  client: GoogleAdsClient,
  from: string,
  to: string,
  feedLabel: string | null
): Promise<GoogleAdsRow[]> {
  const label = feedLabelParts(feedLabel)
  return client.query(
    `SELECT segments.date, segments.product_item_id, segments.conversion_action_name,
            campaign.id,
            metrics.all_conversions, metrics.all_conversions_value${label.select}
     FROM shopping_performance_view
     WHERE segments.date BETWEEN '${from}' AND '${to}'${label.where}`
  )
}

// ── Sync ─────────────────────────────────────────────────────────────────────

export async function syncGoogleAdsMetrics(
  db: SupabaseClient,
  feedId: string,
  options: { days?: number } = {}
): Promise<SyncResult> {
  const t0 = Date.now()
  const warnings: string[] = []

  const { client, settings, connectionId } = await createGoogleAdsClientForFeed(db, feedId)
  const days = options.days ?? settings.sync_window_days ?? 90
  const { from, to } = syncWindow(days)

  console.log(`[googleAdsSync] feed=${feedId} customer=${client.customerId} ${from}..${to}`)

  let base: GoogleAdsRow[]
  try {
    base = await fetchBaseMetrics(client, from, to, settings.feed_label)
  } catch (err) {
    if (err instanceof AppError && err.status === 401) {
      await markConnectionError(db, connectionId, err.message)
    }
    await noteSyncError(db, feedId, err)
    throw err
  }

  const rows = new Map<string, Bucket & { date: string; itemId: string; campaignId: string }>()

  const campaigns = new Map<
    string,
    { name: string | null; channelType: string | null; status: string | null }
  >()

  const noteCampaign = (r: GoogleAdsRow): string => {
    const id = String(r.campaign?.id ?? '')
    if (!id) return UNKNOWN_CAMPAIGN
    if (!campaigns.has(id)) {
      campaigns.set(id, {
        name: r.campaign?.name != null ? String(r.campaign.name) : null,
        channelType:
          r.campaign?.advertisingChannelType != null
            ? String(r.campaign.advertisingChannelType)
            : null,
        status: r.campaign?.status != null ? String(r.campaign.status) : null,
      })
    }
    return id
  }

  for (const r of base) {
    const date = String(r.segments?.date ?? '')
    const itemId = String(r.segments?.productItemId ?? '')
    if (!date || !itemId) continue
    const campaignId = noteCampaign(r)
    const k = `${date}${SEP}${itemId}${SEP}${campaignId}`
    let b = rows.get(k)
    if (!b) rows.set(k, (b = { ...emptyBucket(), date, itemId, campaignId }))
    b.impressions += metricNumber(r.metrics?.impressions)
    b.clicks += metricNumber(r.metrics?.clicks)
    b.cost_micros += metricNumber(r.metrics?.costMicros)
    b.conversions += metricNumber(r.metrics?.conversions)
    b.conversions_value += metricNumber(r.metrics?.conversionsValue)
  }

  // ── Conversions, per action ────────────────────────────────────────────────
  const convByKey = new Map<
    string,
    {
      date: string
      itemId: string
      campaignId: string
      action: string
      conversions: number
      value: number
    }
  >()
  const actionNames = new Set<string>()
  try {
    for (const r of await fetchAllActionMetrics(client, from, to, settings.feed_label)) {
      const date = String(r.segments?.date ?? '')
      const itemId = String(r.segments?.productItemId ?? '')
      const action = String(r.segments?.conversionActionName ?? '')
      if (!date || !itemId || !action) continue
      const campaignId = noteCampaign(r)
      actionNames.add(action)
      const k = `${date}${SEP}${itemId}${SEP}${campaignId}${SEP}${action}`
      let cur = convByKey.get(k)
      if (!cur) {
        convByKey.set(k, (cur = { date, itemId, campaignId, action, conversions: 0, value: 0 }))
      }
      cur.conversions += metricNumber(r.metrics?.allConversions)
      cur.value += metricNumber(r.metrics?.allConversionsValue)
    }
  } catch (err) {
    warnings.push(
      `Could not fetch conversions per action: ${err instanceof Error ? err.message : 'unknown error'}`
    )
  }

  if (!actionNames.size && rows.size) {
    warnings.push('No conversion data in this period — ROAS and POAS cannot be calculated.')
  }

  const itemIds = [...new Set([...rows.values()].map((b) => b.itemId))]
  const detection = detectIdPattern(itemIds)
  const pattern: IdPattern | null =
    settings.id_pattern && settings.id_pattern !== 'auto'
      ? (settings.id_pattern as IdPattern)
      : detection.pattern

  if (!pattern && itemIds.length) {
    warnings.push('Could not determine the item ID format — products cannot be matched to the catalogue.')
  } else if (detection.confidence < 0.9 && itemIds.length) {
    warnings.push(
      `The item ID format is ambiguous (${Math.round(detection.confidence * 100)}% match ${pattern}).`
    )
  }

  const records: Record<string, unknown>[] = []
  let unmatched = 0
  const products = new Set<string>()
  const now = new Date().toISOString()

  const unmatchedItems = new Set<string>()

  for (const b of rows.values()) {
    const parsed = pattern ? parseItemId(b.itemId, pattern) : null
    if (!parsed) unmatchedItems.add(b.itemId)
    else products.add(parsed.productRef)

    records.push({
      feed_id: feedId,
      date: b.date,
      item_id: b.itemId,
      campaign_id: b.campaignId,
      product_ref: parsed?.productRef ?? null,
      variant_ref: parsed?.variantRef ?? null,
      impressions: b.impressions,
      clicks: b.clicks,
      cost_micros: b.cost_micros,
      conversions: b.conversions,
      conversions_value: b.conversions_value,
      synced_at: now,
    })
  }
  unmatched = unmatchedItems.size

  const convRecords: Record<string, unknown>[] = []
  for (const v of convByKey.values()) {
    convRecords.push({
      feed_id: feedId,
      date: v.date,
      item_id: v.itemId,
      campaign_id: v.campaignId,
      conversion_action: v.action,
      conversions: v.conversions,
      conversions_value: v.value,
      synced_at: now,
    })
  }

  // ── Campaign totals ────────────────────────────────────────────────────────
  const campaignRecords: Record<string, unknown>[] = []
  if (settings.feed_label) {
    warnings.push(
      `This feed is scoped to the «${settings.feed_label}» feed label, so campaign-level ` +
        'totals cannot be attributed to it. Campaign figures show only the spend Google ' +
        'attributed to products in this feed.'
    )
  } else {
    try {
      for (const r of await fetchCampaignTotals(client, from, to)) {
        const date = String(r.segments?.date ?? '')
        const campaignId = noteCampaign(r)
        if (!date || campaignId === UNKNOWN_CAMPAIGN) continue
        campaignRecords.push({
          feed_id: feedId,
          date,
          campaign_id: campaignId,
          impressions: metricNumber(r.metrics?.impressions),
          clicks: metricNumber(r.metrics?.clicks),
          cost_micros: metricNumber(r.metrics?.costMicros),
          conversions: metricNumber(r.metrics?.conversions),
          conversions_value: metricNumber(r.metrics?.conversionsValue),
          synced_at: now,
        })
      }
    } catch (err) {
      warnings.push(
        `Could not fetch campaign totals: ${err instanceof Error ? err.message : 'unknown error'}`
      )
    }
  }

  const campaignRows = [...campaigns].map(([campaignId, c]) => ({
    feed_id: feedId,
    campaign_id: campaignId,
    name: c.name,
    channel_type: c.channelType,
    status: c.status,
    synced_at: now,
  }))

  await upsertChunked(db, 'google_ads_campaigns', campaignRows, 'feed_id,campaign_id', feedId)

  await upsertChunked(
    db,
    'google_ads_product_daily',
    records,
    'feed_id,date,item_id,campaign_id',
    feedId
  )
  await upsertChunked(
    db,
    'google_ads_product_conversions',
    convRecords,
    'feed_id,date,item_id,campaign_id,conversion_action',
    feedId
  )
  await upsertChunked(
    db,
    'google_ads_campaign_daily',
    campaignRecords,
    'feed_id,date,campaign_id',
    feedId
  )

  await clearSentinelRows(db, feedId, from, to)

  await db
    .from('google_ads_feed_settings')
    .update({
      last_synced_at: now,
      last_sync_error: null,
      ...(settings.id_pattern === 'auto' && pattern
        ? { id_pattern: pattern, id_pattern_country: detection.country }
        : {}),
      updated_at: now,
    })
    .eq('feed_id', feedId)

  return {
    feedId,
    from,
    to,
    rows: records.length,
    conversionRows: convRecords.length,
    actions: [...actionNames].sort(),
    itemIds: itemIds.length,
    products: products.size,
    campaigns: campaigns.size,
    campaignDays: new Set(campaignRecords.map((r) => r.date as string)).size,
    unmatched,
    pattern,
    patternConfidence: detection.confidence,
    durationMs: Date.now() - t0,
    warnings,
  }
}

async function upsertChunked(
  db: SupabaseClient,
  table: string,
  records: Record<string, unknown>[],
  onConflict: string,
  feedId: string
): Promise<void> {
  for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from(table)
      .upsert(records.slice(i, i + UPSERT_CHUNK), { onConflict })
    if (error) {
      await noteSyncError(db, feedId, error)
      throw new Error(`Could not save Google Ads data (${table}): ${error.message}`)
    }
  }
}

async function clearSentinelRows(
  db: SupabaseClient,
  feedId: string,
  from: string,
  to: string
): Promise<void> {
  for (const table of ['google_ads_product_daily', 'google_ads_product_conversions']) {
    const { error } = await db
      .from(table)
      .delete()
      .eq('feed_id', feedId)
      .eq('campaign_id', '')
      .gte('date', from)
      .lte('date', to)
    if (error) {
      console.error(`[googleAdsSync] sentinel cleanup failed on ${table}:`, error.message)
    }
  }
}

async function noteSyncError(db: SupabaseClient, feedId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  await db
    .from('google_ads_feed_settings')
    .update({ last_sync_error: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq('feed_id', feedId)
}

// ── Settings guard ───────────────────────────────────────────────────────────

export function missingSetup(s: GoogleAdsFeedSettings | null): string[] {
  if (!s) return ['Google Ads is not set up for this feed.']
  const missing: string[] = []
  if (!s.connection_id) missing.push('No Google Ads connection.')
  if (!s.customer_id) missing.push('No Google Ads account selected.')
  return missing
}
