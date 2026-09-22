import { createClient } from '@supabase/supabase-js'
import { createShopifyClientForProject } from '@/lib/projectShopify'
import type { ShopifyData } from '@/lib/shopify'

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
  published_at: string | null
  tags: string | null
  images: unknown[]
  variants: unknown[]
  collections: unknown[]
  synced_at: string | null
  created_at: string
  updated_at: string
  metafields: SupabaseMetafield[]
}

// Sync products into a specific feed. Locale/currency comes from that feed's
// shop_settings (now per-feed). Products are scoped by feed_id so the same
// Shopify product can exist in multiple feeds independently.
export async function syncProducts(feedId: string): Promise<SyncResult> {
  const t0 = Date.now()
  const db = adminClient()

  console.log(`[sync] syncProducts feedId=${feedId}`)

  const { data: settings, error: settingsErr } = await db
    .from('shop_settings')
    .select('selected_country, selected_locale, currency, selected_market_id')
    .eq('feed_id', feedId)
    .maybeSingle()
  const tSettings = Date.now()
  console.log(
    `[sync] shop_settings: ${tSettings - t0}ms — ${JSON.stringify(settings)} — fejl: ${settingsErr?.message ?? 'ingen'}`
  )

  // Credentials come from the feed's project. We derive the project from the
  // feed itself (authoritative link) rather than taking a separate projectId —
  // getOwnedFeed already guarantees the feed's project is owned by the caller.
  // feeds.project_id is NOT NULL, so a missing one is a hard error.
  const { data: feedRow } = await db
    .from('feeds')
    .select('project_id')
    .eq('id', feedId)
    .maybeSingle()
  const projectId = (feedRow as { project_id: string | null } | null)?.project_id ?? null
  if (!projectId) {
    throw new Error(`Feed ${feedId} har intet project_id — kan ikke synkronisere`)
  }
  const shopify = await createShopifyClientForProject(db, projectId)
  console.log(`[sync] credentials: project ${projectId}`)

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
  const tFetch = Date.now()
  console.log(
    `[sync] shopify fetch total: ${tFetch - tSettings}ms — ${shopifyData.products.length} produkter`
  )

  const { products } = shopifyData
  const syncedShopifyIds = new Set(products.map((p) => String(p.id)))
  const now = new Date().toISOString()

  // ── 1. Bulk upsert all products in one round-trip ───────────────────────
  // .select('id, shopify_id') returns the UUIDs we need to attach metafields,
  // avoiding the per-product RT that the old loop required.
  const productRows = products.map((p) => ({
    feed_id: feedId,
    shopify_id: String(p.id),
    title: p.title,
    body_html: p.body_html,
    vendor: p.vendor,
    product_type: p.product_type,
    status: p.status,
    handle: p.handle,
    published_at: p.published_at,
    tags: p.tags,
    images: p.images,
    variants: p.variants,
    collections: p.collections,
    synced_at: now,
    updated_at: now,
  }))

  let upserted: { id: string; shopify_id: string }[] = []
  if (productRows.length > 0) {
    const { data, error: upsertErr } = await db
      .from('products')
      .upsert(productRows, { onConflict: 'feed_id,shopify_id' })
      .select('id, shopify_id')
    if (upsertErr) throw new Error(`Bulk upsert of products failed: ${upsertErr.message}`)
    upserted = data ?? []
  }
  const tUpsertProducts = Date.now()
  console.log(
    `[sync] bulk upsert ${productRows.length} produkter → 1 RT: ${tUpsertProducts - tFetch}ms`
  )

  const idByShopifyId = new Map<string, string>()
  for (const row of upserted) {
    idByShopifyId.set(row.shopify_id, row.id)
  }

  // ── 2. Bulk delete all metafields for these products ────────────────────
  // PostgREST sender .in()-værdier i URL'en (?product_id=in.(uuid1,uuid2,...))
  // og ved nogle tusinde UUID'er rammer URL-længde-grænsen / IN-clause-loftet.
  // Chunk derfor i grupper på max 500 og kør parallelt.
  const allUuids = Array.from(idByShopifyId.values())
  const DELETE_CHUNK_SIZE = 500
  const deleteChunks: string[][] = []
  for (let i = 0; i < allUuids.length; i += DELETE_CHUNK_SIZE) {
    deleteChunks.push(allUuids.slice(i, i + DELETE_CHUNK_SIZE))
  }
  if (deleteChunks.length > 0) {
    const results = await Promise.all(
      deleteChunks.map((chunk) =>
        db.from('product_metafields').delete().eq('feed_id', feedId).in('product_id', chunk)
      )
    )
    for (const r of results) {
      if (r.error) throw new Error(`Bulk delete of metafields failed: ${r.error.message}`)
    }
  }
  const tDeleteMfs = Date.now()
  console.log(
    `[sync] bulk delete metafields → ${deleteChunks.length} chunk(s) parallelt: ${tDeleteMfs - tUpsertProducts}ms`
  )

  // ── 3. Bulk upsert all metafields ───────────────────────────────────────
  const allMetafields: Array<{
    feed_id: string
    product_id: string
    namespace: string
    key: string
    value: string | null
    type: string | null
  }> = []
  for (const p of products) {
    const productUuid = idByShopifyId.get(String(p.id))
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

  if (allMetafields.length > 0) {
    const { error: mfErr } = await db
      .from('product_metafields')
      .upsert(allMetafields, { onConflict: 'feed_id,product_id,namespace,key' })
    if (mfErr) throw new Error(`Bulk upsert of metafields failed: ${mfErr.message}`)
  }
  const tUpsertMfs = Date.now()
  console.log(
    `[sync] bulk upsert ${allMetafields.length} metafields → ${allMetafields.length > 0 ? 1 : 0} RT: ${tUpsertMfs - tDeleteMfs}ms`
  )

  // ── Cleanup: delete Shopify products that disappeared (per feed) ────────
  const { data: existingProducts, error: fetchErr } = await db
    .from('products')
    .select('id, shopify_id')
    .eq('feed_id', feedId)

  if (fetchErr) throw new Error(`Fetch for cleanup failed: ${fetchErr.message}`)

  const staleIds = (existingProducts ?? [])
    .filter((row) => !syncedShopifyIds.has(row.shopify_id))
    .map((row) => row.id)

  // Samme PostgREST URL-længde-grænse som ved metafield-delete: chunk i 500
  // og slet parallelt. Med MAX_PRODUCTS-cap'en kan staleIds nemt være tusinder
  // (alt i DB der ikke kom med i denne syncs page-cap).
  const STALE_CHUNK_SIZE = 500
  const staleChunks: string[][] = []
  for (let i = 0; i < staleIds.length; i += STALE_CHUNK_SIZE) {
    staleChunks.push(staleIds.slice(i, i + STALE_CHUNK_SIZE))
  }
  if (staleChunks.length > 0) {
    const results = await Promise.all(
      staleChunks.map((chunk) => db.from('products').delete().in('id', chunk))
    )
    for (const r of results) {
      if (r.error) throw new Error(`Cleanup of stale products failed: ${r.error.message}`)
    }
  }
  const tCleanup = Date.now()
  console.log(
    `[sync] cleanup (${staleIds.length} stale produkter, ${staleChunks.length} chunk(s) parallelt): ${tCleanup - tUpsertMfs}ms`
  )

  const totalMs = Date.now() - t0
  console.log(`[sync] TOTAL: ${totalMs}ms`)

  return {
    synced: products.length,
    metafields: allMetafields.length,
    durationMs: totalMs,
    warnings: metaobjectWarnings(shopifyData.metaobjects),
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
      status: (p.status as 'active' | 'draft' | 'archived') ?? 'active',
      tags: p.tags ?? '',
      published_scope: '',
      template_suffix: null,
      admin_graphql_api_id: '',
      variants: (p.variants as unknown[]) as import('@/lib/shopify').ShopifyVariant[],
      options: [],
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
