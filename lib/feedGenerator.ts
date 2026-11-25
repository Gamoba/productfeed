import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseProduct } from '@/lib/sync'
import {
  resolveField,
  applyFeedFilters,
  activeFilterSides,
  explainScope,
  describeRule,
  isActiveRule,
  ruleMatches,
  type FeedFilter,
} from '@/lib/feedFilters'
import { extractWithPatterns, type ExtractConfig } from '@/lib/mappingExtract'
import { createItemEvaluator, isMappedRef, type EvalMasterField, type ItemEvaluator } from '@/lib/mappingEval'
import { loadMasterFieldsForFeed } from '@/lib/masterFields'

// ── Types ──────────────────────────────────────────────────────────────────

type MappingType =
  | 'FIELD'
  | 'STATIC'
  | 'COMBINE'
  | 'PREFIX_SUFFIX'
  | 'FIND_REPLACE'
  | 'TRUNCATE'
  | 'STRIP_HTML'
  | 'LOOKUP'
  | 'EXTRACT'
  | 'MASTER'
  | 'AI'

type Config = Record<string, unknown>

type FeedMapping = {
  google_field: string
  mapping_type: MappingType
  config: Config
}

type StoredVariant = {
  id: number
  title: string
  price: string | null
  sku: string | null
  compare_at_price: string | null
  option1: string | null
  option2: string | null
  option3: string | null
  barcode: string | null
  inventory_quantity: number | null
}

export type FeedResult = {
  xml: string
  productCount: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Base URL that product links are built on, for one feed.
//
// First choice is the selected market's rootUrl (shop_settings.market_url) — it
// carries the right locale subfolder/subdomain. Markets without a Shopify
// Markets web presence have none, so we fall back to the owning project's own
// storefront domain (projects.primary_domain, migration 030). Returns null when
// neither is known, and resolveField('url') then yields an empty link rather
// than a link to some other merchant's shop.
async function resolveFeedBaseUrl(
  db: ReturnType<typeof adminClient>,
  feedId: string,
  marketUrl: string | null
): Promise<string | null> {
  if (marketUrl) return marketUrl

  const { data: feed } = await db
    .from('feeds')
    .select('project_id')
    .eq('id', feedId)
    .maybeSingle()
  if (!feed?.project_id) return null

  const { data: project } = await db
    .from('projects')
    .select('primary_domain')
    .eq('id', feed.project_id)
    .maybeSingle()

  const domain = (project?.primary_domain as string | null) ?? null
  return domain?.trim() ? domain.trim() : null
}

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// The per-item mapping evaluator (lib/mappingEval): source fields read through
// resolveField, `feed:<field>` references read other mappings' final values,
// `master:<key>` reads the shop's master fields, and an accepted AI title is
// applied to the title mapping.
function itemEvaluator(
  mappings: FeedMapping[],
  masters: EvalMasterField[],
  item: SupabaseProduct,
  marketUrl: string | null,
  aiTitle: string | null,
  aiPlaceholder?: string
): ItemEvaluator {
  return createItemEvaluator({
    mappings,
    masters,
    resolveSource: (field) => resolveField(field, item, marketUrl),
    aiTitle,
    aiPlaceholder,
  })
}

// Every mapping type except AI is evaluated by lib/mappingEval (shared with the
// editor preview). AI is the one main function that's async and server-only.
async function aiMainValue(
  config: Config,
  product: SupabaseProduct,
  anthropic: Anthropic | null
): Promise<string> {
  if (!anthropic) return ''
  const prompt = String(config.prompt ?? '')
  if (!prompt) return ''
  const productData = {
    id: product.shopify_id,
    title: product.title,
    vendor: product.vendor,
    product_type: product.product_type,
    tags: product.tags,
    status: product.status,
    variants: product.variants,
    metafields: product.metafields.map((m) => ({
      key: `${m.namespace}.${m.key}`,
      value: m.value,
    })),
  }
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `${prompt}\n\nProduktdata:\n${JSON.stringify(productData, null, 2)}`,
      },
    ],
  })
  const block = msg.content[0]
  return block.type === 'text' ? block.text.trim() : ''
}

// Resolves one mapping for one item: main function → the branch its rules
// select → the transform layer (lib/mappingEval.finishValue). Transforms run
// LAST, on whichever branch won, so a "strip HTML" filter cleans the ELSE value
// as well as the primary one.
//
// Non-AI mappings come straight from the item evaluator (memoised, so a field
// that other mappings reference is computed once). AI mappings get their main
// value from the API here, then the same branch + transform step.
async function resolvedValue(
  ev: ItemEvaluator,
  mapping: FeedMapping,
  item: SupabaseProduct,
  anthropic: Anthropic | null
): Promise<string> {
  const v = ev.value(mapping.google_field)
  if (v !== null) return v
  const base = await aiMainValue(mapping.config, item, anthropic)
  return ev.finish(mapping.google_field, base)
}

function xmlLine(field: string, value: string): string {
  // User-defined custom fields (saved as "custom:foo") are written without
  // the g: namespace — they're not part of the Google Shopping spec, so the
  // tag is just the bare name. Validation client-side restricts the suffix
  // to [A-Za-z0-9_], which is XML-safe.
  if (field.startsWith('custom:')) {
    const tag = field.slice('custom:'.length)
    return `      <g:${tag}>${xmlEscape(value)}</g:${tag}>`
  }
  return `      <g:${field}>${xmlEscape(value)}</g:${field}>`
}

