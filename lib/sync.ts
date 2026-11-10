import { createClient } from '@supabase/supabase-js'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import { fetchFeedUrlProducts } from '@/lib/feedUrlSource'
import { AppError } from '@/lib/errors'
import type { ShopifyClient, ShopifyData, ShopifyProduct } from '@/lib/shopify'
import { readVariantStock } from '@/lib/inventoryAnalytics'

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export type SyncResult = {
  synced: number
  metafields: number
  durationMs: number
  // Non-fatal problems worth telling the user about. The sync itself succeeded;
  // these say the data it wrote is not everything it could have been. Empty on
  // a clean sync.
  warnings: SyncWarning[]
  /** Stock snapshot rows written — i.e. variants whose stock actually changed. */
  stockChanges: number
}

export type SyncWarning = {
  // Machine-readable so the UI can style/act on a specific case rather than
  // pattern-matching prose.
  code: 'metaobjects_access_denied' | 'metaobjects_unresolved'
  message: string
}

// Turns the metaobject resolution summary into user-facing warnings.
//
// The two cases need different words because they need different fixes: a
// missing scope is a Shopify app setting, while a handful of stragglers is a
// transient lookup failure that a re-sync clears.
function metaobjectWarnings(summary: ShopifyData['metaobjects']): SyncWarning[] {
  const missing = summary.total - summary.resolved
  if (missing <= 0) return []

  if (summary.accessDenied) {
    return [
      {
        code: 'metaobjects_access_denied',
        message:
          `${missing} metaobject references could not be translated because the access token ` +
          'is missing the read_metaobjects scope. Fields like region, grape and country will ' +
          'show a Shopify ID instead of their value. Add the scope in Shopify Admin, ' +
          'reconnect the project, and sync again.',
      },
    ]
  }
  return [
    {
      code: 'metaobjects_unresolved',
      message:
        `${missing} of ${summary.total} metaobject references could not be translated and are ` +
        'stored as Shopify IDs. Run the sync again — if they persist, the metaobject has ' +
        'most likely been deleted in Shopify.',
    },
  ]
}

export type SupabaseMetafield = {
  id: string
  product_id: string
  feed_id: string
  namespace: string
  key: string
  value: string | null
  type: string | null
  created_at: string
}

export type SupabaseProduct = {
  id: string
  feed_id: string
  shopify_id: string
  title: string | null
  body_html: string | null
  vendor: string | null
  product_type: string | null
  status: string | null
  handle: string | null
  // Full product URL from the source (feed-URL projects); null for Shopify.
  // Optional: rows read before migration 046 don't carry it.
  link?: string | null
  published_at: string | null
  tags: string | null
  images: unknown[]
  variants: unknown[]
  options: unknown[]
  collections: unknown[]
  synced_at: string | null
  created_at: string
  updated_at: string
  metafields: SupabaseMetafield[]
}

// Source-agnostic product as written to the products table. Both sources map
// into this: Shopify (shopifyToSource below) and feed URLs (lib/feedUrlSource).
// `id` lands in products.shopify_id — the column name predates feed-URL
// projects; for those it holds the source feed's g:id.
export type SourceProduct = {
  id: string
  title: string | null
  body_html: string | null
  vendor: string | null
  product_type: string | null
  status: string | null
  handle: string | null
  link: string | null
  published_at: string | null
  tags: string | null
  images: unknown[]
  variants: unknown[]
  options: unknown[]
  collections: unknown[]
  metafields: { namespace: string; key: string; value: string | null; type: string | null }[]
}

function shopifyToSource(p: ShopifyProduct): SourceProduct {
  return {
    id: String(p.id),
    title: p.title,
    body_html: p.body_html,
    vendor: p.vendor,
    product_type: p.product_type,
    status: p.status,
    handle: p.handle,
    link: null, // built at generation time from market URL + handle
    published_at: p.published_at,
    tags: p.tags,
    images: p.images,
    variants: p.variants,
    // Option DEFINITIONS ("Size", "Colour"). Already present in the Shopify
    // response; migration 034 gives it somewhere to live.
    options: p.options ?? [],
    collections: p.collections,
    metafields: p.metafields.map((mf) => ({
      namespace: mf.namespace,
      key: mf.key,
      value: mf.value,
      type: mf.type,
    })),
  }
}

