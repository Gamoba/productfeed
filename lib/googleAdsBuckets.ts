import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError, AppError } from '@/lib/errors'
import { buildItemId, type IdPattern } from '@/lib/googleAdsIds'
import { getFeedSettings, type GoogleAdsFeedSettings } from '@/lib/feedGoogleAds'
import { getProductMargins, vatBasis } from '@/lib/variantCosts'
import { getStockForFeed, type StockRow } from '@/lib/inventoryAnalytics'
import {
  derive,
  windowRange,
  type Derived,
  type ProductRow,
  type VariantRow,
} from '@/lib/googleAdsAnalytics'

// ── Rule model ───────────────────────────────────────────────────────────────

export const BUCKET_METRICS = [
  'roas',
  'poas',
  'conversions',
  'roas_conversions',
  'poas_conversions',
  'conversions_value',
  'cost',
  'clicks',
  'impressions',
  'profit_after_ad_spend',
  'cogs_margin',
  'inventory_quantity',
  'stock_coverage',
  'days_of_stock',
] as const
export type BucketMetric = (typeof BUCKET_METRICS)[number]

export const BUCKET_OPERATORS = [
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'neq',
  'is_empty',
  'is_not_empty',
] as const
export type BucketOperator = (typeof BUCKET_OPERATORS)[number]

export type BucketRule = {
  metric: BucketMetric
  operator: BucketOperator
  value?: number
  windowDays?: number
}

export type BucketLevel = 'product' | 'variant'

/** One of Google's five custom_label_N slots, and everything it measures with. */
export type CustomLabel = {
  id: string
  feed_id: string
  name: string
  slot: number | null
  level: BucketLevel
  window_days: number
  emit_to_feed: boolean
  description: string | null
  computed_at: string | null
}

const LABEL_COLUMNS =
  'id, feed_id, name, slot, level, window_days, emit_to_feed, description, computed_at'

/** One value within a dimension. */
export type Bucket = {
  id: string
  feed_id: string
  label_id: string
  name: string
  value: string
  priority: number
  match_type: 'ALL' | 'ANY'
  rules: BucketRule[]
  is_fallback: boolean
  description: string | null
}

const BUCKET_COLUMNS =
  'id, feed_id, label_id, name, value, priority, match_type, rules, is_fallback, description'

// ── Evaluation ───────────────────────────────────────────────────────────────

/** One thing a rule can be applied to: a product, or a Merchant Center item. */
export type BucketEntity = {
  ref: string
  productRef: string | null
  title: string | null
  hasData: boolean
  tracked: { roas: boolean; poas: boolean }
  cogsMargin: number | null
  stock: {
    quantity: number | null
    coverage: number | null
    daysOfStock: number | null
  }
  metrics: Derived & {
    cost: number
    clicks: number
    impressions: number
    conversions: number
    conversions_value: number
    roas_conversions: number
    roas_value: number
    poas_conversions: number
    poas_value: number
  }
}

function metricValue(e: BucketEntity, metric: BucketMetric): number | null {
  switch (metric) {
    case 'roas':
      return e.tracked.roas ? e.metrics.roas : null
    case 'poas':
      return e.tracked.poas ? e.metrics.poas : null
    case 'profit_after_ad_spend':
      return e.metrics.profitAfterAdSpend // derive() already returns null when untracked
    case 'roas_conversions':
      return e.tracked.roas ? e.metrics.roas_conversions : null
    case 'poas_conversions':
      return e.tracked.poas ? e.metrics.poas_conversions : null
    case 'conversions_value':
      return e.tracked.roas ? e.metrics.roas_value : null
    case 'conversions':
      return e.metrics.conversions
    case 'cost':
      return e.metrics.cost
    case 'clicks':
      return e.metrics.clicks
    case 'impressions':
      return e.metrics.impressions
    case 'cogs_margin':
      return e.cogsMargin
    case 'inventory_quantity':
      return e.stock.quantity
    case 'stock_coverage':
      return e.stock.coverage
    case 'days_of_stock':
      return e.stock.daysOfStock
  }
}

