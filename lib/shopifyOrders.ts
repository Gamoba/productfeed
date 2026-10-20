// Pulls orders, refunds and returns from Shopify into the local archive.
//
// ── THE RULE THAT SHAPES THIS FILE: never lose an order ────────────────────
// The app holds `read_orders` but not `read_all_orders`, so Shopify shows only
// the last 60 days. Anything older is unreachable forever. That makes this
// sync the sole author of a permanent archive rather than a cache refresher,
// and three things follow:
//
//   1. Every write is an UPSERT. Nothing here deletes, truncates or replaces a
//      stored order. A "clean re-sync" would destroy history that no API call
//      can return.
//
//   2. The watermark advances PER PAGE, not per run. A run that dies on page
//      40 keeps the 39 pages it already stored, and the next run resumes from
//      where it got to instead of redoing — or worse, skipping — them.
//
//   3. Failure is loud and recorded. A stale product cache is invisible and
//      harmless; a stale order archive silently under-reports returns, which
//      looks exactly like genuinely good news.
//
// Read-only towards Shopify throughout: one GraphQL query, no mutations.

import type { SupabaseClient } from '@supabase/supabase-js'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import { dbError } from '@/lib/errors'
import type { ShopifyOrder } from '@/lib/shopify'

const UPSERT_CHUNK = 500

/**
 * Shopify's own visibility ceiling. Asking for anything older under
 * `read_orders` returns nothing, so a first run starts here rather than at an
 * arbitrary epoch that would page through emptiness.
 *
 * 59, not 60: the boundary is enforced server-side against the moment the
 * request lands, and a query built at exactly 60 days can age out mid-run.
 */
const FIRST_RUN_DAYS = 59

/**
 * How far back before the watermark each run re-reads.
 *
 * Shopify's `updated_at` filter is inclusive, but orders modified DURING a run
 * can be assigned a timestamp inside the range already paged past. Re-reading
 * an hour costs a few duplicate upserts — which are free, since every row is
 * keyed — and closes that window.
 */
const OVERLAP_MINUTES = 60

const PAGE_SIZE = 10

/** How many line items one order page requests — mirrors ORDERS_QUERY. */
const LINE_ITEM_LIMIT = 50

export type OrderSyncResult = {
  /** Orders written this run. Re-reads within the overlap count here too. */
  orders: number
  lineItems: number
  refunds: number
  refundLineItems: number
  returns: number
  returnLineItems: number
  /** Pages fetched, for spotting a run that stopped early. */
  pages: number
  /** Orders carrying more line items than one page requested — see below. */
  truncated: number
  /** Where this run started reading from. */
  from: string
  /** New watermark, or the old one if nothing moved. */
  watermark: string | null
  durationMs: number
}

type SyncState = {
  watermark: string | null
  oldest_order_at: string | null
  newest_order_at: string | null
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

function minusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString()
}

async function chunkedUpsert(
  db: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const { error } = await db
      .from(table)
      .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict })
    if (error) dbError(`syncShopifyOrders/${table}`, error)
  }
}

/**
 * Writes one page of orders and everything hanging off them.
 *
 * Parents before children, because the children reference them — and orders
 * before refunds specifically, so a crash between the two leaves an order with
 * no refunds (understating returns, visibly) rather than refunds with no order
 * (a dangling row that no query would ever reach).
 */