// Splits `items` into chunks and runs `fn` over them with bounded parallelism.
// Keeps PostgREST requests below URL-length / payload limits on large catalogs
// (a feed-URL project can carry tens of thousands of products), and each
// statement under Supabase's statement timeout — 5000-row metafield upserts
// four at a time timed out on a 28k-product feed, so sizes stay small.
async function inChunks<T>(
  items: T[],
  size: number,
  concurrency: number,
  fn: (chunk: T[]) => Promise<void>
): Promise<void> {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++]
      await fn(chunk)
    }
  })
  await Promise.all(workers)
}

type ProjectSourceRow = {
  source_type: string | null
  feed_url: string | null
}

// What a source fetch hands back to syncProducts. `shopify` is set only for
// Shopify projects — stock snapshots and locations are Shopify data.
type SourceFetch = {
  products: SourceProduct[]
  warnings: SyncWarning[]
  shopify: ShopifyClient | null
}

// Fetches a Shopify project's products, localized when the feed has a
// selected locale / market. Read-only Shopify access via lib/shopify.ts.
async function fetchShopifySource(
  db: ReturnType<typeof adminClient>,
  feedId: string,
  projectId: string
): Promise<SourceFetch> {
  const { data: settings, error: settingsErr } = await db
    .from('shop_settings')
    .select('selected_country, selected_locale, currency, selected_market_id')
    .eq('feed_id', feedId)
    .maybeSingle()
  console.log(
    `[sync] shop_settings — ${JSON.stringify(settings)} — fejl: ${settingsErr?.message ?? 'ingen'}`
  )

  const shopify = await createShopifyClientForProject(db, projectId)

  let shopifyData: ShopifyData
  if (settings?.selected_locale) {
    console.log(
      `[sync] Lokaliseret sync locale="${settings.selected_locale}", currency="${settings.currency ?? 'ingen'}", country="${settings.selected_country ?? 'ingen'}"`
    )
    shopifyData = await shopify.fetchProductsLocalized(
      settings.selected_locale,
      settings.currency ?? undefined,
      settings.selected_country ?? undefined
    )
  } else {
    console.log(`[sync] Standard sync (ingen selected_locale)`)
    shopifyData = await shopify.fetchProductsWithAllData()
  }
  return {
    products: shopifyData.products.map(shopifyToSource),
    warnings: metaobjectWarnings(shopifyData.metaobjects),
    shopify,
  }
}

// Fetches a feed-URL project's products from its public product feed.
async function fetchFeedUrlSource(project: ProjectSourceRow, projectId: string): Promise<SourceFetch> {
  if (!project.feed_url) {
    throw new AppError('Projektet har ingen feed-URL konfigureret endnu')
  }
  const result = await fetchFeedUrlProducts(project.feed_url)
  console.log(
    `[sync] feed URL (project ${projectId}): ${result.itemCount} items → ${result.products.length} produkter` +
      (result.duplicateIds ? `, ${result.duplicateIds} dublet-id'er sprunget over` : '') +
      (result.skippedNoId ? `, ${result.skippedNoId} uden id sprunget over` : '')
  )
  return { products: result.products, warnings: [], shopify: null }
}