export function evaluateRule(entity: BucketEntity, rule: BucketRule): boolean {
  const v = metricValue(entity, rule.metric)

  if (rule.operator === 'is_empty') return v === null
  if (rule.operator === 'is_not_empty') return v !== null

  // The load-bearing line: an absent measurement is not a low one.
  if (v === null) return false

  const target = Number(rule.value)
  if (!Number.isFinite(target)) return false

  switch (rule.operator) {
    case 'gt':
      return v > target
    case 'gte':
      return v >= target
    case 'lt':
      return v < target
    case 'lte':
      return v <= target
    case 'eq':
      return v === target
    case 'neq':
      return v !== target
    default:
      return false
  }
}

function isUsable(rule: BucketRule): boolean {
  if (!BUCKET_METRICS.includes(rule.metric)) return false
  if (!BUCKET_OPERATORS.includes(rule.operator)) return false
  if (rule.operator === 'is_empty' || rule.operator === 'is_not_empty') return true
  return Number.isFinite(Number(rule.value))
}

export function matchesBucket(entity: BucketEntity, bucket: Bucket): boolean {
  if (bucket.is_fallback) return true

  const rules = (bucket.rules ?? []).filter(isUsable)
  if (!rules.length) return false

  return bucket.match_type === 'ANY'
    ? rules.some((r) => evaluateRule(entity, r))
    : rules.every((r) => evaluateRule(entity, r))
}

/** One label's buckets in evaluation order: by priority, fallback always last. */
export function orderBuckets(buckets: Bucket[]): Bucket[] {
  return [...buckets].sort((a, b) => {
    if (a.is_fallback !== b.is_fallback) return a.is_fallback ? 1 : -1
    return a.priority - b.priority || a.name.localeCompare(b.name, 'en')
  })
}

/**
 * Labels in display order: by slot, drafts last.
 *
 * Slot order rather than creation order, because the slot is what anyone
 * reading a Merchant Center export will be looking at.
 */
export function orderLabels(labels: CustomLabel[]): CustomLabel[] {
  return [...labels].sort((a, b) => {
    if ((a.slot === null) !== (b.slot === null)) return a.slot === null ? 1 : -1
    if (a.slot !== null && b.slot !== null && a.slot !== b.slot) return a.slot - b.slot
    return a.name.localeCompare(b.name, 'en')
  })
}

/** ref → bucket id, for ONE label's buckets. */
export function assign(entities: BucketEntity[], buckets: Bucket[]): Map<string, string> {
  const ordered = orderBuckets(buckets)
  const out = new Map<string, string>()
  for (const e of entities) {
    const hit = ordered.find((b) => matchesBucket(e, b))
    if (hit) out.set(e.ref, hit.id)
  }
  return out
}

// ── Labels ───────────────────────────────────────────────────────────────────

export async function listLabels(db: SupabaseClient, feedId: string): Promise<CustomLabel[]> {
  const { data, error } = await db
    .from('google_ads_custom_labels')
    .select(LABEL_COLUMNS)
    .eq('feed_id', feedId)
  if (error) dbError('listLabels', error)
  return orderLabels((data ?? []) as unknown as CustomLabel[])
}

export async function getLabel(
  db: SupabaseClient,
  feedId: string,
  labelId: string
): Promise<CustomLabel | null> {
  const { data, error } = await db
    .from('google_ads_custom_labels')
    .select(LABEL_COLUMNS)
    .eq('feed_id', feedId)
    .eq('id', labelId)
    .maybeSingle()
  if (error) dbError('getLabel', error)
  return (data as unknown as CustomLabel | null) ?? null
}

export async function saveLabel(
  db: SupabaseClient,
  feedId: string,
  label: Partial<CustomLabel> & { id?: string }
): Promise<CustomLabel> {
  const row: Record<string, unknown> = { feed_id: feedId, updated_at: new Date().toISOString() }
  for (const k of [
    'name',
    'slot',
    'level',
    'window_days',
    'emit_to_feed',
    'description',
  ] as const) {
    if (label[k] !== undefined) row[k] = label[k]
  }

  const q = label.id
    ? db.from('google_ads_custom_labels').update(row).eq('id', label.id).eq('feed_id', feedId)
    : db.from('google_ads_custom_labels').insert(row)

  const { data, error } = await q.select(LABEL_COLUMNS).single()
  if (error) {
    if (error.message.includes('one_per_slot')) {
      throw new AppError(
        'Another custom label already uses that slot. A slot holds one value per product, so two labels cannot share it.'
      )
    }
    if (error.message.includes('google_ads_custom_labels_feed_id_name_key')) {
      throw new AppError('A custom label with that name already exists.')
    }
    dbError('saveLabel', error)
  }
  return data as unknown as CustomLabel
}