// Returns a copy of the product with the given variant placed at variants[0].
function withVariantFirst(product: SupabaseProduct, variant: StoredVariant): SupabaseProduct {
  const rest = (product.variants as StoredVariant[]).filter((v) => v.id !== variant.id)
  return { ...product, variants: [variant, ...rest] as unknown[] }
}

// The default <g:id> for one feed item: shopify_id in product mode,
// shopify_id_variantId in variant mode. Used when id is unmapped, and exposed to
// mappings as the "id" source field (resolveField reads feed_item_id).
function withFeedItemId(product: SupabaseProduct, id: string): SupabaseProduct {
  return { ...product, feed_item_id: id } as SupabaseProduct
}

// <g:id> for one item. An id mapping is honoured (e.g. Combine "shopify_ZZ_" +
// Product ID + "_" + Variant ID to match the Shopify Google app's ids); with no
// mapping, or one that resolves empty, the auto id is used. The default mapping
// (FIELD "id") resolves to exactly the auto id, so existing feeds are unchanged.
async function resolveItemId(
  ev: ItemEvaluator,
  idMapping: FeedMapping | undefined,
  product: SupabaseProduct,
  anthropic: Anthropic | null
): Promise<string> {
  const auto = String((product as Record<string, unknown>).feed_item_id ?? '')
  if (!idMapping) return auto
  const value = (await resolvedValue(ev, idMapping, product, anthropic)).trim()
  return value || auto
}

// ── Filter counts (used by dashboard) ──────────────────────────────────────

export async function countFilteredProducts(
  feedId: string
): Promise<{ total: number; included: number }> {
  const db = adminClient()

  const { data: filtersData } = await db
    .from('feed_filters')
    .select('filter_type, operator, rules')
    .eq('feed_id', feedId)
  const filterRows = (filtersData ?? []) as FeedFilter[]
  const sides = activeFilterSides(filterRows)

  // No rule that filters anything: every active product is in the feed, and
  // the database can count them without sending a single row (~0.1 s instead
  // of ~4 s for 2.5k products). Most feeds look like this.
  if (!sides.include && !sides.exclude) {
    const { count, error } = await db
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('feed_id', feedId)
      .eq('status', 'active')
    if (error) throw new Error(`Product count failed: ${error.message}`)
    return { total: count ?? 0, included: count ?? 0 }
  }

  // With rules, fetch only the columns they read (no body_html, images…),
  // only the metafields the rules name, AI titles only for title rules.
  const ruleFields = [sides.include, sides.exclude].flatMap((f) => (f?.rules ?? []).map((r) => r.field ?? ''))
  const metafieldKeys = ruleFields
    .filter((f) => f.startsWith('metafield:'))
    .map((f) => f.slice('metafield:'.length))
    .filter((rest) => rest.includes('.'))
    .map((rest) => ({ namespace: rest.slice(0, rest.indexOf('.')), key: rest.slice(rest.indexOf('.') + 1) }))
  const needsMetafields = metafieldKeys.length > 0
  const needsAiTitles = ruleFields.includes('ai_optimized_title')
  const columns = countColumns(ruleFields)

  const { data: shopSettingsData } = await db
    .from('shop_settings')
    .select('market_url')
    .eq('feed_id', feedId)
    .maybeSingle()
  const [rawProducts, marketUrl] = await Promise.all([
    fetchAllActiveProducts(db, feedId, { withMetafields: needsMetafields, columns, metafieldKeys }),
    resolveFeedBaseUrl(db, feedId, (shopSettingsData?.market_url as string | null) ?? null),
  ])
  // A rule on ai_optimized_title must count the same products as the
  // generator emits, so the accepted titles are attached for those.
  if (needsAiTitles) await attachOptimizedTitles(db, feedId, rawProducts)
  const filtered = applyFeedFilters(rawProducts, filterRows, marketUrl)

  return { total: rawProducts.length, included: filtered.length }
}

// The product columns a set of rule fields reads (see resolveField). Any field
// it doesn't recognise falls back to every column, so an unusual rule (one
// written through the API, say) is still counted correctly, just slower.
const PRODUCT_COLUMNS = new Set([
  'title', 'vendor', 'product_type', 'status', 'handle', 'published_at', 'tags', 'images', 'variants',
  'collections', 'synced_at', 'created_at', 'updated_at', 'body_html', 'options', 'link',
])
function countColumns(fields: string[]): string {
  const cols = new Set(['id', 'shopify_id'])
  for (const f of fields) {
    if (!f || f.startsWith('metafield:')) continue
    if (f === 'url') cols.add('link').add('handle')
    else if (f === 'ai_optimized_title') cols.add('title')
    else if (f === 'id' || f === 'item_group_id' || f === 'shopify_id') continue
    else if (/^variants\[\d+\]\./.test(f)) cols.add('variants')
    else if (/^images\[\d+\]\./.test(f)) cols.add('images')
    else if (PRODUCT_COLUMNS.has(f)) cols.add(f)
    else return '*'
  }
  return [...cols].join(', ')
}

// ── Extract coverage (used by the mapping editor) ──────────────────────────

export type ExtractCoverage = {
  feedMode: 'product' | 'variant'
  // Feed items checked: products in product mode, variants in variant mode —
  // after the feed's filters, i.e. exactly the items the feed would contain.
  total: number
  matched: number
  // How many items each pattern caught (index-aligned with config.patterns).
  perPattern: number[]
  // The most common output values, most frequent first — the quickest way to
  // spot a pattern that matches but produces the wrong thing.
  topValues: { value: string; count: number }[]
  // A sample of items no pattern matched, with the input they were tested on.
  unmatched: { id: string; title: string; input: string }[]
}