// Sync products into a specific feed. The source comes from the feed's project:
// Shopify (credentials + per-feed locale/market in shop_settings) or a public
// feed URL. Products are scoped by feed_id so the same source product can exist
// in multiple feeds independently.
export async function syncProducts(feedId: string): Promise<SyncResult> {
  const t0 = Date.now()
  const db = adminClient()

  console.log(`[sync] syncProducts feedId=${feedId}`)

  // The project is derived from the feed itself (authoritative link) rather
  // than taken as a separate projectId — getOwnedFeed already guarantees the
  // feed's project is owned by the caller. feeds.project_id is NOT NULL, so a
  // missing one is a hard error.
  const { data: feedRow } = await db
    .from('feeds')
    .select('project_id')
    .eq('id', feedId)
    .maybeSingle()
  const projectId = (feedRow as { project_id: string | null } | null)?.project_id ?? null
  if (!projectId) {
    throw new Error(`Feed ${feedId} har intet project_id — kan ikke synkronisere`)
  }

  const { data: project, error: projectErr } = await db
    .from('projects')
    .select('source_type, feed_url')
    .eq('id', projectId)
    .maybeSingle<ProjectSourceRow>()
  if (projectErr) throw new Error(`Project lookup failed: ${projectErr.message}`)
  if (!project) throw new AppError('Projektet blev ikke fundet', 404)

  const source =
    project.source_type === 'feed_url'
      ? await fetchFeedUrlSource(project, projectId)
      : await fetchShopifySource(db, feedId, projectId)
  const { products, shopify } = source
  const tFetch = Date.now()
  console.log(`[sync] fetch total: ${tFetch - t0}ms — ${products.length} produkter`)

  const syncedIds = new Set(products.map((p) => p.id))
  const now = new Date().toISOString()

  // ── 1. Upsert products in chunks ────────────────────────────────────────
  // .select('id, shopify_id') returns the UUIDs we need to attach metafields.
  // Chunked so a large catalog stays under PostgREST's payload limit and each
  // returned set stays under its 1000-row cap.
  const productRows = products.map((p) => ({
    feed_id: feedId,
    shopify_id: p.id,
    title: p.title,
    body_html: p.body_html,
    vendor: p.vendor,
    product_type: p.product_type,
    status: p.status,
    handle: p.handle,
    link: p.link,
    published_at: p.published_at,
    tags: p.tags,
    images: p.images,
    variants: p.variants,
    options: p.options,
    collections: p.collections,
    synced_at: now,
    updated_at: now,
  }))

  const idBySourceId = new Map<string, string>()
  await inChunks(productRows, 500, 3, async (chunk) => {
    const { data, error } = await db
      .from('products')
      .upsert(chunk, { onConflict: 'feed_id,shopify_id' })
      .select('id, shopify_id')
    if (error) throw new Error(`Upsert of products failed: ${error.message}`)
    for (const row of (data ?? []) as { id: string; shopify_id: string }[]) {
      idBySourceId.set(row.shopify_id, row.id)
    }
  })
  const tUpsertProducts = Date.now()
  console.log(`[sync] upsert ${productRows.length} produkter: ${tUpsertProducts - tFetch}ms`)

  // ── 2. Delete existing metafields for these products ────────────────────
  // PostgREST sends .in() values in the URL; chunk at 500 UUIDs to stay under
  // the URL-length limit.
  await inChunks(Array.from(idBySourceId.values()), 500, 3, async (chunk) => {
    const { error } = await db
      .from('product_metafields')
      .delete()
      .eq('feed_id', feedId)
      .in('product_id', chunk)
    if (error) throw new Error(`Delete of metafields failed: ${error.message}`)
  })
  const tDeleteMfs = Date.now()
  console.log(`[sync] delete metafields: ${tDeleteMfs - tUpsertProducts}ms`)

  // ── 3. Upsert all metafields ────────────────────────────────────────────
  const allMetafields: Array<{
    feed_id: string
    product_id: string
    namespace: string
    key: string
    value: string | null
    type: string | null
  }> = []
  for (const p of products) {
    const productUuid = idBySourceId.get(p.id)
    if (!productUuid) continue
    for (const mf of p.metafields) {
      allMetafields.push({
        feed_id: feedId,
        product_id: productUuid,
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value,
        type: mf.type,
      })
    }
  }

  await inChunks(allMetafields, 1000, 2, async (chunk) => {
    const { error } = await db
      .from('product_metafields')
      .upsert(chunk, { onConflict: 'feed_id,product_id,namespace,key' })
    if (error) throw new Error(`Upsert of metafields failed: ${error.message}`)
  })
  const tUpsertMfs = Date.now()
  console.log(`[sync] upsert ${allMetafields.length} metafields: ${tUpsertMfs - tDeleteMfs}ms`)

  // ── Cleanup: delete products that disappeared from the source (per feed) ─
  // Paged read: PostgREST caps a response at 1000 rows, so an unpaged select
  // would only ever see (and clean up) the first 1000 products.
  const staleIds: string[] = []
  const PAGE_SIZE = 1000
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from('products')
      .select('id, shopify_id')
      .eq('feed_id', feedId)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Fetch for cleanup failed: ${error.message}`)
    const rows = (data ?? []) as { id: string; shopify_id: string }[]
    for (const row of rows) {
      if (!syncedIds.has(row.shopify_id)) staleIds.push(row.id)
    }
    if (rows.length < PAGE_SIZE) break
  }

  await inChunks(staleIds, 250, 3, async (chunk) => {
    const { error } = await db.from('products').delete().in('id', chunk)
    if (error) throw new Error(`Cleanup of stale products failed: ${error.message}`)
  })
  const tCleanup = Date.now()
  console.log(`[sync] cleanup (${staleIds.length} stale produkter): ${tCleanup - tUpsertMfs}ms`)

  // ── Stock: record what changed, and where the shop stocks from ──────────
  //
  // Shopify projects only. A feed URL says in/out of stock, not a quantity, and
  // has no locations — snapshotting its 1/0 placeholders would invent stock
  // history.
  //
  // Deliberately LAST and deliberately non-fatal. Neither of these is part of
  // the catalogue this function exists to deliver: the products are already
  // committed above, and a failure here must leave a successful sync
  // successful. Both readers already treat absence as "unknown", which is the
  // safe state — unlike a half-written catalogue.
  //
  // The snapshot is taken from the payload just upserted, so it records the
  // stock that this sync actually observed rather than re-reading a table that
  // another process could have moved underneath it.
  let stockChanges = 0
  if (shopify) {
    try {
      const observedAt = now
      const stockRows: {
        product_ref: string
        variant_ref: string
        quantity: number | null
        tracked: boolean
        policy: string | null
      }[] = []

      for (const p of products) {
        const productRef = p.id
        for (const v of p.variants ?? []) {
          const stock = readVariantStock(productRef, v as Record<string, unknown>)
          if (!stock) continue
          stockRows.push({
            product_ref: stock.productRef,
            variant_ref: stock.variantRef,
            quantity: stock.quantity,
            tracked: stock.tracked,
            policy: stock.oversell ? 'continue' : 'deny',
          })
        }
      }

      if (stockRows.length > 0) {
        const { data: written, error: stockErr } = await db.rpc('record_variant_stock', {
          p_feed_id: feedId,
          p_observed_at: observedAt,
          p_rows: stockRows,
        })
        if (stockErr) throw new Error(stockErr.message)
        stockChanges = Number(written ?? 0)
      }

      // Shop-wide, so it lands on the project rather than on this feed. Cheap
      // enough (one request, no pagination) to refresh on every sync, which keeps
      // it honest as merchants open and close locations.
      const locations = await shopify.fetchLocations()
      if (locations.length > 0) {
        const { error: locErr } = await db
          .from('projects')
          .update({ shopify_locations: locations, locations_synced_at: observedAt })
          .eq('id', projectId)
        if (locErr) throw new Error(locErr.message)
      }
    } catch (err) {
      console.error(`[sync] stock/locations fejlede (produkter er gemt) — ${err}`)
    }
    console.log(`[sync] stock: ${stockChanges} ændring(er), ${Date.now() - tCleanup}ms`)
  }

  const totalMs = Date.now() - t0
  console.log(`[sync] TOTAL: ${totalMs}ms`)

  return {
    synced: products.length,
    metafields: allMetafields.length,
    durationMs: totalMs,
    warnings: source.warnings,
    stockChanges,
  }
}

export async function getProductsForFeed(feedId: string): Promise<SupabaseProduct[]> {
  const db = adminClient()

  const { data, error } = await db
    .from('products')
    .select('*, metafields:product_metafields(*)')
    .eq('feed_id', feedId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Fetch from Supabase failed: ${error.message}`)

  return (data ?? []) as SupabaseProduct[]
}

