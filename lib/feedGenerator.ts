import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import type { SupabaseProduct } from '@/lib/sync'
import { resolveField, applyFeedFilters, type FeedFilter } from '@/lib/feedFilters'
import { applyTransforms, stripHtml, type FindReplacePair } from '@/lib/mappingTransforms'
import {
  selectBranchValue,
  type CombineBlock,
  type OnlyIf,
} from '@/lib/mappingRules'

// ── Types ──────────────────────────────────────────────────────────────────

type MappingType =
  | 'FIELD'
  | 'STATIC'
  | 'COMBINE'
  | 'PREFIX_SUFFIX'
  | 'FIND_REPLACE'
  | 'TRUNCATE'
  | 'STRIP_HTML'
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

// Binds resolveField to one product, giving the shared rule evaluator
// (lib/mappingRules) the field-reading callback it needs.
function fieldResolver(product: SupabaseProduct, marketUrl: string | null) {
  return (field: string) => resolveField(field, product, marketUrl)
}

async function applyMapping(
  type: MappingType,
  config: Config,
  product: SupabaseProduct,
  anthropic: Anthropic | null,
  marketUrl: string | null
): Promise<string> {
  switch (type) {
    case 'FIELD':
      return resolveField(String(config.field ?? ''), product, marketUrl)

    case 'STATIC':
      return String(config.value ?? '')

    case 'COMBINE': {
      const blocks = (config.blocks as CombineBlock[]) ?? []
      return blocks
        .map((b) => (b.type === 'field' ? resolveField(b.value, product, marketUrl) : b.value))
        .join('')
    }

    case 'PREFIX_SUFFIX': {
      const val = resolveField(String(config.field ?? ''), product, marketUrl)
      if (!val) return ''
      return `${config.prefix ?? ''}${val}${config.suffix ?? ''}`
    }

    case 'FIND_REPLACE': {
      let val = resolveField(String(config.field ?? ''), product, marketUrl)
      for (const pair of (config.pairs as FindReplacePair[]) ?? []) {
        if (pair.find) val = val.split(pair.find).join(pair.replace)
      }
      return val
    }

    case 'TRUNCATE': {
      const val = resolveField(String(config.field ?? ''), product, marketUrl)
      return val.slice(0, Number(config.maxChars ?? 500))
    }

    case 'STRIP_HTML':
      return stripHtml(resolveField(String(config.field ?? ''), product, marketUrl))

    case 'AI': {
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

    default:
      return ''
  }
}

// Resolves one mapping for one product: run its main function, pick the branch
// its rules select, then push the result through the transform layer.
//
// Order matters and is deliberate. Transforms run LAST, on whichever branch
// won — so a "strip HTML" filter cleans the ELSE value just as it cleans the
// primary one, and the user doesn't have to repeat the filter per branch.
async function resolvedValue(
  mapping: FeedMapping,
  product: SupabaseProduct,
  anthropic: Anthropic | null,
  marketUrl: string | null
): Promise<string> {
  const base = await applyMapping(mapping.mapping_type, mapping.config, product, anthropic, marketUrl)
  const resolve = fieldResolver(product, marketUrl)
  const value = selectBranchValue(mapping.config.onlyIf as OnlyIf | undefined, base, resolve)
  return applyTransforms(value, mapping.config.transforms)
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

// ── Filter counts (used by dashboard) ──────────────────────────────────────

export async function countFilteredProducts(
  feedId: string
): Promise<{ total: number; included: number }> {
  const db = adminClient()

  const [
    { data: shopSettingsData },
    rawProducts,
    { data: filtersData },
  ] = await Promise.all([
    db.from('shop_settings').select('market_url').eq('feed_id', feedId).maybeSingle(),
    fetchAllActiveProducts(db, feedId),
    db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId),
  ])

  const marketUrl = await resolveFeedBaseUrl(
    db,
    feedId,
    (shopSettingsData?.market_url as string | null) ?? null
  )
  // Hydrate here too: a filter rule on ai_optimized_title must count the same
  // number of products as the generator actually emits.
  await attachOptimizedTitles(db, feedId, rawProducts)
  const filterRows = (filtersData ?? []) as FeedFilter[]
  const filtered = applyFeedFilters(rawProducts, filterRows, marketUrl)

  return { total: rawProducts.length, included: filtered.length }
}

// ── Main export ────────────────────────────────────────────────────────────

// PostgREST defaults to a 1000-row cap (Supabase's db-max-rows). For a feed
// that needs every active product, page through with .range() until exhausted.
// PAGE_SIZE = 1000 matches the server cap so each request returns the maximum.
async function fetchAllActiveProducts(
  db: ReturnType<typeof adminClient>,
  feedId: string
): Promise<SupabaseProduct[]> {
  const PAGE_SIZE = 1000
  const out: SupabaseProduct[] = []
  let from = 0
  while (true) {
    const { data, error } = await db
      .from('products')
      .select('*, metafields:product_metafields(*)')
      .eq('feed_id', feedId)
      .eq('status', 'active')
      // created_at alone is NOT stable across pages — bulk imports share a
      // timestamp, so offset pagination over the ties duplicates/skips rows at
      // page boundaries (duplicate <item>s in the feed). id is the tiebreaker.
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

export async function generateFeed(feedId: string): Promise<FeedResult> {
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
    fetchAllActiveProducts(db, feedId),
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

  const filterRows = (filtersData ?? []) as FeedFilter[]

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
    for (const product of products) {
      const lines: string[] = []

      // Auto-inject g:id from shopify_id. User mappings for id and
      // item_group_id are skipped: id is locked to shopify_id, and
      // item_group_id has no meaning in product mode (no variant grouping).
      if (product.shopify_id) {
        lines.push(xmlLine('id', String(product.shopify_id)))
      }

      for (const mapping of mappings) {
        if (mapping.google_field === 'id' || mapping.google_field === 'item_group_id') continue
        // An accepted AI title wins over the title mapping. Short-circuits the
        // mapping entirely, so an AI-type title mapping costs no API call.
        const aiTitle = mapping.google_field === 'title' ? aiTitleFor(product) : null
        const value = aiTitle ?? (await resolvedValue(mapping, product, anthropic, marketUrl))
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
        const vProduct = withVariantFirst(product, variant)

        // Apply mapping rules; id and item_group_id are always auto-computed
        const mappedLines: string[] = []
        const addedFields = new Set<string>()

        for (const mapping of mappings) {
          if (mapping.google_field === 'id' || mapping.google_field === 'item_group_id') continue
          // Same override as product mode. The AI title is product-level, so
          // every variant of the product carries it.
          const aiTitle = mapping.google_field === 'title' ? aiTitleFor(product) : null
          const value = aiTitle ?? (await resolvedValue(mapping, vProduct, anthropic, marketUrl))
          if (value !== '') {
            mappedLines.push(xmlLine(mapping.google_field, value))
            addedFields.add(mapping.google_field)
          }
        }

        // Bucket custom label applies to the product, so every variant carries it.
        const clLine = customLabelLine(product)
        if (clLine) mappedLines.push(clLine)

        // Always-inject: id and item_group_id
        const autoLines: string[] = [
          xmlLine('id', `${product.shopify_id}_${variant.id}`),
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

export async function generatePreview(feedId: string, limit = 100): Promise<PreviewData> {
  const db = adminClient()

  const [
    { data: settingsData },
    { data: shopSettingsData },
    { data: mappingsData },
    { data: productsData },
    { data: filtersData },
  ] = await Promise.all([
    db.from('feed_settings').select('feed_mode').eq('feed_id', feedId).maybeSingle(),
    db.from('shop_settings').select('market_url, selected_market_id, selected_locale').eq('feed_id', feedId).maybeSingle(),
    db.from('feed_mappings').select('google_field, mapping_type, config').eq('feed_id', feedId),
    db.from('products').select('*, metafields:product_metafields(*)').eq('feed_id', feedId).eq('status', 'active').order('created_at', { ascending: true }).order('id', { ascending: true }),
    db.from('feed_filters').select('filter_type, operator, rules').eq('feed_id', feedId),
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
  const rawProducts = (productsData ?? []) as SupabaseProduct[]
  const filterRows = (filtersData ?? []) as FeedFilter[]

  await attachOptimizedTitles(db, feedId, rawProducts)
  const filteredProducts = applyFeedFilters(rawProducts, filterRows, marketUrl)

  let googleFields: string[]
  const rows: PreviewRow[] = []

  if (feedMode === 'product') {
    googleFields = mappings.map((m) => m.google_field)

    for (const product of filteredProducts.slice(0, limit)) {
      const fields: Record<string, string> = {}
      for (const mapping of mappings) {
        // Mirror the generator's AI-title override, ahead of the '__AI__'
        // placeholder — otherwise a preview of an AI-mapped title would show a
        // placeholder where the feed emits a real optimized title.
        const aiTitle = mapping.google_field === 'title' ? aiTitleFor(product) : null
        if (aiTitle) {
          fields[mapping.google_field] = aiTitle
          continue
        }
        if (mapping.mapping_type === 'AI') {
          fields[mapping.google_field] = '__AI__'
          continue
        }
        fields[mapping.google_field] = await resolvedValue(mapping, product, null, marketUrl)
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
        const vProduct = withVariantFirst(product, variant)
        const fields: Record<string, string> = {}

        fields['id'] = `${product.shopify_id}_${variant.id}`
        fields['item_group_id'] = product.shopify_id
        const suffix = variant.title && variant.title !== 'Default Title' ? ` - ${variant.title}` : ''
        fields['title'] = `${aiTitleFor(product) ?? product.title ?? ''}${suffix}`.trim()
        fields['availability'] = (variant.inventory_quantity ?? 0) > 0 ? 'in_stock' : 'out_of_stock'

        for (const mapping of mappings) {
          if (['id', 'item_group_id'].includes(mapping.google_field)) continue
          const aiTitle = mapping.google_field === 'title' ? aiTitleFor(product) : null
          if (aiTitle) {
            fields[mapping.google_field] = aiTitle
            continue
          }
          if (mapping.mapping_type === 'AI') {
            fields[mapping.google_field] = '__AI__'
            continue
          }
          const value = await resolvedValue(mapping, vProduct, null, marketUrl)
          if (value !== '') fields[mapping.google_field] = value
        }

        rows.push({
          productId: `${product.shopify_id}_${variant.id}`,
          title: fields['title'] || product.title || product.shopify_id,
          fields,
        })
      }
    }
  }

  return { feedMode, rows, googleFields, totalProducts: filteredProducts.length }
}