const COVERAGE_TOP_VALUES = 30
const COVERAGE_UNMATCHED_SAMPLE = 25

/**
 * Runs an EXTRACT config over every item the feed would emit and reports how
 * well it covers them. Read-only and cheap: the regexes are compiled once
 * (lib/mappingExtract caches them) and metafields are only loaded when the
 * source field or a feed filter needs them.
 *
 * Ignores the mapping's Only-if and filters on purpose — the question it
 * answers is "do my patterns find the value", not "what does the feed say".
 */
export async function extractCoverage(feedId: string, config: ExtractConfig): Promise<ExtractCoverage> {
  const db = adminClient()
  const field = config.field ?? ''

  // A `feed:<field>` / `master:<key>` source reads another mapping's value, so
  // the SAVED mappings are needed (unsaved edits to that other field aren't seen).
  const fromMapping = isMappedRef(field)
  const [{ data: settingsData }, { data: shopSettingsData }, { data: filtersData }, { data: mappingsData }] =
    await Promise.all([
      db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
      db.from('shop_settings').select('market_url').eq('feed_id', feedId).maybeSingle(),
      db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId),
      fromMapping
        ? db.from('feed_mappings').select('google_field, mapping_type, config').eq('feed_id', feedId)
        : Promise.resolve({ data: [] as FeedMapping[] }),
    ])
  const feedMode = (settingsData?.feed_mode as 'product' | 'variant') ?? 'product'
  const filterRows = (filtersData ?? []) as FeedFilter[]
  const mappings = ((mappingsData ?? []) as FeedMapping[]).filter((m) => m.mapping_type)
  const masters = fromMapping ? await loadMasterFieldsForFeed(db, feedId) : []
  const needsMetafields =
    fromMapping || // can't tell cheaply what the referenced mapping reads
    field.startsWith('metafield:') ||
    filterRows.some((f) => (f.rules ?? []).some((r) => r.field?.startsWith('metafield:')))

  const [rawProducts, marketUrl] = await Promise.all([
    fetchAllActiveProducts(db, feedId, { withMetafields: needsMetafields }),
    resolveFeedBaseUrl(db, feedId, (shopSettingsData?.market_url as string | null) ?? null),
  ])
  await attachOptimizedTitles(db, feedId, rawProducts)
  const products = applyFeedFilters(rawProducts, filterRows, marketUrl)

  const patterns = config.patterns ?? []
  const perPattern = patterns.map(() => 0)
  const counts = new Map<string, number>()
  const unmatched: ExtractCoverage['unmatched'] = []
  let total = 0
  let matched = 0

  const check = (item: SupabaseProduct, id: string) => {
    total++
    const input = fromMapping
      ? itemEvaluator(mappings, masters, item, marketUrl, aiTitleFor(item)).resolve(field)
      : resolveField(field, item, marketUrl)
    const r = extractWithPatterns(input, patterns, config.lookup)
    if (r.patternIndex >= 0) {
      matched++
      perPattern[r.patternIndex]++
      counts.set(r.value, (counts.get(r.value) ?? 0) + 1)
    } else if (unmatched.length < COVERAGE_UNMATCHED_SAMPLE) {
      unmatched.push({ id, title: item.title ?? '', input })
    }
  }

  for (const product of products) {
    if (feedMode === 'product') {
      const id = String(product.shopify_id ?? '')
      check(withFeedItemId(product, id), id)
    } else {
      for (const variant of product.variants as StoredVariant[]) {
        const id = `${product.shopify_id}_${variant.id}`
        check(withFeedItemId(withVariantFirst(product, variant), id), id)
      }
    }
  }

  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, COVERAGE_TOP_VALUES)
    .map(([value, count]) => ({ value, count }))

  return { feedMode, total, matched, perPattern, topValues, unmatched }
}

// ── Main export ────────────────────────────────────────────────────────────

// PostgREST defaults to a 1000-row cap (Supabase's db-max-rows). For a feed
// that needs every active product, page through with .range() until exhausted.
//
// PAGE_SIZE is well BELOW that cap on purpose: each page embeds every product's
// metafields, and the whole page is one statement under the 8 s statement
// timeout. A metaobject-heavy store (BWH, ~24 metafields/product after
// metaobject resolution) took ~9 s for 1000 products → "statement timeout" →
// 500 on feed generation. 250 is ~2.5 s there, leaving headroom for growth.
const PAGE_SIZE = 250
// Without the metafield embed a page is cheap; go up to PostgREST's cap.
const PAGE_SIZE_NO_METAFIELDS = 1000

