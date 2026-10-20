// Cost of goods per variant, and the product margins derived from it.
//
// THE RULE THAT SHAPES THIS FILE: an unentered cost is not a cost of zero.
//
// A merchant who has never filled in "Cost per item" has an unknown margin. If
// that rendered as 100% margin, every un-costed product would sort to the top of
// any "most profitable" view and straight into a bidding-up bucket. So unit_cost
// is nullable end to end, margin is null unless something is actually known, and
// every surface reports coverage alongside the number.
//
// Cost sync is separate from product sync on purpose: cost lives on
// inventoryItem (GraphQL only, not in the REST product payload) and changes on a
// different rhythm than the catalogue.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import { AppError, dbError } from '@/lib/errors'

const UPSERT_CHUNK = 500

export type CostSyncResult = {
  products: number
  variants: number
  /** Variants where Shopify actually returned a cost. */
  costed: number
  durationMs: number
}

/** Pulls "Cost per item" for every variant in the feed and stores it. */
export async function syncVariantCosts(
  db: SupabaseClient,
  feedId: string
): Promise<CostSyncResult> {
  const t0 = Date.now()

  const { data: feedRow } = await db
    .from('feeds')
    .select('project_id')
    .eq('id', feedId)
    .maybeSingle()
  const projectId = (feedRow as { project_id: string | null } | null)?.project_id ?? null
  if (!projectId) throw new AppError('This feed has no project, so Shopify cannot be reached.')

  // Paged, because a large catalogue exceeds PostgREST's default row cap and a
  // silently truncated product list would silently truncate the cost data.
  const productIds: number[] = []
  const PAGE = 1000
  for (let page = 0; ; page++) {
    const { data, error } = await db
      .from('products')
      .select('shopify_id')
      .eq('feed_id', feedId)
      .order('shopify_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) dbError('syncVariantCosts/products', error)
    const rows = (data ?? []) as { shopify_id: string }[]
    for (const r of rows) {
      const n = Number(r.shopify_id)
      if (Number.isFinite(n)) productIds.push(n)
    }
    if (rows.length < PAGE) break
  }

  if (!productIds.length) {
    return { products: 0, variants: 0, costed: 0, durationMs: Date.now() - t0 }
  }

  const shopify = await createShopifyClientForProject(db, projectId)
  const costs = await shopify.fetchVariantCostsBulk(productIds)

  const now = new Date().toISOString()
  const rows = costs.map((c) => ({
    feed_id: feedId,
    product_ref: String(c.productId),
    variant_ref: String(c.variantId),
    unit_cost: c.unitCost,
    currency: c.currency,
    synced_at: now,
  }))

  // Upsert rather than replace: a batch that failed inside fetchVariantCostsBulk
  // returns no rows for those variants, and wiping first would turn a partial
  // fetch into deleted data. Stale beats missing here.
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from('variant_costs')
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: 'feed_id,variant_ref' })
    if (error) dbError('syncVariantCosts/upsert', error)
  }

  return {
    products: productIds.length,
    variants: rows.length,
    costed: rows.filter((r) => r.unit_cost !== null).length,
    durationMs: Date.now() - t0,
  }
}

// ── Margins ──────────────────────────────────────────────────────────────────

/**
 * What basis the prices are on, so cost can be compared against like.
 *
 * Shopify stores one price per variant and the shop decides whether it carries
 * VAT; "Cost per item" is what a supplier invoiced, which is net. Netting the
 * price down is the only way the subtraction means anything. Null = nobody has
 * told us yet, and we do not guess — see migration 040.
 */
export type VatBasis = { pricesIncludeVat: boolean; rate: number } | null

export type ProductMargin = {
  productRef: string
  variantsTotal: number
  variantsCosted: number
  priceSum: number
  costSum: number
  /**
   * The margin, on a basis comparable with cost: (net price − cost) ÷ net price
   * over the costed variants. Null when nothing is known.
   *
   * This is the authoritative one — rules and the custom-label engine use it —
   * so it never depends on who has which display toggle ticked.
   */
  margin: number | null
  /**
   * The same figure on the prices exactly as Shopify stores them. Equal to
   * `margin` unless VAT is configured and non-zero. Kept only so the UI can
   * reconcile against what a merchant sees in Shopify; never used for rules.
   */
  marginAsEntered: number | null
  /** Gross profit per unit at net list price, summed over the costed variants. */
  unitProfit: number | null
  /** How much of the product the margin actually covers, 0–1. */
  coverage: number
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export async function getProductMargins(
  db: SupabaseClient,
  feedId: string,
  vat: VatBasis = null
): Promise<Map<string, ProductMargin>> {
  const { data, error } = await db.rpc('product_cost_summary', { p_feed_id: feedId })
  if (error) dbError('getProductMargins', error)

  // Netting the SUM is the same as netting each price and summing: division by
  // (1 + rate) is linear, and every variant in the sum shares one rate. So the
  // SQL keeps returning raw sums, and the arithmetic stays in TypeScript with
  // the rest of the ratios — the rule migration 032 set and 038 repeated.
  const divisor = vat?.pricesIncludeVat && vat.rate > 0 ? 1 + vat.rate / 100 : 1

  const out = new Map<string, ProductMargin>()
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const productRef = String(r.product_ref ?? '')
    if (!productRef) continue

    const variantsTotal = num(r.variants_total)
    const variantsCosted = num(r.variants_costed)
    const priceSum = num(r.price_sum)
    const costSum = num(r.cost_sum)
    const netPriceSum = priceSum / divisor

    // No costed variant, or a zero price to divide by, means we do not know —
    // which is a different answer from a margin of zero.
    const known = variantsCosted > 0 && priceSum > 0

    out.set(productRef, {
      productRef,
      variantsTotal,
      variantsCosted,
      priceSum,
      costSum,
      margin: known ? (netPriceSum - costSum) / netPriceSum : null,
      marginAsEntered: known ? (priceSum - costSum) / priceSum : null,
      unitProfit: known ? netPriceSum - costSum : null,
      coverage: variantsTotal > 0 ? variantsCosted / variantsTotal : 0,
    })
  }
  return out
}

/** The VAT basis a feed's settings describe, or null while it is unanswered. */
export function vatBasis(settings: {
  prices_include_vat?: boolean | null
  vat_rate?: number | null
}): VatBasis {
  if (settings.prices_include_vat === null || settings.prices_include_vat === undefined) return null
  // "Prices are already net" is a complete answer that needs no rate; "prices
  // carry VAT" without one is still unanswered.
  if (!settings.prices_include_vat) return { pricesIncludeVat: false, rate: 0 }
  const rate = Number(settings.vat_rate)
  if (!Number.isFinite(rate)) return null
  return { pricesIncludeVat: true, rate }
}

/** Feed-wide coverage, for telling the user how much to trust the column. */
export function marginCoverage(margins: Map<string, ProductMargin>): {
  products: number
  withMargin: number
  variants: number
  variantsCosted: number
} {
  let variants = 0
  let variantsCosted = 0
  let withMargin = 0
  for (const m of margins.values()) {
    variants += m.variantsTotal
    variantsCosted += m.variantsCosted
    if (m.margin !== null) withMargin++
  }
  return { products: margins.size, withMargin, variants, variantsCosted }
}