/** Deletes the label, and with it (ON DELETE CASCADE) its buckets and members. */
export async function deleteLabel(
  db: SupabaseClient,
  feedId: string,
  labelId: string
): Promise<void> {
  const { error } = await db
    .from('google_ads_custom_labels')
    .delete()
    .eq('id', labelId)
    .eq('feed_id', feedId)
  if (error) dbError('deleteLabel', error)
}

// ── Buckets ──────────────────────────────────────────────────────────────────

/** Every bucket on the feed, or just one label's, in evaluation order. */
export async function listBuckets(
  db: SupabaseClient,
  feedId: string,
  labelId?: string
): Promise<Bucket[]> {
  let q = db.from('google_ads_buckets').select(BUCKET_COLUMNS).eq('feed_id', feedId)
  if (labelId) q = q.eq('label_id', labelId)
  const { data, error } = await q
  if (error) dbError('listBuckets', error)
  return orderBuckets((data ?? []) as unknown as Bucket[])
}

export async function saveBucket(
  db: SupabaseClient,
  feedId: string,
  bucket: Partial<Bucket> & { id?: string }
): Promise<Bucket> {
  if (!bucket.id && !bucket.label_id) {
    throw new AppError('A bucket must belong to a custom label.')
  }

  const row: Record<string, unknown> = { feed_id: feedId, updated_at: new Date().toISOString() }
  for (const k of [
    'label_id',
    'name',
    'value',
    'priority',
    'match_type',
    'rules',
    'is_fallback',
    'description',
  ] as const) {
    if (bucket[k] !== undefined) row[k] = bucket[k]
  }

  const q = bucket.id
    ? db.from('google_ads_buckets').update(row).eq('id', bucket.id).eq('feed_id', feedId)
    : db.from('google_ads_buckets').insert(row)

  const { data, error } = await q.select(BUCKET_COLUMNS).single()
  if (error) {
    if (error.message.includes('one_fallback')) {
      throw new AppError('This custom label already has a catch-all bucket.')
    }
    if (error.message.includes('google_ads_buckets_label_id_name_key')) {
      throw new AppError('A bucket with that name already exists in this custom label.')
    }
    if (error.message.includes('google_ads_buckets_value_chk')) {
      throw new AppError('A bucket needs a value — that is the text Google would receive.')
    }
    dbError('saveBucket', error)
  }
  return data as unknown as Bucket
}

export async function deleteBucket(
  db: SupabaseClient,
  feedId: string,
  bucketId: string
): Promise<void> {
  const { error } = await db
    .from('google_ads_buckets')
    .delete()
    .eq('id', bucketId)
    .eq('feed_id', feedId)
  if (error) dbError('deleteBucket', error)
}

// ── Entity assembly ──────────────────────────────────────────────────────────

type CatalogueProduct = {
  shopify_id: string
  title: string | null
  variants?: { id?: unknown }[] | null
}

type EntitySet = { entities: BucketEntity[]; unmatchedCost: number }