// `withMetafields: false` skips the embed (metafields come back as []) — for
// callers that provably never read them, e.g. counting a feed whose filter
// rules reference no metafield. On a metaobject-heavy store the embed is the
// bulk of the cost.
async function fetchAllActiveProducts(
  db: ReturnType<typeof adminClient>,
  feedId: string,
  {
    withMetafields = true,
    columns = '*',
    metafieldKeys,
    stopAfter,
  }: {
    withMetafields?: boolean
    columns?: string
    /** Only these metafields (namespace + key), e.g. the ones a rule reads. */
    metafieldKeys?: { namespace: string; key: string }[]
    /** Called with each page as it arrives; returning true stops reading. */
    stopAfter?: (page: SupabaseProduct[]) => boolean
  } = {}
): Promise<SupabaseProduct[]> {
  // A handful of named metafields is small, so those pages can be as big as
  // pages without metafields.
  const someMetafields = withMetafields && !!metafieldKeys?.length
  const pageSize = withMetafields && !someMetafields ? PAGE_SIZE : PAGE_SIZE_NO_METAFIELDS
  const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const metafieldFilter = someMetafields
    ? metafieldKeys!.map((m) => `and(namespace.eq.${quote(m.namespace)},key.eq.${quote(m.key)})`).join(',')
    : null
  const out: SupabaseProduct[] = []
  let from = 0
  while (true) {
    let query = db
      .from('products')
      .select(
        someMetafields
          ? `${columns}, metafields:product_metafields(namespace, key, value)`
          : withMetafields
            ? `${columns}, metafields:product_metafields(*)`
            : columns
      )
    // Filters the embedded metafields only; products without them still come.
    if (metafieldFilter) query = query.or(metafieldFilter, { referencedTable: 'metafields' })
    const { data, error } = await query
      .eq('feed_id', feedId)
      .eq('status', 'active')
      // created_at alone is NOT stable across pages — bulk imports share a
      // timestamp, so offset pagination over the ties duplicates/skips rows at
      // page boundaries (duplicate <item>s in the feed). id is the tiebreaker.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Products failed: ${error.message}`)
    if (!data || data.length === 0) break
    const rows = data as unknown as SupabaseProduct[]
    if (!withMetafields) for (const p of rows) p.metafields = []
    out.push(...rows)
    if (stopAfter?.(rows)) break
    if (data.length < pageSize) break
    from += pageSize
  }
  return out
}

/**
 * Every active product of a feed, with metafields — the input generateFeed,
 * generatePreview and validateFeed all need. Load it ONCE and pass it to each
 * (`{ products }`) when running them together: each one loading its own copy
 * meant two or three full catalogue reads per "Generate" click, which on a
 * metaobject-heavy store competed for the database's CPU for a minute.
 *
 * Sharing is safe: none of them mutates the products, except
 * attachOptimizedTitles, which writes the same accepted title either way.
 */
export async function loadFeedProducts(feedId: string): Promise<SupabaseProduct[]> {
  return fetchAllActiveProducts(adminClient(), feedId)
}

/** Preloaded input for generateFeed / generatePreview / validateFeed. */
export type FeedInput = { products?: SupabaseProduct[] }

// The AI-optimized title accepted for this feed, or null.
//
// An accepted title OVERRIDES the title field no matter how it is mapped — the
// mapping still runs for every other field, but whatever it produced for `title`
// is discarded in favour of this. Optimizing a product is therefore the decision
// to publish that title; there is no separate opt-in on the mapping.
//
// Only ai_generated / human_edited rows carry a value. Proposals still sitting
// in needs_review have optimized_title = NULL, enforced by a CHECK constraint
// (migration 021), so an unreviewed title cannot reach the feed through here.
function aiTitleFor(product: SupabaseProduct): string | null {
  const t = (product as Record<string, unknown>).optimized_title
  return typeof t === 'string' && t.trim() !== '' ? t : null
}

// Loads product_ref → optimized_title for the feed (only rows that have an
// accepted title: ai_generated / human_edited; needs_review has none). Paged
// with a stable order so large feeds don't drop rows at page boundaries.
async function fetchOptimizedTitles(
  db: ReturnType<typeof adminClient>,
  feedId: string
): Promise<Map<string, string>> {
  const PAGE_SIZE = 1000
  const map = new Map<string, string>()
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('product_title_optimizations')
      .select('product_ref, optimized_title')
      .eq('feed_id', feedId)
      .not('optimized_title', 'is', null)
      .order('product_ref', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Optimized titles failed: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data as { product_ref: string; optimized_title: string }[]) {
      map.set(r.product_ref, r.optimized_title)
    }
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return map
}

// Attaches optimized_title onto each product so resolveField('ai_optimized_title')
// can read it. Only called when a mapping actually uses the AI title source.
async function attachOptimizedTitles(
  db: ReturnType<typeof adminClient>,
  feedId: string,
  products: SupabaseProduct[]
): Promise<void> {
  const map = await fetchOptimizedTitles(db, feedId)
  for (const p of products) {
    const opt = map.get(p.shopify_id)
    if (opt) (p as Record<string, unknown>).optimized_title = opt
  }
}

type BucketCustomLabel = { index: number; value: string }

// Loads product_ref → { custom_label index, value } for every product that
// belongs to a bucket with a custom label set (migration 027). One product
// belongs to exactly one bucket, so each ref maps to at most one label. Paged
// with a stable order so large feeds don't drop rows at page boundaries.
async function fetchBucketCustomLabels(
  db: ReturnType<typeof adminClient>,
  feedId: string
): Promise<Map<string, BucketCustomLabel>> {
  const map = new Map<string, BucketCustomLabel>()

  const { data: bkts, error: bErr } = await db
    .from('optimization_buckets')
    .select('id, custom_label_index, custom_label_value')
    .eq('feed_id', feedId)
    .not('custom_label_value', 'is', null)
  if (bErr) throw new Error(`Bucket custom labels failed: ${bErr.message}`)

  const labelByBucket = new Map<string, BucketCustomLabel>()
  for (const b of (bkts ?? []) as { id: string; custom_label_index: number | null; custom_label_value: string | null }[]) {
    if (b.custom_label_index !== null && b.custom_label_value) {
      labelByBucket.set(b.id, { index: b.custom_label_index, value: b.custom_label_value })
    }
  }
  if (labelByBucket.size === 0) return map

  const bucketIds = [...labelByBucket.keys()]
  const PAGE_SIZE = 1000
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('bucket_products')
      .select('product_ref, bucket_id')
      .eq('feed_id', feedId)
      .in('bucket_id', bucketIds)
      .order('product_ref', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Bucket members failed: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data as { product_ref: string; bucket_id: string }[]) {
      const lbl = labelByBucket.get(r.bucket_id)
      if (lbl) map.set(r.product_ref, lbl)
    }
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return map
}