export function toShopifyData(products: SupabaseProduct[]): ShopifyData {
  return {
    // Rehydrating from the database: the GIDs were already translated (or not)
    // during the sync that wrote these rows, so there is nothing to report here.
    metaobjects: { total: 0, resolved: 0, accessDenied: false },
    products: products.map((p) => ({
      id: parseInt(p.shopify_id, 10),
      title: p.title ?? '',
      body_html: p.body_html ?? '',
      vendor: p.vendor ?? '',
      product_type: p.product_type ?? '',
      created_at: p.created_at,
      updated_at: p.updated_at,
      published_at: p.published_at,
      handle: p.handle ?? '',
      link: p.link ?? null,
      status: (p.status as 'active' | 'draft' | 'archived') ?? 'active',
      tags: p.tags ?? '',
      published_scope: '',
      template_suffix: null,
      admin_graphql_api_id: '',
      variants: (p.variants as unknown[]) as import('@/lib/shopify').ShopifyVariant[],
      options: ((p.options as unknown[]) ?? []) as import('@/lib/shopify').ShopifyOption[],
      images: (p.images as unknown[]) as import('@/lib/shopify').ShopifyImage[],
      image: null,
      metafields: p.metafields.map((mf) => ({
        id: 0,
        namespace: mf.namespace,
        key: mf.key,
        value: mf.value ?? '',
        type: mf.type ?? '',
        description: null,
        owner_id: parseInt(p.shopify_id, 10),
        created_at: mf.created_at,
        updated_at: mf.created_at,
        owner_resource: 'product',
      })),
      collections: Array.isArray(p.collections) ? (p.collections as string[]) : [],
    })),
  }
}
