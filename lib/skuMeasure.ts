// Measuring a shop's SKUs (migration 066).
//
// The rule (decisions 17-21, settled 2026-11-27):
//   - A SKU is an **item a feed sends out**: a product in a product-mode feed,
//     a variant in a variant-mode one (feed_settings.feed_mode), and only if
//     it passes the feed's include/exclude rules.
//   - It is counted **once per shop**, however many of the shop's feeds it
//     appears in. A product listed by several feeds counts as the most any one
//     of them sends out, so a variant-mode feed decides for that product.
//   - The account's figure for a day is the **sum over its shops**, and
//     billing uses the month's highest daily total (lib/extraSkus.ts).
//   - Feed-URL shops follow the same rule: their items are products too.
//
// The counting itself happens in Postgres (shop_sku_usage_count), so the
// variants JSON never crosses the wire. Only feeds with a rule that filters
// something are evaluated here -- the same code that counts products on the
// Feeds page -- and then just their included ids go down to the database.
//
// Called once a day by /api/cron/sku-usage. Reading what was measured is in
// lib/skuUsage.ts, which this file's callers usually want too.

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors'
import { includedProducts } from '@/lib/feedGenerator'
import { today } from '@/lib/skuUsage'

export type ShopSkuCount = { products: number; skus: number; feeds: number }

// Counts one shop's SKUs now. Throws if a feed can't be read, so a half-counted
// shop is never written.
export async function countShopSkus(db: SupabaseClient, projectId: string): Promise<ShopSkuCount> {
  const { data, error } = await db.from('feeds').select('id').eq('project_id', projectId)
  if (error) dbError('countShopSkus feeds', error)
  const feedIds = ((data ?? []) as { id: string }[]).map((f) => f.id)
  if (feedIds.length === 0) return { products: 0, skus: 0, feeds: 0 }

  // The feed's level decides what one product is worth: one item in product
  // mode, one per variant in variant mode. A feed with no settings row yet is
  // product mode, as the generator treats it.
  const { data: modeRows, error: mErr } = await db.from('feed_settings').select('feed_id, feed_mode').in('feed_id', feedIds)
  if (mErr) dbError('countShopSkus modes', mErr)
  const modes = new Map(((modeRows ?? []) as { feed_id: string; feed_mode: string }[]).map((r) => [r.feed_id, r.feed_mode]))

  const spec: { feed_id: string; mode: string; ids: string[] | null }[] = []
  for (const feedId of feedIds) {
    const mode = modes.get(feedId) === 'variant' ? 'variant' : 'product'
    const inc = await includedProducts(feedId)
    // No rule that filters: the database counts every active product itself.
    if (inc.includedShopifyIds === null) spec.push({ feed_id: feedId, mode, ids: null })
    else if (inc.includedShopifyIds.length) spec.push({ feed_id: feedId, mode, ids: inc.includedShopifyIds })
  }
  if (spec.length === 0) return { products: 0, skus: 0, feeds: feedIds.length }

  const { data: counted, error: cErr } = await db.rpc('shop_sku_usage_count', { p_spec: spec })
  if (cErr) dbError('countShopSkus count', cErr)
  const row = (counted ?? [])[0] as { product_count: number | string; sku_count: number | string } | undefined
  return {
    products: Number(row?.product_count ?? 0),
    skus: Number(row?.sku_count ?? 0),
    feeds: feedIds.length,
  }
}

// Counts a shop and stores the day's row (one per shop per day; measuring
// again the same day overwrites it).
export async function measureShop(
  db: SupabaseClient,
  shop: { id: string; account_id: string },
  on: string = today()
): Promise<ShopSkuCount> {
  const count = await countShopSkus(db, shop.id)
  const { error } = await db.from('shop_sku_usage').upsert(
    {
      project_id: shop.id,
      measured_on: on,
      account_id: shop.account_id,
      sku_count: count.skus,
      product_count: count.products,
      feed_count: count.feeds,
      measured_at: new Date().toISOString(),
    },
    { onConflict: 'project_id,measured_on' }
  )
  if (error) dbError('measureShop store', error)
  return count
}

export type MeasureResult = {
  measured: { projectId: string; skus: number; products: number }[]
  failed: { projectId: string; error: string }[]
  /** Shops still waiting because the run ran out of time. */
  remaining: number
}

type ShopRow = { id: string; account_id: string; accounts: { billing_exempt: boolean } | null }

// Measures every shop that hasn't been measured today, paying accounts first,
// within a time budget. What's left is picked up by the next run.
export async function measureDueShops(
  db: SupabaseClient,
  opts: { budgetMs: number; on?: string; limit?: number } = { budgetMs: 60_000 }
): Promise<MeasureResult> {
  const on = opts.on ?? today()
  const t0 = Date.now()

  const [{ data: shops, error }, { data: done, error: dErr }] = await Promise.all([
    db.from('projects').select('id, account_id, accounts(billing_exempt)'),
    db.from('shop_sku_usage').select('project_id').eq('measured_on', on),
  ])
  if (error) dbError('measureDueShops shops', error)
  if (dErr) dbError('measureDueShops measured', dErr)
  const already = new Set(((done ?? []) as { project_id: string }[]).map((r) => r.project_id))

  const due = ((shops ?? []) as unknown as ShopRow[])
    .filter((s) => s.account_id && !already.has(s.id))
    // Accounts that pay are measured first: their invoices depend on it.
    .sort((a, b) => Number(a.accounts?.billing_exempt ?? false) - Number(b.accounts?.billing_exempt ?? false))

  const out: MeasureResult = { measured: [], failed: [], remaining: 0 }
  for (const [i, shop] of due.entries()) {
    if (Date.now() - t0 > opts.budgetMs || (opts.limit && out.measured.length + out.failed.length >= opts.limit)) {
      out.remaining = due.length - i
      break
    }
    try {
      const c = await measureShop(db, shop, on)
      out.measured.push({ projectId: shop.id, skus: c.skus, products: c.products })
    } catch (err) {
      out.failed.push({ projectId: shop.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