async function persistPage(
  db: SupabaseClient,
  projectId: string,
  orders: ShopifyOrder[]
): Promise<Omit<OrderSyncResult, 'pages' | 'from' | 'watermark' | 'durationMs'>> {
  const syncedAt = new Date().toISOString()

  const orderRows = orders.map((o) => ({
    project_id: projectId,
    order_ref: o.orderRef,
    name: o.name,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    processed_at: o.processedAt,
    cancelled_at: o.cancelledAt,
    country_code: o.countryCode,
    shop_currency: o.shopCurrency,
    presentment_currency: o.presentmentCurrency,
    total_price_shop: o.totalPrice.shop,
    total_price_presentment: o.totalPrice.presentment,
    subtotal_price_shop: o.subtotalPrice.shop,
    subtotal_price_presentment: o.subtotalPrice.presentment,
    total_tax_shop: o.totalTax.shop,
    total_tax_presentment: o.totalTax.presentment,
    total_discounts_shop: o.totalDiscounts.shop,
    total_discounts_presentment: o.totalDiscounts.presentment,
    total_refunded_shop: o.totalRefunded.shop,
    total_refunded_presentment: o.totalRefunded.presentment,
    financial_status: o.financialStatus,
    fulfillment_status: o.fulfillmentStatus,
    test: o.test,
    synced_at: syncedAt,
    // first_seen_at is intentionally absent: the column defaults on INSERT and
    // must survive every later UPSERT, since it is how an order that has aged
    // out of the API is told apart from one that never existed.
  }))

  const lineRows = orders.flatMap((o) =>
    o.lineItems.map((li) => ({
      project_id: projectId,
      line_item_ref: li.lineItemRef,
      order_ref: o.orderRef,
      product_ref: li.productRef,
      variant_ref: li.variantRef,
      sku: li.sku,
      title: li.title,
      variant_title: li.variantTitle,
      quantity: li.quantity,
      price_shop: li.price.shop,
      price_presentment: li.price.presentment,
      total_discount_shop: li.totalDiscount.shop,
      total_discount_presentment: li.totalDiscount.presentment,
    }))
  )

  const refundRows = orders.flatMap((o) =>
    o.refunds.map((r) => ({
      project_id: projectId,
      refund_ref: r.refundRef,
      order_ref: o.orderRef,
      created_at: r.createdAt,
      processed_at: r.processedAt,
      return_ref: r.returnRef,
      note: r.note,
      total_refunded_shop: r.totalRefunded.shop,
      total_refunded_presentment: r.totalRefunded.presentment,
    }))
  )

  const refundLineRows = orders.flatMap((o) =>
    o.refunds.flatMap((r) =>
      r.lineItems.map((rli) => ({
        project_id: projectId,
        refund_line_ref: rli.refundLineRef,
        refund_ref: r.refundRef,
        order_ref: o.orderRef,
        line_item_ref: rli.lineItemRef,
        product_ref: rli.productRef,
        variant_ref: rli.variantRef,
        quantity: rli.quantity,
        subtotal_shop: rli.subtotal.shop,
        subtotal_presentment: rli.subtotal.presentment,
        total_tax_shop: rli.totalTax.shop,
        total_tax_presentment: rli.totalTax.presentment,
        restock_type: rli.restockType,
      }))
    )
  )

  const returnRows = orders.flatMap((o) =>
    o.returns.map((ret) => ({
      project_id: projectId,
      return_ref: ret.returnRef,
      order_ref: o.orderRef,
      status: ret.status,
      name: ret.name,
      created_at: ret.createdAt,
      closed_at: ret.closedAt,
      total_quantity: ret.totalQuantity,
    }))
  )

  const returnLineRows = orders.flatMap((o) =>
    o.returns.flatMap((ret) =>
      ret.lineItems.map((rli) => ({
        project_id: projectId,
        return_line_ref: rli.returnLineRef,
        return_ref: ret.returnRef,
        order_ref: o.orderRef,
        line_item_ref: rli.lineItemRef,
        product_ref: rli.productRef,
        variant_ref: rli.variantRef,
        quantity: rli.quantity,
        return_reason: rli.returnReason,
        return_reason_note: rli.returnReasonNote,
      }))
    )
  )

  await chunkedUpsert(db, 'shopify_orders', orderRows, 'project_id,order_ref')
  await chunkedUpsert(db, 'shopify_order_line_items', lineRows, 'project_id,line_item_ref')
  await chunkedUpsert(db, 'shopify_refunds', refundRows, 'project_id,refund_ref')
  await chunkedUpsert(
    db,
    'shopify_refund_line_items',
    refundLineRows,
    'project_id,refund_line_ref'
  )
  await chunkedUpsert(db, 'shopify_returns', returnRows, 'project_id,return_ref')
  await chunkedUpsert(
    db,
    'shopify_return_line_items',
    returnLineRows,
    'project_id,return_line_ref'
  )

  return {
    orders: orderRows.length,
    lineItems: lineRows.length,
    refunds: refundRows.length,
    refundLineItems: refundLineRows.length,
    returns: returnRows.length,
    returnLineItems: returnLineRows.length,
    // An order at exactly the limit probably has more that we never saw. It is
    // reported rather than corrected: paging line items per order would
    // multiply the request count for the wholesale case this tool does not
    // measure, and a silent truncation is the thing worth refusing.
    truncated: orders.filter((o) => o.lineItems.length >= LINE_ITEM_LIMIT).length,
  }
}

async function readState(db: SupabaseClient, projectId: string): Promise<SyncState | null> {
  const { data, error } = await db
    .from('shopify_order_sync_state')
    .select('watermark, oldest_order_at, newest_order_at')
    .eq('project_id', projectId)
    .maybeSingle<SyncState>()
  if (error) dbError('syncShopifyOrders/readState', error)
  return data ?? null
}

async function writeState(
  db: SupabaseClient,
  projectId: string,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await db
    .from('shopify_order_sync_state')
    .upsert({ project_id: projectId, ...patch }, { onConflict: 'project_id' })
  if (error) dbError('syncShopifyOrders/writeState', error)
}

export type OrderSyncOptions = {
  /**
   * Override the start of the read. Only useful for a repair run — the normal
   * path resumes from the stored watermark, and reaching further back than
   * FIRST_RUN_DAYS returns nothing regardless of what is passed.
   */
  since?: string
  /** Stop after this many pages. For smoke-testing the query, not for runs. */
  maxPages?: number
  onProgress?: (msg: string) => void
}

