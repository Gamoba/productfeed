// Scope + overlap for an AI title-optimization run.
//
// Takes a feed's active products, narrows them with the feed's
// title_optimization_filters (the SEPARATE optimization filter set, evaluated by
// the SAME lib/feedFilters mechanic as the feed), and reports how the in-scope
// set overlaps the existing product_title_optimizations rows. This is the input
// to the skip/re-run decision (with human_edited protection) — it does not
// itself optimize or write anything.

import { adminDb } from '@/lib/feeds'
import { applyFeedFilters, type FeedFilter } from '@/lib/feedFilters'
import type { SupabaseProduct } from '@/lib/sync'

export type ExistingStatus = 'ai_generated' | 'human_edited' | 'needs_review'

// What we already have stored for a product. original_title is the re-run
// source (never optimized_title — avoids the "telephone game"). source_hash
// lets the run skip products whose input data is unchanged.
export type ExistingOptimization = {
  status: ExistingStatus
  original_title: string
  source_hash: string | null
}

export type OverlapSummary = {
  inScope: number
  alreadyOptimized: number // status = 'ai_generated'
  humanEdited: number // status = 'human_edited' (protected — needs deliberate opt-in to overwrite)
  needsReview: number // status = 'needs_review'
  notYetOptimized: number // no existing row
}

export type OptimizationScope = {
  feedId: string
  marketUrl: string | null
  products: SupabaseProduct[] // in-scope active products
  existingByRef: Map<string, ExistingOptimization> // product_ref (shopify_id) -> existing
  summary: OverlapSummary
}

// PostgREST caps at 1000 rows/request; page through active products. Mirrors
// feedGenerator's fetchAllActiveProducts (kept local to avoid importing the
// Anthropic-laden feedGenerator module just for a paged read).
export async function fetchAllActiveProducts(
  db: ReturnType<typeof adminDb>,
  feedId: string
): Promise<SupabaseProduct[]> {
  // Below the 1000-row cap on purpose — each page embeds metafields and must
  // stay under the 8 s statement timeout (see feedGenerator's PAGE_SIZE).
  const PAGE_SIZE = 250
  const out: SupabaseProduct[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('products')
      .select('*, metafields:product_metafields(*)')
      .eq('feed_id', feedId)
      .eq('status', 'active')
      // created_at alone is NOT a stable sort — bulk imports share a timestamp,
      // and offset pagination over ties returns rows nondeterministically,
      // duplicating/skipping rows at page boundaries. id is the unique tiebreaker.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Products failed: ${error.message}`)
    if (!data || data.length === 0) break
    out.push(...(data as SupabaseProduct[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return out
}

// filterOverride lets callers compute the scope for a filter set that isn't
// (yet) saved — used by the Scope editor's live overlap preview. When omitted,
// the feed's stored title_optimization_filters are used.
export async function getOptimizationScope(
  feedId: string,
  filterOverride?: FeedFilter[]
): Promise<OptimizationScope> {
  const db = adminDb()

  const [{ data: shopSettingsData }, rawProducts, filtersResult, { data: existingData }] =
    await Promise.all([
      db.from('shop_settings').select('market_url').eq('feed_id', feedId).maybeSingle(),
      fetchAllActiveProducts(db, feedId),
      filterOverride
        ? Promise.resolve({ data: null as unknown })
        : db
            .from('title_optimization_filters')
            .select('filter_type, operator, rules')
            .eq('feed_id', feedId),
      db
        .from('product_title_optimizations')
        .select('product_ref, status, original_title, source_hash')
        .eq('feed_id', feedId),
    ])

  const marketUrl = (shopSettingsData?.market_url as string | null) ?? null
  const filterRows = filterOverride ?? ((filtersResult.data ?? []) as FeedFilter[])
  const products = applyFeedFilters(rawProducts, filterRows, marketUrl)

  const existingByRef = new Map<string, ExistingOptimization>()
  for (const row of (existingData ?? []) as {
    product_ref: string
    status: ExistingStatus
    original_title: string
    source_hash: string | null
  }[]) {
    existingByRef.set(row.product_ref, {
      status: row.status,
      original_title: row.original_title,
      source_hash: row.source_hash,
    })
  }

  // Overlap is tallied over the IN-SCOPE set only (existing rows for products
  // no longer in scope are irrelevant to this run).
  const summary: OverlapSummary = {
    inScope: products.length,
    alreadyOptimized: 0,
    humanEdited: 0,
    needsReview: 0,
    notYetOptimized: 0,
  }
  for (const p of products) {
    const existing = existingByRef.get(p.shopify_id)
    if (!existing) {
      summary.notYetOptimized++
    } else if (existing.status === 'ai_generated') {
      summary.alreadyOptimized++
    } else if (existing.status === 'human_edited') {
      summary.humanEdited++
    } else {
      summary.needsReview++
    }
  }

  return { feedId, marketUrl, products, existingByRef, summary }
}
