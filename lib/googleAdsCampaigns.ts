import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import {
  derive,
  windowRange,
  type ActionChoice,
  type DateRange,
  type Derived,
  NO_ACTIONS,
} from '@/lib/googleAdsAnalytics'

export const SENTINEL_CAMPAIGN = ''

export const UNKNOWN_CAMPAIGN = 'unknown'

type RawTotals = {
  impressions: number
  clicks: number
  cost: number
  conversions: number
  conversions_value: number
  roas_conversions: number
  roas_value: number
  poas_conversions: number
  poas_value: number
}

export type CampaignRow = RawTotals &
  Derived & {
    campaignId: string
    name: string | null
    channelType: string | null
    status: string | null
    products: number
    items: number
    totalCost: number | null
    totalClicks: number | null
    totalImpressions: number | null
    totalConversions: number | null
    coverage: number | null
    isSentinel: boolean
    isUnknown: boolean
  }

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function rawFrom(r: Record<string, unknown>): RawTotals {
  return {
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    cost: num(r.cost),
    conversions: num(r.conversions),
    conversions_value: num(r.conversions_value),
    roas_conversions: num(r.roas_conversions),
    roas_value: num(r.roas_value),
    poas_conversions: num(r.poas_conversions),
    poas_value: num(r.poas_value),
  }
}

/**
 * How a campaign's channel type reads to a person.
 *
 * Unknown values pass through rather than being mapped to "Other": Google adds
 * channel types, and a raw PERFORMANCE_MAX_something is more useful than a
 * bucket that hides it.
 */
export function describeChannel(type: string | null): string {
  if (!type) return 'Unknown type'
  const known: Record<string, string> = {
    SHOPPING: 'Shopping',
    PERFORMANCE_MAX: 'Performance Max',
    SEARCH: 'Search',
    DISPLAY: 'Display',
    VIDEO: 'Video',
    DEMAND_GEN: 'Demand Gen',
    MULTI_CHANNEL: 'Multi-channel',
  }
  return known[type] ?? type.replace(/_/g, ' ').toLowerCase()
}

export async function getCampaignPerformance(
  db: SupabaseClient,
  feedId: string,
  days: number,
  actions: ActionChoice = NO_ACTIONS,
  range?: DateRange
): Promise<{ rows: CampaignRow[]; from: string; to: string }> {
  const { from, to } = range ?? windowRange(days)

  const { data, error } = await db.rpc('google_ads_campaign_summary', {
    p_feed_id: feedId,
    p_from: from,
    p_to: to,
    p_roas_actions: actions.roas,
    p_poas_actions: actions.poas,
  })
  if (error) dbError('getCampaignPerformance', error)

  const poasTracked = actions.poas.length > 0

  const rows: CampaignRow[] = ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const raw = rawFrom(r)
    const campaignId = String(r.campaign_id ?? '')
    const totalCost = numOrNull(r.total_cost)

    return {
      ...raw,
      ...derive(raw, poasTracked),
      campaignId,
      name: (r.name as string | null) ?? null,
      channelType: (r.channel_type as string | null) ?? null,
      status: (r.status as string | null) ?? null,
      products: num(r.products),
      items: num(r.items),
      totalCost,
      totalClicks: numOrNull(r.total_clicks),
      totalImpressions: numOrNull(r.total_impressions),
      totalConversions: numOrNull(r.total_conversions),
      coverage: totalCost === null || totalCost <= 0 ? null : raw.cost / totalCost,
      isSentinel: campaignId === SENTINEL_CAMPAIGN,
      isUnknown: campaignId === UNKNOWN_CAMPAIGN,
    }
  })

  // Largest real spend first, but a campaign with no attributable spend still
  // sorts on what it actually cost - otherwise a PMax campaign burning budget
  // with nothing reaching this feed's products would sit at the bottom, which
  // is the opposite of where it belongs.
  rows.sort((a, b) => Math.max(b.cost, b.totalCost ?? 0) - Math.max(a.cost, a.totalCost ?? 0))

  return { rows, from, to }
}

export type ProductCampaignRow = RawTotals &
  Derived & {
    productRef: string | null
    campaignId: string
    name: string | null
    channelType: string | null
  }

/**
 * The per-(product, campaign) split.
 *
 * With `productRef` null this returns the whole feed in one query, which is how
 * the campaign COUNT per product is obtained without a request per row.
 */
export async function getProductCampaigns(
  db: SupabaseClient,
  feedId: string,
  days: number,
  productRef: string | null = null,
  actions: ActionChoice = NO_ACTIONS,
  range?: DateRange
): Promise<ProductCampaignRow[]> {
  const { from, to } = range ?? windowRange(days)

  const { data, error } = await db.rpc('google_ads_product_campaigns', {
    p_feed_id: feedId,
    p_from: from,
    p_to: to,
    p_product_ref: productRef,
    p_roas_actions: actions.roas,
    p_poas_actions: actions.poas,
  })
  if (error) dbError('getProductCampaigns', error)

  const poasTracked = actions.poas.length > 0

  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const raw = rawFrom(r)
    return {
      ...raw,
      ...derive(raw, poasTracked),
      productRef: (r.product_ref as string | null) ?? null,
      campaignId: String(r.campaign_id ?? ''),
      name: (r.name as string | null) ?? null,
      channelType: (r.channel_type as string | null) ?? null,
    }
  })
}

export type Overlap = {
  productRef: string
  campaigns: { campaignId: string; name: string | null; channelType: string | null; cost: number }[]
  totalCost: number
}

/**
 * Products that took spend from more than one campaign in the window.
 *
 * SENTINEL AND UNKNOWN ROWS ARE EXCLUDED, because pairing a real campaign with
 * "history from before campaigns were recorded" is not an overlap — it is the
 * same spend described twice at different times, and reporting it would make
 * every product look cannibalised for one sync cycle after the migration.
 *
 * Campaigns with zero cost are ignored too: an impression served with no click
 * and no spend is not a budget competing for the same product.
 */
export function findOverlaps(rows: ProductCampaignRow[]): Overlap[] {
  const byProduct = new Map<string, Overlap>()

  for (const r of rows) {
    if (!r.productRef) continue
    if (r.campaignId === SENTINEL_CAMPAIGN || r.campaignId === UNKNOWN_CAMPAIGN) continue
    if (r.cost <= 0) continue

    let o = byProduct.get(r.productRef)
    if (!o) byProduct.set(r.productRef, (o = { productRef: r.productRef, campaigns: [], totalCost: 0 }))
    o.campaigns.push({
      campaignId: r.campaignId,
      name: r.name,
      channelType: r.channelType,
      cost: r.cost,
    })
    o.totalCost += r.cost
  }

  return [...byProduct.values()]
    .filter((o) => o.campaigns.length > 1)
    .map((o) => ({ ...o, campaigns: o.campaigns.sort((a, b) => b.cost - a.cost) }))
    .sort((a, b) => b.totalCost - a.totalCost)
}