async function buildEntities(
  db: SupabaseClient,
  feedId: string,
  settings: GoogleAdsFeedSettings,
  level: BucketLevel,
  windowDays: number
): Promise<EntitySet> {
  const { from, to } = windowRange(windowDays)
  const actions = {
    p_roas_actions: settings.roas_conversion_actions ?? [],
    p_poas_actions: settings.poas_conversion_actions ?? [],
  }
  const tracked = {
    roas: actions.p_roas_actions.length > 0,
    poas: actions.p_poas_actions.length > 0,
  }

  const margins = await getProductMargins(db, feedId, vatBasis(settings))

  const stock = await getStockForFeed(db, feedId)

  const NO_STOCK = { quantity: null, coverage: null, daysOfStock: null }
  const stockFor = (row: StockRow | undefined): BucketEntity['stock'] =>
    row
      ? { quantity: row.quantity, coverage: row.stockCoverage, daysOfStock: row.daysOfStock }
      : NO_STOCK

  const byRef = new Map<string, BucketEntity>()
  let unmatchedCost = 0

  const toEntity = (
    ref: string,
    productRef: string | null,
    title: string | null,
    row: Partial<BucketEntity['metrics']>,
    hasData: boolean,
    variantRef: string | null = null
  ): BucketEntity => {
    const raw = {
      impressions: Number(row.impressions ?? 0),
      clicks: Number(row.clicks ?? 0),
      cost: Number(row.cost ?? 0),
      conversions: Number(row.conversions ?? 0),
      conversions_value: Number(row.conversions_value ?? 0),
      roas_conversions: Number(row.roas_conversions ?? 0),
      roas_value: Number(row.roas_value ?? 0),
      poas_conversions: Number(row.poas_conversions ?? 0),
      poas_value: Number(row.poas_value ?? 0),
    }
    return {
      ref,
      productRef,
      title,
      hasData,
      tracked,
      cogsMargin: productRef ? (margins.get(productRef)?.margin ?? null) : null,
      stock: stockFor(
        variantRef
          ? stock.byVariant.get(variantRef)
          : productRef
            ? stock.byProduct.get(productRef)
            : undefined
      ),
      metrics: { ...raw, ...derive(raw, tracked.poas) },
    }
  }

  if (level === 'product') {
    const { data, error } = await db.rpc('google_ads_product_summary', {
      p_feed_id: feedId,
      p_from: from,
      p_to: to,
      ...actions,
    })
    if (error) dbError('buildEntities/product', error)
    for (const r of (data ?? []) as unknown as ProductRow[] & Record<string, unknown>[]) {
      const ref = (r.product_ref as string | null) ?? null
      if (!ref) {
        unmatchedCost += Number((r as Record<string, unknown>).cost ?? 0)
        continue
      }
      byRef.set(ref, toEntity(ref, ref, (r.title as string | null) ?? null, r as never, true))
    }
  } else {
    const { data, error } = await db.rpc('google_ads_variant_summary', {
      p_feed_id: feedId,
      p_from: from,
      p_to: to,
      p_product_ref: null,
      ...actions,
    })
    if (error) dbError('buildEntities/variant', error)
    for (const r of (data ?? []) as unknown as VariantRow[] & Record<string, unknown>[]) {
      const ref = String(r.item_id ?? '')
      if (!ref) continue
      byRef.set(
        ref,
        toEntity(
          ref,
          (r.product_ref as string | null) ?? null,
          (r.product_title as string | null) ?? null,
          r as never,
          true,
          (r.variant_ref as string | null) ?? null
        )
      )
    }
  }

  // ── Fill in the catalogue ──
  const products: CatalogueProduct[] = []
  const PAGE = 1000
  const columns = level === 'variant' ? 'shopify_id, title, variants' : 'shopify_id, title'
  for (let page = 0; ; page++) {
    const { data, error } = await db
      .from('products')
      .select(columns)
      .or('status.is.null,status.eq.active')
      .eq('feed_id', feedId)
      .order('shopify_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) dbError('buildEntities/catalogue', error)
    const rows = (data ?? []) as unknown as CatalogueProduct[]
    products.push(...rows)
    if (rows.length < PAGE) break
  }

  if (level === 'product') {
    for (const p of products) {
      if (!p.shopify_id || byRef.has(p.shopify_id)) continue
      byRef.set(p.shopify_id, toEntity(p.shopify_id, p.shopify_id, p.title, {}, false))
    }
  } else {
    const pattern = (settings.id_pattern === 'auto' ? null : settings.id_pattern) as IdPattern | null
    if (pattern) {
      for (const p of products) {
        for (const v of p.variants ?? []) {
          if (v?.id == null) continue
          const ref = buildItemId(pattern, p.shopify_id, String(v.id), settings.id_pattern_country)
          if (!ref || byRef.has(ref)) continue
          byRef.set(ref, toEntity(ref, p.shopify_id, p.title, {}, false, String(v.id)))
        }
      }
    }
  }

  return { entities: [...byRef.values()], unmatchedCost }
}

/**
 * Builds each distinct (level, window) combination once and shares it.
 *
 * Two labels both measuring products over 30 days are asking the same question
 * of the same data, and the build is the expensive part of a recompute — the
 * summary RPC plus the whole catalogue plus every margin. Caching the PROMISE
 * rather than the result also collapses concurrent requests for the same key.
 */
function entityBuilder(db: SupabaseClient, feedId: string, settings: GoogleAdsFeedSettings) {
  const cache = new Map<string, Promise<EntitySet>>()
  return (level: BucketLevel, windowDays: number): Promise<EntitySet> => {
    const key = `${level}:${windowDays}`
    let hit = cache.get(key)
    if (!hit) {
      hit = buildEntities(db, feedId, settings, level, windowDays)
      cache.set(key, hit)
    }
    return hit
  }
}

// ── Recompute ────────────────────────────────────────────────────────────────

export type LabelResult = {
  labelId: string
  name: string
  slot: number | null
  level: BucketLevel
  windowDays: number
  entities: number
  withData: number
  assigned: number
  unlabelled: number
  moved: number
  perBucket: { id: string; name: string; value: string; count: number }[]
  warnings: string[]
}

export type RecomputeResult = {
  labels: LabelResult[]
  warnings: string[]
}

/** Conversion-action problems, which apply to every label equally. */
function feedWarnings(settings: GoogleAdsFeedSettings): string[] {
  const warnings: string[] = []
  const roasActions = settings.roas_conversion_actions ?? []
  const poasActions = settings.poas_conversion_actions ?? []

  if (!roasActions.length) {
    warnings.push(
      'No revenue conversion action selected, so ROAS, revenue and revenue-based conversion ' +
        'counts have no value and every rule using them fails to match.'
    )
  }
  if (!poasActions.length) {
    warnings.push(
      'No gross profit conversion action selected, so POAS, profit − cost and profit-based ' +
        'conversion counts have no value and every rule using them fails to match.'
    )
  }

  const shared = roasActions.filter((a) => poasActions.includes(a))
  if (shared.length && shared.length === roasActions.length && shared.length === poasActions.length) {
    warnings.push('Revenue and gross profit use the same conversion actions, so POAS equals ROAS.')
  } else if (shared.length) {
    warnings.push(
      `${shared.length} conversion action${shared.length === 1 ? '' : 's'} count towards both revenue and gross profit.`
    )
  }

  return warnings
}

async function recomputeOne(
  db: SupabaseClient,
  feedId: string,
  settings: GoogleAdsFeedSettings,
  label: CustomLabel,
  buckets: Bucket[],
  build: ReturnType<typeof entityBuilder>,
  previous: Map<string, string>
): Promise<LabelResult> {
  const warnings: string[] = []
  const level = label.level
  const windowDays = label.window_days

  const synced = settings.sync_window_days ?? 90
  if (windowDays > synced) {
    warnings.push(
      `The window is ${windowDays} days but only the last ${synced} days have been synced, ` +
        `so rules are effectively evaluated over ${synced} days.`
    )
  }

  if (!buckets.length) {
    warnings.push('This label has no buckets, so no product carries a value for it.')
  }

  if (level === 'variant' && settings.id_pattern === 'auto') {
    warnings.push(
      'The item ID format is not confirmed yet, so variants without traffic are excluded.'
    )
  }

  const { entities, unmatchedCost } = await build(level, windowDays)

  if (unmatchedCost > 0) {
    const spend = unmatchedCost.toLocaleString('da-DK', { maximumFractionDigits: 0 })
    warnings.push(
      `${spend} ${settings.currency_code ?? ''}`.trim() +
        ' of ad spend is on item IDs that could not be matched to a product, and is not labelled.'
    )
  }

  const assignment = assign(entities, buckets)

  const now = new Date().toISOString()
  const members = entities
    .filter((e) => assignment.has(e.ref))
    .map((e) => ({
      bucket_id: assignment.get(e.ref)!,
      ref: e.ref,
      product_ref: e.productRef,
    }))

  const { data: inserted, error: replaceErr } = await db.rpc('google_ads_replace_label_members', {
    p_feed_id: feedId,
    p_label_id: label.id,
    p_level: level,
    p_members: members,
    p_computed_at: now,
  })
  if (replaceErr) dbError('recomputeOne/replace', replaceErr)

  const perBucket = orderBuckets(buckets).map((b) => ({
    id: b.id,
    name: b.name,
    value: b.value,
    count: [...assignment.values()].filter((v) => v === b.id).length,
  }))

  let moved = 0
  for (const [ref, bucketId] of assignment) {
    if (previous.get(ref) !== bucketId) moved++
  }

  const assigned = Number(inserted ?? assignment.size)

  return {
    labelId: label.id,
    name: label.name,
    slot: label.slot,
    level,
    windowDays,
    entities: entities.length,
    withData: entities.filter((e) => e.hasData).length,
    assigned,
    unlabelled: entities.length - assigned,
    moved,
    perBucket,
    warnings,
  }
}

/** Previous membership per label, read BEFORE any rewrite, for "what changed". */
async function previousMembership(
  db: SupabaseClient,
  feedId: string
): Promise<Map<string, Map<string, string>>> {
  const { data } = await db
    .from('google_ads_bucket_members')
    .select('label_id, ref, bucket_id')
    .eq('feed_id', feedId)

  const out = new Map<string, Map<string, string>>()
  for (const r of (data ?? []) as { label_id: string; ref: string; bucket_id: string }[]) {
    let m = out.get(r.label_id)
    if (!m) out.set(r.label_id, (m = new Map()))
    m.set(r.ref, r.bucket_id)
  }
  return out
}

/**
 * Recompute every label on the feed.
 *
 * Each label is replaced in its own transaction, on purpose: they are
 * independent analyses, so if the third of five fails the first two are whole
 * and correctly stamped — more useful than rolling all five back, and far
 * better than leaving one half-written.
 */
export async function recomputeFeed(
  db: SupabaseClient,
  feedId: string
): Promise<RecomputeResult> {
  const settings = await getFeedSettings(db, feedId)
  if (!settings) throw new AppError('Google Ads is not set up for this feed.')

  const labels = await listLabels(db, feedId)
  const allBuckets = await listBuckets(db, feedId)
  const previous = await previousMembership(db, feedId)
  const build = entityBuilder(db, feedId, settings)

  const results: LabelResult[] = []
  for (const label of labels) {
    results.push(
      await recomputeOne(
        db,
        feedId,
        settings,
        label,
        allBuckets.filter((b) => b.label_id === label.id),
        build,
        previous.get(label.id) ?? new Map()
      )
    )
  }

  return { labels: results, warnings: feedWarnings(settings) }
}

/** Recompute a single dimension, leaving the others exactly as they were. */
export async function recomputeLabel(
  db: SupabaseClient,
  feedId: string,
  labelId: string
): Promise<RecomputeResult> {
  const settings = await getFeedSettings(db, feedId)
  if (!settings) throw new AppError('Google Ads is not set up for this feed.')

  const label = await getLabel(db, feedId, labelId)
  if (!label) throw new AppError('That custom label does not exist on this feed.')

  const previous = await previousMembership(db, feedId)
  const result = await recomputeOne(
    db,
    feedId,
    settings,
    label,
    await listBuckets(db, feedId, labelId),
    entityBuilder(db, feedId, settings),
    previous.get(labelId) ?? new Map()
  )

  return { labels: [result], warnings: feedWarnings(settings) }
}

// ── No starter set ───────────────────────────────────────────────────────────
//
// There was a starterLabel() here: one "Performance" dimension with six values
// and thresholds picked by a developer. It was removed at the operator's
// request. The thresholds are a commercial judgement — 25 clicks before you can
// judge a product, POAS 2 to call something a hero — and offering a guess as a
// "suggested set" is how a guess becomes the default nobody revisits.
//
// Templates are coming from the person who runs the accounts. They will be
// several named options rather than one hardcoded dimension, so the shape here
// will be a registry, not a single function. The UI keeps a disabled "Use
// suggested set" button as the placeholder for it.
// ─────────────────────────────────────────────────────────────────────────────