// Which custom_label_N indices a feed-level mapping already emits. A feed mapping
// WINS over a bucket label for the same index, so we skip the bucket label there
// (the conflict is surfaced in the bucket UI, not silently overwritten).
function mappedCustomLabelIndices(mappings: FeedMapping[]): Set<number> {
  const set = new Set<number>()
  for (const m of mappings) {
    const cm = /^custom_label_([0-4])$/.exec(m.google_field)
    if (cm) set.add(Number(cm[1]))
  }
  return set
}

export async function generateFeed(feedId: string, input: FeedInput = {}): Promise<FeedResult> {
  const db = adminClient()

  const [
    { data: settingsData },
    { data: shopSettingsData },
    { data: mappingsData, error: mappingsErr },
    rawProducts,
    { data: filtersData },
  ] = await Promise.all([
    db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
    db.from('shop_settings').select('market_url, selected_market_id, selected_locale').eq('feed_id', feedId).maybeSingle(),
    db.from('feed_mappings').select('google_field, mapping_type, config').eq('feed_id', feedId),
    input.products ?? fetchAllActiveProducts(db, feedId),
    db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId),
  ])

  if (mappingsErr) throw new Error(`Mappings failed: ${mappingsErr.message}`)

  const feedMode = (settingsData?.feed_mode as 'product' | 'variant') ?? 'product'
  const marketUrl = await resolveFeedBaseUrl(
    db,
    feedId,
    (shopSettingsData?.market_url as string | null) ?? null
  )

  const mappings = ((mappingsData ?? []) as FeedMapping[]).filter(
    (m) => m.mapping_type && m.mapping_type !== ('' as MappingType)
  )
  const masters = await loadMasterFieldsForFeed(db, feedId)

  const filterRows = (filtersData ?? []) as FeedFilter[]
  const idMapping = mappings.find((m) => m.google_field === 'id')

  // Hydrate optimized_title onto every product before fields are resolved. Done
  // unconditionally — an accepted AI title overrides the title field regardless
  // of how it is mapped, so we can't tell from the mappings whether it's needed.
  // Costs one indexed query that returns nothing on feeds with no optimizations.
  await attachOptimizedTitles(db, feedId, rawProducts)

  // Per-bucket custom labels (split-testing). A product's bucket label is emitted
  // as <g:custom_label_N> UNLESS a feed mapping already covers that N (mapping
  // wins). Empty maps when no bucket has a label set, so the cost is one cheap
  // query for feeds that don't use this.
  const customLabelByRef = await fetchBucketCustomLabels(db, feedId)
  const mappedClIndices = mappedCustomLabelIndices(mappings)
  const customLabelLine = (product: SupabaseProduct): string | null => {
    const lbl = customLabelByRef.get(product.shopify_id)
    if (!lbl || mappedClIndices.has(lbl.index)) return null
    return xmlLine(`custom_label_${lbl.index}`, lbl.value)
  }

  const products = applyFeedFilters(rawProducts, filterRows, marketUrl)

  const needsAi = mappings.some((m) => m.mapping_type === 'AI')
  const anthropic =
    needsAi && process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null

  const items: string[] = []

  if (feedMode === 'product') {
    for (const rawProduct of products) {
      const product = withFeedItemId(rawProduct, String(rawProduct.shopify_id ?? ''))
      const lines: string[] = []
      // The accepted AI title is applied inside the evaluator: it replaces the
      // title mapping (an AI-type one costs no API call), except a skip-empty
      // Combine, which builds on it — see lib/mappingEval.
      const ev = itemEvaluator(mappings, masters, product, marketUrl, aiTitleFor(product))

      // g:id: the id mapping if any, else shopify_id. item_group_id mappings are
      // skipped — no meaning in product mode (no variant grouping).
      if (product.shopify_id) {
        const id = await resolveItemId(ev, idMapping, product, anthropic)
        if (id) lines.push(xmlLine('id', id))
      }

      for (const mapping of mappings) {
        if (mapping.google_field === 'id' || mapping.google_field === 'item_group_id') continue
        const value = await resolvedValue(ev, mapping, product, anthropic)
        if (value !== '') lines.push(xmlLine(mapping.google_field, value))
      }

      // Bucket custom label (split-test) — after mappings; skipped when a mapping
      // already covers that custom_label_N.
      const clLine = customLabelLine(product)
      if (clLine) lines.push(clLine)

      if (lines.length > 0) items.push(`    <item>\n${lines.join('\n')}\n    </item>`)
    }
  } else {
    // VARIANT mode — one feed item per variant
    const mappedFields = new Set(mappings.map((m) => m.google_field))

    for (const product of products) {
      const variants = product.variants as StoredVariant[]
      if (!variants.length) continue

      for (const variant of variants) {
        const vProduct = withFeedItemId(
          withVariantFirst(product, variant),
          `${product.shopify_id}_${variant.id}`
        )

        // Apply mapping rules; id is resolved separately below, item_group_id is
        // always the product's shopify_id
        const mappedLines: string[] = []
        const addedFields = new Set<string>()
        // Same AI-title handling as product mode. The AI title is
        // product-level, so every variant of the product carries it.
        const ev = itemEvaluator(mappings, masters, vProduct, marketUrl, aiTitleFor(product))

        for (const mapping of mappings) {
          if (mapping.google_field === 'id' || mapping.google_field === 'item_group_id') continue
          const value = await resolvedValue(ev, mapping, vProduct, anthropic)
          if (value !== '') {
            mappedLines.push(xmlLine(mapping.google_field, value))
            addedFields.add(mapping.google_field)
          }
        }

        // Bucket custom label applies to the product, so every variant carries it.
        const clLine = customLabelLine(product)
        if (clLine) mappedLines.push(clLine)

        // Always-inject: id (mapping-aware) and item_group_id
        const autoLines: string[] = [
          xmlLine('id', await resolveItemId(ev, idMapping, vProduct, anthropic)),
          xmlLine('item_group_id', product.shopify_id),
        ]

        // Auto-fill title if not covered by a mapping. The AI title stands in for
        // the product title here rather than replacing the whole string — it's a
        // product-level title, and dropping the variant suffix would give every
        // variant in the group the same title.
        if (!mappedFields.has('title') || !addedFields.has('title')) {
          const suffix =
            variant.title && variant.title !== 'Default Title' ? ` - ${variant.title}` : ''
          const base = aiTitleFor(product) ?? product.title ?? ''
          const autoTitle = `${base}${suffix}`.trim()
          if (autoTitle) autoLines.push(xmlLine('title', autoTitle))
        }

        // Auto-fill availability if not covered by a mapping
        if (!mappedFields.has('availability') || !addedFields.has('availability')) {
          const avail = (variant.inventory_quantity ?? 0) > 0 ? 'in_stock' : 'out_of_stock'
          autoLines.push(xmlLine('availability', avail))
        }

        const allLines = [...autoLines, ...mappedLines]
        if (allLines.length > 0) {
          items.push(`    <item>\n${allLines.join('\n')}\n    </item>`)
        }
      }
    }
  }

  const itemCount =
    feedMode === 'product'
      ? products.length
      : products.reduce((sum, p) => sum + (p.variants as unknown[]).length, 0)

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Product Feed</title>
    <link>https://google.com</link>
    <description>Google Shopping Feed</description>