export async function syncShopifyOrders(
  db: SupabaseClient,
  projectId: string,
  opts: OrderSyncOptions = {}
): Promise<OrderSyncResult> {
  const t0 = Date.now()
  const log = opts.onProgress ?? (() => {})

  const state = await readState(db, projectId)
  const from =
    opts.since ??
    (state?.watermark ? minusMinutes(state.watermark, OVERLAP_MINUTES) : isoDaysAgo(FIRST_RUN_DAYS))

  log(`Reading orders updated since ${from}`)

  const client = await createShopifyClientForProject(db, projectId)

  const totals: OrderSyncResult = {
    orders: 0,
    lineItems: 0,
    refunds: 0,
    refundLineItems: 0,
    returns: 0,
    returnLineItems: 0,
    pages: 0,
    truncated: 0,
    from,
    watermark: state?.watermark ?? null,
    durationMs: 0,
  }

  let cursor: string | null = null
  let oldestSeen: string | null = state?.oldest_order_at ?? null
  let newestSeen: string | null = state?.newest_order_at ?? null

  try {
    for (;;) {
      const page = await client.fetchOrdersPage(from, cursor, PAGE_SIZE)
      totals.pages++

      if (page.orders.length) {
        const written = await persistPage(db, projectId, page.orders)
        totals.orders += written.orders
        totals.lineItems += written.lineItems
        totals.refunds += written.refunds
        totals.refundLineItems += written.refundLineItems
        totals.returns += written.returns
        totals.returnLineItems += written.returnLineItems
        totals.truncated += written.truncated

        for (const o of page.orders) {
          if (!oldestSeen || o.createdAt < oldestSeen) oldestSeen = o.createdAt
          if (!newestSeen || o.createdAt > newestSeen) newestSeen = o.createdAt
        }

        // Orders arrive ascending by updated_at, so the last one on the page is
        // the high-water mark — and it is only committed once the page is
        // durably stored. Advancing before the write would skip these orders
        // forever if the write then failed.
        const last = page.orders[page.orders.length - 1]
        totals.watermark = last.updatedAt
        await writeState(db, projectId, {
          watermark: last.updatedAt,
          oldest_order_at: oldestSeen,
          newest_order_at: newestSeen,
        })

        log(`Page ${totals.pages}: ${written.orders} orders, ${written.refunds} refunds`)
      }

      if (!page.hasNextPage) break
      if (opts.maxPages && totals.pages >= opts.maxPages) {
        log(`Stopped at the ${opts.maxPages}-page limit — more orders remain.`)
        break
      }
      cursor = page.endCursor
      if (!cursor) break
    }
  } catch (err) {
    // The watermark keeps whatever the last successful page set, so the next
    // run resumes from there rather than restarting the window.
    await writeState(db, projectId, {
      last_run_at: new Date().toISOString(),
      last_run_orders: totals.orders,
      last_run_ms: Date.now() - t0,
      last_error: err instanceof Error ? err.message : String(err),
      last_error_at: new Date().toISOString(),
    })
    throw err
  }

  totals.durationMs = Date.now() - t0

  await writeState(db, projectId, {
    last_run_at: new Date().toISOString(),
    last_run_orders: totals.orders,
    last_run_ms: totals.durationMs,
    oldest_order_at: oldestSeen,
    newest_order_at: newestSeen,
    last_error: null,
    last_error_at: null,
  })

  return totals
}

export type ArchiveCoverage = {
  oldestOrderAt: string | null
  newestOrderAt: string | null
  lastRunAt: string | null
  lastError: string | null
  /** Whole days between the oldest stored order and now. */
  depthDays: number | null
  /**
   * True when the archive has not been refreshed inside Shopify's 60-day
   * window, which means orders have aged out unseen and the gap is permanent.
   */
  hasPermanentGap: boolean
}

/**
 * How far back this project can actually see.
 *
 * Every surface that reports a return rate should be able to say this, because
 * a thin archive and a genuinely low return rate produce the same small
 * numbers — and only one of them is good news.
 */
export async function getArchiveCoverage(
  db: SupabaseClient,
  projectId: string
): Promise<ArchiveCoverage> {
  const { data, error } = await db
    .from('shopify_order_sync_state')
    .select('oldest_order_at, newest_order_at, last_run_at, last_error')
    .eq('project_id', projectId)
    .maybeSingle<{
      oldest_order_at: string | null
      newest_order_at: string | null
      last_run_at: string | null
      last_error: string | null
    }>()
  if (error) dbError('getArchiveCoverage', error)

  const oldest = data?.oldest_order_at ?? null
  const lastRun = data?.last_run_at ?? null

  const daysSince = (iso: string | null): number | null =>
    iso === null ? null : Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)

  const sinceLastRun = daysSince(lastRun)

  return {
    oldestOrderAt: oldest,
    newestOrderAt: data?.newest_order_at ?? null,
    lastRunAt: lastRun,
    lastError: data?.last_error ?? null,
    depthDays: daysSince(oldest),
    // Never run at all is also a gap: nothing was captured while it was
    // visible, and that window is already gone.
    hasPermanentGap: sinceLastRun === null || sinceLastRun >= FIRST_RUN_DAYS,
  }
}