${items.join('\n')}
  </channel>
</rss>`

  return { xml, productCount: itemCount }
}

// ── Preview ────────────────────────────────────────────────────────────────

export type PreviewRow = {
  productId: string
  title: string
  fields: Record<string, string>
}

export type PreviewData = {
  feedMode: 'product' | 'variant'
  rows: PreviewRow[]
  googleFields: string[]
  totalProducts: number
}

export async function generatePreview(
  feedId: string,
  limit = 100,
  input: FeedInput = {}
): Promise<PreviewData> {
  const db = adminClient()

  // Without preloaded products only the first `limit` rows are needed, so the
  // catalogue is read page by page (same order as the feed) until the sample is
  // full, and the total comes from countFilteredProducts. Reading every product
  // with all its metafields for a 20-row sample took ~28 s on an 11k feed.
  const sampling = !input.products
  const [
    { data: settingsData },
    { data: shopSettingsData },
    { data: mappingsData },
    { data: filtersData },
    counted,
  ] = await Promise.all([
    db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
    db.from('shop_settings').select('market_url, selected_market_id, selected_locale').eq('feed_id', feedId).maybeSingle(),
    db.from('feed_mappings').select('google_field, mapping_type, config').eq('feed_id', feedId),
    db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId),
    sampling ? countFilteredProducts(feedId) : Promise.resolve(null),
  ])
  const feedMode = (settingsData?.feed_mode as 'product' | 'variant') ?? 'product'
  const marketUrl = await resolveFeedBaseUrl(
    db,
    feedId,
    (shopSettingsData?.market_url as string | null) ?? null
  )
  const mappings = ((mappingsData ?? []) as FeedMapping[]).filter(
    (m) => m.mapping_type && m.mapping_type !== ('' as MappingType)
  )
  const masters = await loadMasterFieldsForFeed(db, feedId)
  const filterRows = (filtersData ?? []) as FeedFilter[]
  const idMapping = mappings.find((m) => m.google_field === 'id')

  let filteredProducts: SupabaseProduct[]
  if (sampling) {
    // AI titles are attached page by page, before filtering, exactly as the
    // full read does, so a rule on ai_optimized_title picks the same products.
    const titles = await fetchOptimizedTitles(db, feedId)
    filteredProducts = []
    let rowsSoFar = 0
    await fetchAllActiveProducts(db, feedId, {
      stopAfter: (page) => {
        for (const p of page) {
          const opt = titles.get(p.shopify_id)
          if (opt) (p as Record<string, unknown>).optimized_title = opt
        }
        for (const p of applyFeedFilters(page, filterRows, marketUrl)) {
          filteredProducts.push(p)
          rowsSoFar += feedMode === 'variant' ? (p.variants as unknown[]).length : 1
        }
        return rowsSoFar >= limit
      },
    })
  } else {
    const rawProducts = input.products!
    await attachOptimizedTitles(db, feedId, rawProducts)
    filteredProducts = applyFeedFilters(rawProducts, filterRows, marketUrl)
  }

  let googleFields: string[]
  const rows: PreviewRow[] = []

  if (feedMode === 'product') {
    googleFields = mappings.map((m) => m.google_field)

    for (const rawProduct of filteredProducts.slice(0, limit)) {
      const product = withFeedItemId(rawProduct, String(rawProduct.shopify_id ?? ''))
      const fields: Record<string, string> = {}
      // '__AI__' stands in for AI mappings (no API call in a preview). The
      // evaluator applies the AI title first, so an AI-mapped title shows the
      // optimised title the feed really emits, not the placeholder.
      const ev = itemEvaluator(mappings, masters, product, marketUrl, aiTitleFor(product), '__AI__')
      for (const mapping of mappings) {
        if (mapping.google_field === 'id') {
          // AI-type id mappings would need an API call; show the auto id then.
          fields['id'] = await resolveItemId(
            ev, mapping.mapping_type === 'AI' ? undefined : mapping, product, null
          )
          continue
        }
        fields[mapping.google_field] = ev.value(mapping.google_field) ?? ''
      }
      rows.push({ productId: product.shopify_id, title: product.title ?? product.shopify_id, fields })
    }
  } else {
    const autoFields = ['id', 'item_group_id', 'title', 'availability']
    const extraMapped = mappings
      .filter((m) => !['id', 'item_group_id'].includes(m.google_field))
      .map((m) => m.google_field)
    googleFields = [...new Set([...autoFields, ...extraMapped])]

    outer: for (const product of filteredProducts) {
      const variants = product.variants as StoredVariant[]
      for (const variant of variants) {
        if (rows.length >= limit) break outer
        const vProduct = withFeedItemId(
          withVariantFirst(product, variant),
          `${product.shopify_id}_${variant.id}`
        )
        const fields: Record<string, string> = {}
        const ev = itemEvaluator(mappings, masters, vProduct, marketUrl, aiTitleFor(product), '__AI__')

        fields['id'] = await resolveItemId(
          ev, idMapping?.mapping_type === 'AI' ? undefined : idMapping, vProduct, null
        )
        fields['item_group_id'] = product.shopify_id
        const suffix = variant.title && variant.title !== 'Default Title' ? ` - ${variant.title}` : ''
        fields['title'] = `${aiTitleFor(product) ?? product.title ?? ''}${suffix}`.trim()
        fields['availability'] = (variant.inventory_quantity ?? 0) > 0 ? 'in_stock' : 'out_of_stock'

        for (const mapping of mappings) {
          if (['id', 'item_group_id'].includes(mapping.google_field)) continue
          const value = ev.value(mapping.google_field) ?? ''
          if (value !== '') fields[mapping.google_field] = value
        }

        rows.push({
          productId: fields['id'],
          title: fields['title'] || product.title || product.shopify_id,
          fields,
        })
      }
    }
  }

  return { feedMode, rows, googleFields, totalProducts: counted?.included ?? filteredProducts.length }
}

// ── Feed view of specific products ──────────────────────────────────────────

export type FeedViewItem = {
  // Whether the product makes it into the feed, and why not.
  inFeed: boolean
  reason: string | null
  // Mapped values, product level (first variant), as generatePreview resolves
  // them in product mode. AI mappings without an accepted title read '__AI__'.
  fields: Record<string, string>
}

// The feed's view of a handful of products — the Products page's current page
// — keyed by shopify_id. Uses the same filters, base URL, mappings and accepted
// AI titles as generateFeed, without building the whole feed. Read-only.
export async function feedView(
  feedId: string,
  products: SupabaseProduct[]
): Promise<Map<string, FeedViewItem>> {
  const db = adminClient()
  const [{ data: shopSettingsData }, { data: mappingsData }, { data: filtersData }] = await Promise.all([
    db.from('shop_settings').select('market_url').eq('feed_id', feedId).maybeSingle(),
    db.from('feed_mappings').select('google_field, mapping_type, config').eq('feed_id', feedId),
    db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId),
  ])

  const marketUrl = await resolveFeedBaseUrl(db, feedId, (shopSettingsData?.market_url as string | null) ?? null)
  const mappings = ((mappingsData ?? []) as FeedMapping[]).filter(
    (m) => m.mapping_type && m.mapping_type !== ('' as MappingType)
  )
  const masters = await loadMasterFieldsForFeed(db, feedId)
  const filterRows = (filtersData ?? []) as FeedFilter[]

  // Copies: attachOptimizedTitles writes onto the objects it is given.
  const copies = products.map((p) => ({ ...p }) as SupabaseProduct)
  await attachOptimizedTitles(db, feedId, copies)

  const out = new Map<string, FeedViewItem>()
  for (const raw of copies) {
    const scope = explainScope(raw, filterRows, marketUrl)
    const product = withFeedItemId(raw, String(raw.shopify_id ?? ''))
    const fields: Record<string, string> = {}
    // Same evaluator as generatePreview: '__AI__' for AI mappings (no API call),
    // the accepted AI title applied first.
    const ev = itemEvaluator(mappings, masters, product, marketUrl, aiTitleFor(product), '__AI__')
    for (const mapping of mappings) {
      if (mapping.google_field === 'id') {
        fields['id'] = await resolveItemId(
          ev, mapping.mapping_type === 'AI' ? undefined : mapping, product, null
        )
        continue
      }
      fields[mapping.google_field] = ev.value(mapping.google_field) ?? ''
    }
    out.set(raw.shopify_id, {
      inFeed: scope.inFeed,
      reason: scope.inFeed ? null : scope.reason,
      fields,
    })
  }
  return out
}


// ── Scope preview (Inkludér / ekskludér page) ────────────────────────────────

export type ScopePreviewRule = { label: string; count: number }

export type ScopePreviewProduct = {
  id: string
  title: string
  vendor: string | null
  image: string | null
  stock: number | null
  inFeed: boolean
  reason: string | null
}

export type ScopePreview = {
  // Active products in the shop (the generator only ever considers these).
  total: number
  included: number
  excluded: number
  // How many products each rule decides on its own:
  //  include rules → products the rule alone keeps out
  //  exclude rules → products (that pass the include rules) the rule alone takes out
  includeRules: ScopePreviewRule[]
  excludeRules: ScopePreviewRule[]
  // Products matching `show` and `search`, first `limit` of them.
  products: ScopePreviewProduct[]
  matching: number
}

// Loading every active product is most of a preview's cost (seconds on a
// 10k–30k catalogue), and someone editing rules asks for a preview after every
// change. So the loaded catalogue is kept briefly per feed: edits within
// SCOPE_CACHE_MS only re-run the rules. Best effort and per server instance;
// a sync elsewhere shows up once the entry expires. Small on purpose.
const SCOPE_CACHE_MS = 60_000
const SCOPE_CACHE_MAX = 3
const scopeCache = new Map<string, { at: number; products: SupabaseProduct[] }>()

async function scopeCatalogue(
  db: ReturnType<typeof adminClient>,
  feedId: string,
  withMetafields: boolean
): Promise<SupabaseProduct[]> {
  const key = `${feedId}:${withMetafields ? 'mf' : 'plain'}`
  const hit = scopeCache.get(key)
  if (hit && Date.now() - hit.at < SCOPE_CACHE_MS) return hit.products
  const products = await fetchAllActiveProducts(db, feedId, { withMetafields })
  // A rule on ai_optimized_title must see the same titles the generator does.
  await attachOptimizedTitles(db, feedId, products)
  scopeCache.delete(key)
  scopeCache.set(key, { at: Date.now(), products })
  while (scopeCache.size > SCOPE_CACHE_MAX) scopeCache.delete(scopeCache.keys().next().value as string)
  return products
}

// What a set of include/exclude rules would do to the feed, BEFORE they are
// saved: the same evaluation the generator runs (lib/feedFilters), over every
// active product. Read-only.
export async function scopePreview(
  feedId: string,
  filters: FeedFilter[],
  opts: { show: 'included' | 'excluded'; search?: string; limit?: number }
): Promise<ScopePreview> {
  const db = adminClient()
  const { data: shopSettingsData } = await db
    .from('shop_settings')
    .select('market_url')
    .eq('feed_id', feedId)
    .maybeSingle()

  const needsMetafields = filters.some((f) => (f.rules ?? []).some((r) => r.field?.startsWith('metafield:')))
  const marketUrl = await resolveFeedBaseUrl(db, feedId, (shopSettingsData?.market_url as string | null) ?? null)
  const products = await scopeCatalogue(db, feedId, needsMetafields)

  const includeFilter = filters.find((f) => f.filter_type === 'include')
  const excludeFilter = filters.find((f) => f.filter_type === 'exclude')
  const includeRules = (includeFilter?.rules ?? []).filter(isActiveRule)
  const excludeRules = (excludeFilter?.rules ?? []).filter(isActiveRule)
  const includeCounts = includeRules.map(() => 0)
  const excludeCounts = excludeRules.map(() => 0)

  const q = (opts.search ?? '').trim().toLowerCase()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const out: ScopePreviewProduct[] = []
  let included = 0
  let matching = 0

  for (const p of products) {
    const scope = explainScope(p, filters, marketUrl)
    if (scope.inFeed) included++

    // Per-rule counts. Include: rules this product fails. Exclude: only for
    // products the include rules let through, rules this product matches.
    includeRules.forEach((r, i) => {
      if (!ruleMatches(r, p, marketUrl)) includeCounts[i]++
    })
    const passesInclude =
      !includeFilter || includeFilter.rules.length === 0 || applyFeedFilters([p], [includeFilter], marketUrl).length === 1
    if (passesInclude) {
      excludeRules.forEach((r, i) => {
        if (ruleMatches(r, p, marketUrl)) excludeCounts[i]++
      })
    }

    if (scope.inFeed !== (opts.show === 'included')) continue
    if (q) {
      const hay = `${p.title ?? ''} ${p.vendor ?? ''} ${p.shopify_id ?? ''} ${p.handle ?? ''}`.toLowerCase()
      if (!hay.includes(q)) continue
    }
    matching++
    if (out.length < limit) {
      const variants = (p.variants as { inventory_quantity?: number }[] | null) ?? []
      const qs = variants.map((v) => v.inventory_quantity).filter((n): n is number => typeof n === 'number')
      const images = (p.images as { src?: string }[] | null) ?? []
      out.push({
        id: p.shopify_id,
        title: p.title ?? p.shopify_id,
        vendor: p.vendor ?? null,
        image: images[0]?.src ?? null,
        stock: qs.length ? qs.reduce((a, b) => a + b, 0) : null,
        inFeed: scope.inFeed,
        reason: scope.inFeed ? null : scope.reason,
      })
    }
  }

  return {
    total: products.length,
    included,
    excluded: products.length - included,
    includeRules: includeRules.map((r, i) => ({ label: describeRule(r), count: includeCounts[i] })),
    excludeRules: excludeRules.map((r, i) => ({ label: describeRule(r), count: excludeCounts[i] })),
    products: out,
    matching,
  }
}
